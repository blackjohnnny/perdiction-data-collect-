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
    useCircuitBreaker = false,
    useInverseDuringCooldown = false,
    cooldownStrategy = 'skip' // 'skip', 'inverse', 'consensus'
  } = config;

  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let wins = 0, losses = 0, skipped = 0;
  let consecutiveLosses = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;
  let cooldownUntilTimestamp = 0;
  let cbTriggered = 0;

  let cooldownTrades = 0;
  let cooldownWins = 0;
  let cooldownLosses = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const inCooldown = useCircuitBreaker && r.lock_timestamp < cooldownUntilTimestamp;

    // If in cooldown and strategy is 'skip', skip the trade
    if (inCooldown && cooldownStrategy === 'skip') {
      skipped++;
      continue;
    }

    const t20sBull = parseFloat(r.t20s_bull_wei || 0) / 1e18;
    const t20sBear = parseFloat(r.t20s_bear_wei || 0) / 1e18;
    const t20sTotal = t20sBull + t20sBear;
    if (t20sTotal === 0) continue;

    const bullPayout = (t20sTotal * 0.97) / t20sBull;
    const bearPayout = (t20sTotal * 0.97) / t20sBear;

    let signal = null;

    // Determine strategy based on cooldown status
    if (inCooldown && cooldownStrategy === 'inverse') {
      // INVERSE CONTRARIAN (bet WITH EMA when choppy)
      // When EMA says BULL, bet BULL (follow trend)
      // When EMA says BEAR, bet BEAR (follow trend)
      if (emaSignal === 'BULL' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BULL';
      } else if (emaSignal === 'BEAR' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BEAR';
      }
    } else if (inCooldown && cooldownStrategy === 'consensus') {
      // CONSENSUS (bet WITH crowd)
      // Bet BULL when crowd is bullish (bullPayout < 1.45)
      // Bet BEAR when crowd is bearish (bearPayout < 1.45)
      if (emaSignal === 'BULL' && bullPayout < BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BULL';
      } else if (emaSignal === 'BEAR' && bearPayout < BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BEAR';
      }
    } else {
      // NORMAL CONTRARIAN STRATEGY
      if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BULL';
      } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BEAR';
      }
    }

    if (!signal) continue;

    // Position sizing
    let sizeMultiplier = 1.0;
    const emaGap = parseFloat(r.ema_gap) || 0;
    if (Math.abs(emaGap) >= 0.15) sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betAmount = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    const winner = r.winner ? r.winner.toLowerCase() : '';
    const won = (signal === 'BULL' && winner === 'bull') || (signal === 'BEAR' && winner === 'bear');

    if (won) {
      const actualPayout = parseFloat(r.winner_payout_multiple);
      const profit = betAmount * (actualPayout - 1);
      bankroll += profit;
      wins++;
      if (inCooldown) cooldownWins++;
      if (!inCooldown) consecutiveLosses = 0;
    } else {
      bankroll -= betAmount;
      losses++;
      if (inCooldown) cooldownLosses++;

      if (!inCooldown) {
        consecutiveLosses++;
        if (useCircuitBreaker && consecutiveLosses >= 3) {
          cooldownUntilTimestamp = r.lock_timestamp + (45 * 60);
          cbTriggered++;
          consecutiveLosses = 0;
        }
      }
    }

    if (inCooldown) cooldownTrades++;

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const roi = ((bankroll - BASE_CONFIG.STARTING_BANKROLL) / BASE_CONFIG.STARTING_BANKROLL) * 100;

  const cooldownWR = cooldownTrades > 0 ? (cooldownWins / cooldownTrades * 100) : 0;

  return {
    roi, winRate, trades: totalTrades, wins, losses, maxDrawdown, bankroll, peak,
    skipped, cbTriggered,
    cooldownTrades, cooldownWins, cooldownLosses, cooldownWR
  };
}

console.log('🔥 CIRCUIT BREAKER + COOLDOWN STRATEGY TEST\n');
console.log('═'.repeat(120));
console.log('\nIdea: Instead of SKIPPING during cooldown, use a different strategy!\n');
console.log('═'.repeat(120));

const db = initDatabase('./prediction.db');
const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`\n📊 Total rounds: ${rounds.length}\n`);
console.log('═'.repeat(120));

const strategies = [
  { name: 'BASELINE (No Circuit Breaker)', useCircuitBreaker: false },
  { name: 'Circuit Breaker (Skip)', useCircuitBreaker: true, cooldownStrategy: 'skip' },
  { name: 'CB + INVERSE During Cooldown', useCircuitBreaker: true, cooldownStrategy: 'inverse' },
  { name: 'CB + CONSENSUS During Cooldown', useCircuitBreaker: true, cooldownStrategy: 'consensus' },
];

console.log('\n🧪 TESTING STRATEGIES:\n');
console.log('─'.repeat(120));

console.log('Strategy                              │ Win Rate │   ROI    │  Peak  │ Final  │ MaxDD  │ Trades │ CB Hits │ CD Trades │ CD WR');
console.log('─'.repeat(120));

const results = [];

for (const strat of strategies) {
  const result = runStrategy(rounds, strat);
  results.push({ name: strat.name, ...result });

  const name = strat.name.padEnd(37);
  const wr = `${result.winRate.toFixed(1)}%`.padStart(8);
  const roi = `${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(0)}%`.padStart(8);
  const peak = `${result.peak.toFixed(2)}`.padStart(6);
  const final = `${result.bankroll.toFixed(2)}`.padStart(6);
  const dd = `${result.maxDrawdown.toFixed(1)}%`.padStart(6);
  const trades = String(result.trades).padStart(6);
  const cb = result.cbTriggered ? String(result.cbTriggered).padStart(7) : '   -   ';
  const cdTrades = result.cooldownTrades > 0 ? String(result.cooldownTrades).padStart(9) : '     -    ';
  const cdWR = result.cooldownTrades > 0 ? `${result.cooldownWR.toFixed(1)}%`.padStart(5) : '  -  ';

  console.log(`${name} │ ${wr} │ ${roi} │ ${peak} │ ${final} │ ${dd} │ ${trades} │ ${cb} │ ${cdTrades} │ ${cdWR}`);
}

console.log('\n' + '═'.repeat(120));
console.log('\n🏆 DETAILED RESULTS:\n');
console.log('─'.repeat(120));

for (const r of results) {
  console.log(`\n${r.name}:`);
  console.log(`   Win Rate: ${r.winRate.toFixed(1)}% (${r.wins}W / ${r.losses}L)`);
  console.log(`   ROI: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%`);
  console.log(`   Peak: ${r.peak.toFixed(2)} BNB | Final: ${r.bankroll.toFixed(2)} BNB`);
  console.log(`   Max Drawdown: ${r.maxDrawdown.toFixed(1)}%`);
  console.log(`   Total Trades: ${r.trades}`);
  if (r.cbTriggered) {
    console.log(`   Circuit Breaker Triggered: ${r.cbTriggered} times`);
    if (r.cooldownTrades > 0) {
      console.log(`   Cooldown Trades: ${r.cooldownTrades} (${r.cooldownWins}W / ${r.cooldownLosses}L)`);
      console.log(`   Cooldown Win Rate: ${r.cooldownWR.toFixed(1)}%`);
    }
  }
  if (r.skipped) console.log(`   Skipped: ${r.skipped} trades`);
}

console.log('\n' + '═'.repeat(120));
console.log('\n🎯 COMPARISON:\n');
console.log('─'.repeat(120));

const baseline = results.find(r => r.name === 'BASELINE (No Circuit Breaker)');
const cbSkip = results.find(r => r.name === 'Circuit Breaker (Skip)');
const cbInverse = results.find(r => r.name === 'CB + INVERSE During Cooldown');
const cbConsensus = results.find(r => r.name === 'CB + CONSENSUS During Cooldown');

console.log(`\nBaseline:           ${baseline.winRate.toFixed(1)}% WR | ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(0)}% ROI | ${baseline.maxDrawdown.toFixed(1)}% DD`);
console.log(`CB (Skip):          ${cbSkip.winRate.toFixed(1)}% WR | ${cbSkip.roi >= 0 ? '+' : ''}${cbSkip.roi.toFixed(0)}% ROI | ${cbSkip.maxDrawdown.toFixed(1)}% DD`);
console.log(`CB + Inverse:       ${cbInverse.winRate.toFixed(1)}% WR | ${cbInverse.roi >= 0 ? '+' : ''}${cbInverse.roi.toFixed(0)}% ROI | ${cbInverse.maxDrawdown.toFixed(1)}% DD`);
console.log(`CB + Consensus:     ${cbConsensus.winRate.toFixed(1)}% WR | ${cbConsensus.roi >= 0 ? '+' : ''}${cbConsensus.roi.toFixed(0)}% ROI | ${cbConsensus.maxDrawdown.toFixed(1)}% DD`);

console.log('\n' + '─'.repeat(120));

const best = results.sort((a, b) => b.roi - a.roi)[0];

console.log(`\n🏆 BEST STRATEGY: ${best.name}\n`);
console.log(`   Win Rate: ${best.winRate.toFixed(1)}%`);
console.log(`   ROI: ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(1)}%`);
console.log(`   Max Drawdown: ${best.maxDrawdown.toFixed(1)}%`);
console.log(`   Improvement over Baseline:`);
console.log(`     Win Rate: ${best.winRate - baseline.winRate >= 0 ? '+' : ''}${(best.winRate - baseline.winRate).toFixed(1)}%`);
console.log(`     ROI: ${best.roi - baseline.roi >= 0 ? '+' : ''}${(best.roi - baseline.roi).toFixed(1)}%`);
console.log(`     Max Drawdown: ${best.maxDrawdown - baseline.maxDrawdown >= 0 ? '+' : ''}${(best.maxDrawdown - baseline.maxDrawdown).toFixed(1)}%`);

console.log('\n' + '═'.repeat(120));
console.log('\n💡 ANALYSIS:\n');

if (cbInverse.cooldownWR > 50) {
  console.log(`✅ INVERSE strategy during cooldown WORKS!`);
  console.log(`   Cooldown Win Rate: ${cbInverse.cooldownWR.toFixed(1)}%`);
  console.log(`   This validates your idea - bad streaks ARE often choppy markets!`);
} else {
  console.log(`❌ Inverse strategy during cooldown doesn't help`);
  console.log(`   Cooldown Win Rate: ${cbInverse.cooldownWR.toFixed(1)}%`);
}

if (cbConsensus.cooldownWR > 50) {
  console.log(`\n✅ CONSENSUS strategy during cooldown WORKS!`);
  console.log(`   Cooldown Win Rate: ${cbConsensus.cooldownWR.toFixed(1)}%`);
} else {
  console.log(`\n❌ Consensus strategy during cooldown doesn't help`);
  console.log(`   Cooldown Win Rate: ${cbConsensus.cooldownWR.toFixed(1)}%`);
}

console.log('\n' + '═'.repeat(120));

db.close();
