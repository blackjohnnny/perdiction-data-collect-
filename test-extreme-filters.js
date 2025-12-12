import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🎯 TESTING SOLUTIONS TO LOCAL EXTREME PROBLEM\n');
console.log('═'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Testing on ${rounds.length} complete rounds\n`);
console.log('Problem: Entering at local extremes with EMA lag = losses\n');
console.log('─'.repeat(100) + '\n');

// Function to check if entry is at local extreme
function isAtLocalExtreme(rounds, index, lookback = 14) {
  if (index < lookback) return { isTop: false, isBottom: false, position: 0.5 };

  const window = rounds.slice(index - lookback, index + 1);
  const prices = window.map(r => {
    const lock = Number(r.lock_price);
    const close = Number(r.close_price);
    if (lock > 0) return lock / 1e8;
    if (close > 0) return close / 1e8;
    return null;
  }).filter(p => p !== null);

  if (prices.length < lookback) return { isTop: false, isBottom: false, position: 0.5 };

  const currentPrice = prices[prices.length - 1];
  const highest = Math.max(...prices);
  const lowest = Math.min(...prices);
  const range = highest - lowest;

  if (range === 0) return { isTop: false, isBottom: false, position: 0.5 };

  const position = (currentPrice - lowest) / range;
  const isTop = position > 0.80;
  const isBottom = position < 0.20;

  return { isTop, isBottom, position };
}

// Run strategy with different solutions
function runStrategy(rounds, config) {
  const {
    name = 'Unnamed',
    skipExtremes = false,
    reverseAtExtremes = false, // Reverse trade direction at extremes
    skipBullAtBottom = false, // Skip BULL signals when at local bottom
    skipBearAtTop = false, // Skip BEAR signals when at local top
    waitForPullback = false // Wait for price to move away from extreme
  } = config;

  const BASE_CONFIG = {
    BASE_POSITION_SIZE: 0.045,
    MOMENTUM_MULTIPLIER: 1.889,
    RECOVERY_MULTIPLIER: 1.5,
    MIN_PAYOUT: 1.45,
    STARTING_BANKROLL: 1.0
  };

  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let wins = 0;
  let losses = 0;
  let totalProfit = 0;
  let skipped = 0;
  let reversed = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    const emaSignal = r.ema_signal;
    const emaGap = parseFloat(r.ema_gap);
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    // Check entry position
    const extreme = isAtLocalExtreme(rounds, i, 14);

    // CONTRARIAN
    let betSide = null;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BULL';
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BEAR';
    }

    if (!betSide) continue;

    // SOLUTION 1: Skip all extreme entries
    if (skipExtremes && (extreme.isTop || extreme.isBottom)) {
      skipped++;
      continue;
    }

    // SOLUTION 2: Skip specific bad combos (BULL at bottom, BEAR at top)
    if (skipBullAtBottom && betSide === 'BULL' && extreme.isBottom) {
      skipped++;
      continue;
    }
    if (skipBearAtTop && betSide === 'BEAR' && extreme.isTop) {
      skipped++;
      continue;
    }

    // SOLUTION 3: Wait for pullback from extreme
    if (waitForPullback) {
      // If at extreme and EMA just crossed, skip (wait for confirmation)
      if ((extreme.isTop || extreme.isBottom) && Math.abs(emaGap) < 0.20) {
        skipped++;
        continue;
      }
    }

    // SOLUTION 4: REVERSE trade direction at extremes
    let originalBetSide = betSide;
    if (reverseAtExtremes && (extreme.isTop || extreme.isBottom)) {
      // If BULL signal at bottom, bet BEAR instead (fade the lagging signal)
      // If BEAR signal at top, bet BULL instead
      betSide = betSide === 'BULL' ? 'BEAR' : 'BULL';
      reversed++;
    }

    // Position sizing
    let sizeMultiplier = 1.0;
    if (Math.abs(emaGap) >= 0.15) {
      sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }
    if (lastTwoResults[0] === 'LOSS') {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betSize = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    const won = betSide.toLowerCase() === r.winner.toLowerCase();
    const actualPayout = parseFloat(r.winner_payout_multiple);

    if (won) {
      const profit = betSize * (actualPayout - 1);
      bankroll += profit;
      totalProfit += profit;
      wins++;
      lastTwoResults.unshift('WIN');
    } else {
      bankroll -= betSize;
      totalProfit -= betSize;
      losses++;
      lastTwoResults.unshift('LOSS');
    }

    if (lastTwoResults.length > 2) lastTwoResults.pop();
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = (totalProfit / BASE_CONFIG.STARTING_BANKROLL) * 100;

  return {
    name,
    trades: totalTrades,
    wins,
    losses,
    winRate,
    roi,
    finalBankroll: bankroll,
    profit: totalProfit,
    skipped,
    reversed
  };
}

console.log('🔄 Testing solutions...\n\n');

// Test all solutions
const strategies = [
  // Baseline
  { name: 'Baseline (No filter)', skipExtremes: false },

  // Solution 1: Skip all extremes
  { name: 'Skip ALL extremes (top/bottom 20%)', skipExtremes: true },

  // Solution 2: Skip specific bad combos
  { name: 'Skip BULL at bottom only', skipBullAtBottom: true },
  { name: 'Skip BEAR at top only', skipBearAtTop: true },
  { name: 'Skip both bad combos', skipBullAtBottom: true, skipBearAtTop: true },

  // Solution 3: Wait for pullback
  { name: 'Wait for pullback (skip weak signals at extremes)', waitForPullback: true },

  // Solution 4: REVERSE at extremes (fade the lagging EMA)
  { name: 'REVERSE trades at extremes', reverseAtExtremes: true }
];

const results = strategies.map(config => runStrategy(rounds, config));

// Display results
console.log('═'.repeat(100) + '\n');
console.log('📊 SOLUTION TEST RESULTS\n');
console.log('═'.repeat(100) + '\n');

results.forEach((r, i) => {
  const roiStr = r.roi >= 0 ? `+${r.roi.toFixed(2)}%` : `${r.roi.toFixed(2)}%`;
  console.log(`${(i + 1).toString().padStart(2)}. ${r.name.padEnd(50)} | ${r.trades.toString().padStart(3)} trades | ${r.winRate.toFixed(1).padStart(5)}% WR | ${roiStr.padStart(11)} ROI`);

  if (r.skipped > 0) {
    console.log(`    Skipped: ${r.skipped} trades`);
  }
  if (r.reversed > 0) {
    console.log(`    Reversed: ${r.reversed} trades`);
  }
  console.log();
});

console.log('═'.repeat(100) + '\n');

// Rank by ROI
const ranked = [...results].sort((a, b) => b.roi - a.roi);

console.log('🏆 TOP 3 SOLUTIONS:\n');
ranked.slice(0, 3).forEach((r, i) => {
  const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
  const roiStr = r.roi >= 0 ? `+${r.roi.toFixed(2)}%` : `${r.roi.toFixed(2)}%`;
  console.log(`${medal} ${r.name}`);
  console.log(`   ${r.trades} trades | ${r.winRate.toFixed(1)}% WR | ${roiStr} ROI | Final: ${r.finalBankroll.toFixed(4)} BNB\n`);
});

console.log('═'.repeat(100) + '\n');

// Compare to baseline
const baseline = results[0];
console.log('📈 IMPROVEMENTS VS BASELINE:\n');

ranked.slice(0, 5).forEach((r, i) => {
  if (r.name === baseline.name) return;

  const improvement = r.roi - baseline.roi;
  const impStr = improvement >= 0 ? `+${improvement.toFixed(2)}%` : `${improvement.toFixed(2)}%`;

  console.log(`${r.name}:`);
  console.log(`  ROI: ${baseline.roi.toFixed(2)}% → ${r.roi.toFixed(2)}% (${impStr})`);
  console.log(`  Win Rate: ${baseline.winRate.toFixed(1)}% → ${r.winRate.toFixed(1)}%`);
  console.log(`  Trades: ${baseline.trades} → ${r.trades}\n`);
});

console.log('═'.repeat(100) + '\n');

console.log('💡 ANALYSIS:\n');
console.log('─'.repeat(100) + '\n');

const best = ranked[0];

if (best.name.includes('REVERSE')) {
  console.log('✅ REVERSING trades at extremes is the solution!');
  console.log('   When EMA lags and signals at local tops/bottoms, fade it by betting opposite.\n');
  console.log('How it works:');
  console.log('  - EMA BULL at local bottom → Bet BEAR (price likely to stay low/go lower)');
  console.log('  - EMA BEAR at local top → Bet BULL (price likely to stay high/go higher)\n');
} else if (best.name.includes('Skip')) {
  console.log('✅ SKIPPING certain extreme entries helps!');
  console.log(`   ${best.name} improved ROI by ${(best.roi - baseline.roi).toFixed(2)}%\n`);
} else {
  console.log('🤔 None of the extreme-based solutions significantly improved performance.');
  console.log('   The problem may not be solely about entry position.\n');
}

// Check if REVERSE solution helps with the 13-loss streak
const reverseResult = results.find(r => r.name.includes('REVERSE'));
if (reverseResult) {
  console.log('─'.repeat(100) + '\n');
  console.log('🎯 WOULD REVERSING SOLVE THE 13-LOSS STREAK?\n');
  console.log('The 13-loss streak had 84.6% of trades at local extremes (mostly bottom).');
  console.log(`Reversed ${reverseResult.reversed} total trades across all data.`);
  console.log(`This represents ${((reverseResult.reversed / baseline.trades) * 100).toFixed(1)}% of all trades.\n`);

  if (reverseResult.roi > baseline.roi + 50) {
    console.log('✅ YES! Reversing at extremes would have prevented many losses!');
  } else if (reverseResult.roi > baseline.roi) {
    console.log('🤷 Helps somewhat, but not a complete solution.');
  } else {
    console.log('❌ NO - Reversing actually makes it worse!');
  }
}

console.log('\n' + '═'.repeat(100) + '\n');

db.close();
