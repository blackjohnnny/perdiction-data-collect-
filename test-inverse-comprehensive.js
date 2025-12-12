import { initDatabase } from './db-init.js';

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0,
};

function calculateFlipRate(rounds, currentIndex, lookback) {
  const startIdx = Math.max(0, currentIndex - lookback);
  const recentRounds = rounds.slice(startIdx, currentIndex + 1);

  if (recentRounds.length < 3) return null;

  let emaFlips = 0;
  let prevSignal = null;
  for (const r of recentRounds) {
    const signal = r.ema_signal;
    if (signal && signal !== 'NEUTRAL') {
      if (prevSignal && signal !== prevSignal) emaFlips++;
      prevSignal = signal;
    }
  }

  return emaFlips / recentRounds.length;
}

function runStrategy(rounds, config) {
  const {
    lookback = 12,
    choppyThreshold = 0.20,
    useInverse = false,
    debug = false
  } = config;

  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let wins = 0, losses = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;

  let choppyWins = 0, choppyLosses = 0;
  let trendingWins = 0, trendingLosses = 0;
  let inversedCount = 0;

  const tradeLog = [];

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const flipRate = calculateFlipRate(rounds, i, lookback);
    if (flipRate === null) continue;

    // Detect choppy market
    const isChoppy = flipRate > choppyThreshold;

    const t20sBull = parseFloat(r.t20s_bull_wei || 0) / 1e18;
    const t20sBear = parseFloat(r.t20s_bear_wei || 0) / 1e18;
    const t20sTotal = t20sBull + t20sBear;
    if (t20sTotal === 0) continue;

    const bullPayout = (t20sTotal * 0.97) / t20sBull;
    const bearPayout = (t20sTotal * 0.97) / t20sBear;

    // CONTRARIAN STRATEGY
    let signal = null;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      signal = 'BULL';
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      signal = 'BEAR';
    }

    if (!signal) continue;

    // INVERSE LOGIC
    let finalSignal = signal;
    let wasInversed = false;
    if (useInverse && isChoppy) {
      finalSignal = signal === 'BULL' ? 'BEAR' : 'BULL';
      wasInversed = true;
      inversedCount++;
    }

    // Position sizing
    let sizeMultiplier = 1.0;
    const emaGap = parseFloat(r.ema_gap) || 0;
    if (Math.abs(emaGap) >= 0.15) sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betAmount = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    const winner = r.winner ? r.winner.toLowerCase() : '';
    const won = (finalSignal === 'BULL' && winner === 'bull') || (finalSignal === 'BEAR' && winner === 'bear');

    const prevBankroll = bankroll;

    if (won) {
      const actualPayout = parseFloat(r.winner_payout_multiple);
      const profit = betAmount * (actualPayout - 1);
      bankroll += profit;
      wins++;
      if (isChoppy) choppyWins++;
      else trendingWins++;
    } else {
      bankroll -= betAmount;
      losses++;
      if (isChoppy) choppyLosses++;
      else trendingLosses++;
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    if (debug) {
      tradeLog.push({
        epoch: r.epoch,
        flipRate: (flipRate * 100).toFixed(0) + '%',
        isChoppy,
        originalSignal: signal,
        finalSignal,
        wasInversed,
        winner,
        won,
        bankroll: bankroll.toFixed(2),
        betAmount: betAmount.toFixed(3),
        sizeMultiplier: sizeMultiplier.toFixed(2)
      });
    }
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const roi = ((bankroll - BASE_CONFIG.STARTING_BANKROLL) / BASE_CONFIG.STARTING_BANKROLL) * 100;

  const choppyTotal = choppyWins + choppyLosses;
  const choppyWR = choppyTotal > 0 ? (choppyWins / choppyTotal * 100) : 0;
  const trendingTotal = trendingWins + trendingLosses;
  const trendingWR = trendingTotal > 0 ? (trendingWins / trendingTotal * 100) : 0;

  return {
    roi, winRate, trades: totalTrades, wins, losses, maxDrawdown, bankroll, peak,
    choppyWR, choppyTrades: choppyTotal, choppyWins, choppyLosses,
    trendingWR, trendingTrades: trendingTotal, trendingWins, trendingLosses,
    inversedCount, tradeLog
  };
}

console.log('🔬 COMPREHENSIVE INVERSE STRATEGY ANALYSIS\n');
console.log('═'.repeat(120));

const db = initDatabase('./prediction.db');
const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`\n📊 Total rounds: ${rounds.length}\n`);
console.log('═'.repeat(120));

// PART 1: Test different choppy thresholds
console.log('\n📊 PART 1: TESTING DIFFERENT CHOPPY THRESHOLDS\n');
console.log('─'.repeat(120));

const thresholds = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40];
const lookbacks = [6, 8, 10, 12, 15, 18];

console.log('Configuration                              │ Win Rate │   ROI    │  Peak  │ Final  │ MaxDD  │ Choppy WR │ Inversed');
console.log('─'.repeat(120));

const results = [];

// Baseline
const baseline = runStrategy(rounds, { useInverse: false, lookback: 12 });
results.push({ name: 'BASELINE (No Inverse)', ...baseline });
console.log(`${'BASELINE (No Inverse)'.padEnd(42)} │ ${baseline.winRate.toFixed(1)}%`.padStart(9) + ' │ ' +
  `${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(0)}%`.padStart(8) + ' │ ' +
  `${baseline.peak.toFixed(2)}`.padStart(6) + ' │ ' +
  `${baseline.bankroll.toFixed(2)}`.padStart(6) + ' │ ' +
  `${baseline.maxDrawdown.toFixed(1)}%`.padStart(6) + ' │ ' +
  '    -    ' + ' │ ' + '    -   '
);

// Test all combinations
for (const lookback of lookbacks) {
  for (const threshold of thresholds) {
    const noInverse = runStrategy(rounds, { useInverse: false, lookback, choppyThreshold: threshold });
    const withInverse = runStrategy(rounds, { useInverse: true, lookback, choppyThreshold: threshold });

    const name = `FlipRate>${(threshold*100).toFixed(0)}% (${lookback}r)`;
    results.push({ name: name + ' NO INV', ...noInverse });
    results.push({ name: name + ' INVERSE', ...withInverse });

    // Only print inverse results to save space
    console.log(`${name.padEnd(42)} │ ${withInverse.winRate.toFixed(1)}%`.padStart(9) + ' │ ' +
      `${withInverse.roi >= 0 ? '+' : ''}${withInverse.roi.toFixed(0)}%`.padStart(8) + ' │ ' +
      `${withInverse.peak.toFixed(2)}`.padStart(6) + ' │ ' +
      `${withInverse.bankroll.toFixed(2)}`.padStart(6) + ' │ ' +
      `${withInverse.maxDrawdown.toFixed(1)}%`.padStart(6) + ' │ ' +
      `${withInverse.choppyWR.toFixed(1)}%`.padStart(9) + ' │ ' +
      `${withInverse.inversedCount}`.padStart(8)
    );
  }
}

// PART 2: Top performers
console.log('\n' + '═'.repeat(120));
console.log('\n🏆 TOP 15 BY WIN RATE\n');
console.log('─'.repeat(120));

const topByWR = results.sort((a, b) => b.winRate - a.winRate).slice(0, 15);

console.log('Rank │ Strategy                                   │ Win Rate │   ROI    │  Peak  │ Final  │ MaxDD');
console.log('─'.repeat(120));

for (let i = 0; i < topByWR.length; i++) {
  const r = topByWR[i];
  const rank = String(i + 1).padStart(2);
  const name = r.name.padEnd(42);
  const wr = `${r.winRate.toFixed(1)}%`.padStart(8);
  const roi = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(0)}%`.padStart(8);
  const peak = `${r.peak.toFixed(2)}`.padStart(6);
  const final = `${r.bankroll.toFixed(2)}`.padStart(6);
  const dd = `${r.maxDrawdown.toFixed(1)}%`.padStart(5);

  console.log(`${rank}   │ ${name} │ ${wr} │ ${roi} │ ${peak} │ ${final} │ ${dd}`);
}

console.log('\n' + '═'.repeat(120));
console.log('\n🏆 TOP 15 BY ROI\n');
console.log('─'.repeat(120));

const topByROI = results.sort((a, b) => b.roi - a.roi).slice(0, 15);

console.log('Rank │ Strategy                                   │   ROI    │ Win Rate │  Peak  │ Final  │ MaxDD');
console.log('─'.repeat(120));

for (let i = 0; i < topByROI.length; i++) {
  const r = topByROI[i];
  const rank = String(i + 1).padStart(2);
  const name = r.name.padEnd(42);
  const roi = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(0)}%`.padStart(8);
  const wr = `${r.winRate.toFixed(1)}%`.padStart(8);
  const peak = `${r.peak.toFixed(2)}`.padStart(6);
  const final = `${r.bankroll.toFixed(2)}`.padStart(6);
  const dd = `${r.maxDrawdown.toFixed(1)}%`.padStart(5);

  console.log(`${rank}   │ ${name} │ ${roi} │ ${wr} │ ${peak} │ ${final} │ ${dd}`);
}

// PART 3: Best overall recommendation
console.log('\n' + '═'.repeat(120));
console.log('\n🎯 FINAL RECOMMENDATION:\n');
console.log('─'.repeat(120));

const bestWR = topByWR[0];
const bestROI = topByROI[0];

console.log('\n🥇 BEST WIN RATE:\n');
console.log(`   ${bestWR.name}`);
console.log(`   Win Rate: ${bestWR.winRate.toFixed(1)}% (${bestWR.wins}W / ${bestWR.losses}L)`);
console.log(`   ROI: ${bestWR.roi >= 0 ? '+' : ''}${bestWR.roi.toFixed(1)}%`);
console.log(`   Peak: ${bestWR.peak.toFixed(2)} BNB | Final: ${bestWR.bankroll.toFixed(2)} BNB`);
console.log(`   Max Drawdown: ${bestWR.maxDrawdown.toFixed(1)}%`);
console.log(`   Choppy: ${bestWR.choppyWR.toFixed(1)}% WR (${bestWR.choppyTrades} trades)`);
console.log(`   Trending: ${bestWR.trendingWR.toFixed(1)}% WR (${bestWR.trendingTrades} trades)`);
if (bestWR.inversedCount) console.log(`   Inversed: ${bestWR.inversedCount} trades`);

console.log('\n🥇 BEST ROI:\n');
console.log(`   ${bestROI.name}`);
console.log(`   ROI: ${bestROI.roi >= 0 ? '+' : ''}${bestROI.roi.toFixed(1)}%`);
console.log(`   Win Rate: ${bestROI.winRate.toFixed(1)}% (${bestROI.wins}W / ${bestROI.losses}L)`);
console.log(`   Peak: ${bestROI.peak.toFixed(2)} BNB | Final: ${bestROI.bankroll.toFixed(2)} BNB`);
console.log(`   Max Drawdown: ${bestROI.maxDrawdown.toFixed(1)}%`);
console.log(`   Choppy: ${bestROI.choppyWR.toFixed(1)}% WR (${bestROI.choppyTrades} trades)`);
console.log(`   Trending: ${bestROI.trendingWR.toFixed(1)}% WR (${bestROI.trendingTrades} trades)`);
if (bestROI.inversedCount) console.log(`   Inversed: ${bestROI.inversedCount} trades`);

console.log('\n' + '═'.repeat(120));
console.log('\n💡 KEY INSIGHTS:\n');

console.log(`   Baseline: ${baseline.winRate.toFixed(1)}% WR, ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(0)}% ROI`);
console.log(`   Best WR:  ${bestWR.winRate.toFixed(1)}% WR (${bestWR.winRate - baseline.winRate >= 0 ? '+' : ''}${(bestWR.winRate - baseline.winRate).toFixed(1)}% improvement)`);
console.log(`   Best ROI: ${bestROI.roi >= 0 ? '+' : ''}${bestROI.roi.toFixed(0)}% ROI (${bestROI.roi - baseline.roi >= 0 ? '+' : ''}${(bestROI.roi - baseline.roi).toFixed(0)}% improvement)`);

console.log('\n' + '═'.repeat(120));

db.close();
