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

function calculateRange(rounds, currentIndex, lookback) {
  const startIdx = Math.max(0, currentIndex - lookback);
  const recentRounds = rounds.slice(startIdx, currentIndex + 1);

  if (recentRounds.length < 3) return null;

  const closePrices = recentRounds.map(r => r.close_price);
  const high = Math.max(...closePrices);
  const low = Math.min(...closePrices);
  return ((high - low) / low) * 100;
}

function testInverseStrategy(rounds, config) {
  const {
    lookback = 12,
    maxFlipRate = 0.20,
    minRange = null,
    useInverse = false
  } = config;

  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let wins = 0, losses = 0;
  let choppyWins = 0, choppyLosses = 0;
  let trendingWins = 0, trendingLosses = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const flipRate = calculateFlipRate(rounds, i, lookback);
    if (flipRate === null) continue;

    const range = minRange ? calculateRange(rounds, i, lookback) : null;

    // Determine if choppy market
    let isChoppy = flipRate > maxFlipRate;
    if (minRange && range !== null && range < minRange) isChoppy = true;

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

    // INVERSE SIGNAL IF CHOPPY
    let finalSignal = signal;
    if (useInverse && isChoppy) {
      finalSignal = signal === 'BULL' ? 'BEAR' : 'BULL';
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
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const choppyTotal = choppyWins + choppyLosses;
  const choppyWR = choppyTotal > 0 ? (choppyWins / choppyTotal * 100) : 0;
  const trendingTotal = trendingWins + trendingLosses;
  const trendingWR = trendingTotal > 0 ? (trendingWins / trendingTotal * 100) : 0;
  const roi = ((bankroll - BASE_CONFIG.STARTING_BANKROLL) / BASE_CONFIG.STARTING_BANKROLL) * 100;

  return {
    roi, winRate, trades: totalTrades, wins, losses, maxDrawdown, bankroll, peak,
    choppyWR, choppyTrades: choppyTotal, choppyWins, choppyLosses,
    trendingWR, trendingTrades: trendingTotal, trendingWins, trendingLosses
  };
}

console.log('🔄 CHOPPY MARKET INVERSE STRATEGY TEST\n');
console.log('═'.repeat(120));
console.log('\nIdea: In choppy markets, our contrarian strategy fails. What if we INVERSE the trade?\n');
console.log('═'.repeat(120));

const db = initDatabase('./prediction.db');
const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`\n📊 Total rounds: ${rounds.length}\n`);

// STEP 1: Analyze choppy vs trending win rates with different detection methods
console.log('═'.repeat(120));
console.log('\n📊 STEP 1: ANALYZE CHOPPY vs TRENDING WIN RATES (No Inverse Yet)\n');
console.log('─'.repeat(120));

const detectionMethods = [
  // FlipRate based (different lookbacks)
  { name: 'FlipRate>20% (6 rounds)', lookback: 6, maxFlipRate: 0.20 },
  { name: 'FlipRate>20% (8 rounds)', lookback: 8, maxFlipRate: 0.20 },
  { name: 'FlipRate>20% (10 rounds)', lookback: 10, maxFlipRate: 0.20 },
  { name: 'FlipRate>20% (12 rounds)', lookback: 12, maxFlipRate: 0.20 },
  { name: 'FlipRate>20% (15 rounds)', lookback: 15, maxFlipRate: 0.20 },
  { name: 'FlipRate>20% (18 rounds)', lookback: 18, maxFlipRate: 0.20 },

  // Different flip thresholds (12 round lookback)
  { name: 'FlipRate>15% (12 rounds)', lookback: 12, maxFlipRate: 0.15 },
  { name: 'FlipRate>25% (12 rounds)', lookback: 12, maxFlipRate: 0.25 },
  { name: 'FlipRate>30% (12 rounds)', lookback: 12, maxFlipRate: 0.30 },

  // Range based
  { name: 'Range<0.8% (12 rounds)', lookback: 12, minRange: 0.8 },
  { name: 'Range<0.7% (10 rounds)', lookback: 10, minRange: 0.7 },
  { name: 'Range<0.6% (8 rounds)', lookback: 8, minRange: 0.6 },

  // Combo
  { name: 'FlipRate>20% OR Range<0.8% (12r)', lookback: 12, maxFlipRate: 0.20, minRange: 0.8 },
];

console.log('Detection Method                           │ Choppy WR │ Choppy Trades │ Trending WR │ Trending Trades │ Inverse Worth?');
console.log('─'.repeat(120));

const results = [];

for (const method of detectionMethods) {
  const result = testInverseStrategy(rounds, { ...method, useInverse: false });
  results.push({ method: method.name, ...result });

  const worthInverse = result.choppyWR < 48 ? '✅ YES' : '❌ NO';

  console.log(
    `${method.name.padEnd(42)} │ ` +
    `${result.choppyWR.toFixed(1)}%`.padStart(9) + ' │ ' +
    `${result.choppyTrades}`.padStart(13) + ' │ ' +
    `${result.trendingWR.toFixed(1)}%`.padStart(11) + ' │ ' +
    `${result.trendingTrades}`.padStart(15) + ' │ ' +
    worthInverse
  );
}

// STEP 2: Find best methods where choppy WR < 48%
console.log('\n' + '═'.repeat(120));
console.log('\n📊 STEP 2: METHODS WHERE CHOPPY WR < 48% (Worth Inversing)\n');
console.log('─'.repeat(120));

const worthInversing = results.filter(r => r.choppyWR < 48 && r.choppyTrades >= 30);

if (worthInversing.length === 0) {
  console.log('❌ NO methods found where choppy WR < 48% with at least 30 trades\n');
} else {
  console.log(`Found ${worthInversing.length} methods where inversing could help:\n`);

  for (const r of worthInversing) {
    console.log(`${r.method}:`);
    console.log(`  Choppy: ${r.choppyWR.toFixed(1)}% WR (${r.choppyWins}W/${r.choppyLosses}L) - ${r.choppyTrades} trades`);
    console.log(`  Trending: ${r.trendingWR.toFixed(1)}% WR (${r.trendingWins}W/${r.trendingLosses}L) - ${r.trendingTrades} trades`);
    console.log(`  Expected if inversed: ~${(100 - r.choppyWR).toFixed(1)}% in choppy markets\n`);
  }
}

// STEP 3: Test inverse strategy on best candidates
console.log('═'.repeat(120));
console.log('\n🔄 STEP 3: TEST INVERSE STRATEGY ON PROMISING METHODS\n');
console.log('─'.repeat(120));

const toTest = worthInversing.length > 0 ? worthInversing : results.slice(0, 5);

console.log('Strategy                                   │ Total WR │   ROI    │ Final │ MaxDD  │ Choppy WR │ Trend WR');
console.log('─'.repeat(120));

const inverseResults = [];

for (const candidate of toTest) {
  // Find original config
  const originalMethod = detectionMethods.find(m => m.name === candidate.method);
  if (!originalMethod) continue;

  // Test WITHOUT inverse
  const noInverse = testInverseStrategy(rounds, { ...originalMethod, useInverse: false });

  // Test WITH inverse
  const withInverse = testInverseStrategy(rounds, { ...originalMethod, useInverse: true });

  inverseResults.push({
    name: candidate.method,
    noInverse,
    withInverse,
    improvement: withInverse.winRate - noInverse.winRate,
    roiImprovement: withInverse.roi - noInverse.roi
  });

  console.log(`${candidate.method.padEnd(42)} │`);
  console.log(`  Without Inverse                          │ ${noInverse.winRate.toFixed(1)}%`.padStart(9) + ' │ ' +
    `${noInverse.roi >= 0 ? '+' : ''}${noInverse.roi.toFixed(0)}%`.padStart(8) + ' │ ' +
    `${noInverse.bankroll.toFixed(2)}`.padStart(5) + ' │ ' +
    `${noInverse.maxDrawdown.toFixed(1)}%`.padStart(6) + ' │ ' +
    `${noInverse.choppyWR.toFixed(1)}%`.padStart(9) + ' │ ' +
    `${noInverse.trendingWR.toFixed(1)}%`.padStart(8)
  );
  console.log(`  WITH Inverse (choppy only)               │ ${withInverse.winRate.toFixed(1)}%`.padStart(9) + ' │ ' +
    `${withInverse.roi >= 0 ? '+' : ''}${withInverse.roi.toFixed(0)}%`.padStart(8) + ' │ ' +
    `${withInverse.bankroll.toFixed(2)}`.padStart(5) + ' │ ' +
    `${withInverse.maxDrawdown.toFixed(1)}%`.padStart(6) + ' │ ' +
    `${withInverse.choppyWR.toFixed(1)}%`.padStart(9) + ' │ ' +
    `${withInverse.trendingWR.toFixed(1)}%`.padStart(8)
  );
  console.log(`  Improvement:                             │ ${withInverse.winRate - noInverse.winRate >= 0 ? '+' : ''}${(withInverse.winRate - noInverse.winRate).toFixed(1)}%`.padStart(9) + ' │ ' +
    `${withInverse.roi - noInverse.roi >= 0 ? '+' : ''}${(withInverse.roi - noInverse.roi).toFixed(0)}%`.padStart(8) + '\n'
  );
}

// STEP 4: Best overall strategy
console.log('═'.repeat(120));
console.log('\n🏆 FINAL RESULTS: BEST STRATEGIES\n');
console.log('─'.repeat(120));

const allStrategies = [];

// Add baseline
const baseline = testInverseStrategy(rounds, { lookback: 12, maxFlipRate: 1.0 }); // No filtering
allStrategies.push({ name: 'BASELINE (No Detection)', result: baseline });

// Add all inverse results
for (const ir of inverseResults) {
  allStrategies.push({ name: ir.name + ' (No Inverse)', result: ir.noInverse });
  allStrategies.push({ name: ir.name + ' (WITH Inverse)', result: ir.withInverse });
}

// Sort by win rate
allStrategies.sort((a, b) => b.result.winRate - a.result.winRate);

console.log('Rank │ Strategy                                          │ Win Rate │   ROI    │ Final │ MaxDD');
console.log('─'.repeat(120));

for (let i = 0; i < Math.min(10, allStrategies.length); i++) {
  const s = allStrategies[i];
  const rank = String(i + 1).padStart(2);
  const name = s.name.padEnd(49);
  const wr = `${s.result.winRate.toFixed(1)}%`.padStart(8);
  const roi = `${s.result.roi >= 0 ? '+' : ''}${s.result.roi.toFixed(0)}%`.padStart(8);
  const final = `${s.result.bankroll.toFixed(2)}`.padStart(5);
  const dd = `${s.result.maxDrawdown.toFixed(1)}%`.padStart(5);

  console.log(`${rank}   │ ${name} │ ${wr} │ ${roi} │ ${final} │ ${dd}`);
}

console.log('\n' + '═'.repeat(120));

const best = allStrategies[0];
console.log('\n🎯 RECOMMENDED STRATEGY:\n');
console.log(`   ${best.name}`);
console.log(`   Win Rate: ${best.result.winRate.toFixed(1)}% (${best.result.wins}W / ${best.result.losses}L)`);
console.log(`   ROI: ${best.result.roi >= 0 ? '+' : ''}${best.result.roi.toFixed(1)}%`);
console.log(`   Final Bankroll: ${best.result.bankroll.toFixed(2)} BNB`);
console.log(`   Max Drawdown: ${best.result.maxDrawdown.toFixed(1)}%`);
console.log(`   Choppy Markets: ${best.result.choppyWR.toFixed(1)}% WR (${best.result.choppyTrades} trades)`);
console.log(`   Trending Markets: ${best.result.trendingWR.toFixed(1)}% WR (${best.result.trendingTrades} trades)`);

console.log('\n' + '═'.repeat(120));

db.close();
