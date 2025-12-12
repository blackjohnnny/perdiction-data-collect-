import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🔴 ANALYZING THE 13-LOSS STREAK DISASTER\n');
console.log('═'.repeat(100) + '\n');
console.log('Goal: Find MINIMAL filter to prevent -70% drawdown WITHOUT killing 5000% ROI\n');
console.log('─'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Analyzing ${rounds.length} complete rounds\n\n`);

function getPrice(r) {
  const lock = parseFloat(r.lock_price);
  return lock > 1000000 ? lock / 1e8 : lock;
}

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0
};

// Original strategy (EMA Contrarian)
function runOriginalStrategy(applyFilter = null) {
  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  const tradeLog = [];

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    // CONTRARIAN (original strategy)
    let signal = null;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      signal = 'BULL';
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      signal = 'BEAR';
    }

    if (!signal) continue;

    // Apply filter if provided
    if (applyFilter) {
      const shouldSkip = applyFilter(rounds, i, tradeLog, signal, emaSignal);
      if (shouldSkip) {
        skipped++;
        continue;
      }
    }

    // Dynamic position sizing
    let sizeMultiplier = 1.0;
    const emaGap = parseFloat(r.ema_gap) || 0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;

    if (hasStrongSignal) {
      sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betSize = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    if (betSize > bankroll) continue;

    const actualPayout = parseFloat(r.winner_payout_multiple);
    const won = signal.toLowerCase() === r.winner.toLowerCase();

    const prevBankroll = bankroll;

    if (won) {
      const profit = betSize * (actualPayout - 1);
      bankroll += profit;
      wins++;
    } else {
      bankroll -= betSize;
      losses++;
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    tradeLog.push({
      epoch: r.epoch,
      index: i,
      signal,
      emaSignal,
      emaGap,
      won,
      bankroll,
      prevBankroll,
      drawdown: ((bankroll - prevBankroll) / prevBankroll) * 100
    });
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = ((bankroll - BASE_CONFIG.STARTING_BANKROLL) / BASE_CONFIG.STARTING_BANKROLL) * 100;

  return { trades: totalTrades, wins, losses, winRate, roi, bankroll, skipped, tradeLog };
}

console.log('🔍 STEP 1: Analyze the 13-loss streak in detail\n');
console.log('─'.repeat(100) + '\n');

const baselineResult = runOriginalStrategy();
const tradeLog = baselineResult.tradeLog;

// Find 13-loss streak
let maxStreak = 0;
let currentStreak = 0;
let streakStart = -1;
let maxStreakStart = -1;
let maxStreakEnd = -1;

for (let i = 0; i < tradeLog.length; i++) {
  if (!tradeLog[i].won) {
    if (currentStreak === 0) {
      streakStart = i;
    }
    currentStreak++;
    if (currentStreak > maxStreak) {
      maxStreak = currentStreak;
      maxStreakStart = streakStart;
      maxStreakEnd = i;
    }
  } else {
    currentStreak = 0;
  }
}

console.log(`Found longest loss streak: ${maxStreak} consecutive losses`);
console.log(`Trades: ${maxStreakStart} → ${maxStreakEnd}\n`);

const streak = tradeLog.slice(maxStreakStart, maxStreakEnd + 1);

console.log('13-Loss Streak Details:\n');

for (let i = 0; i < streak.length; i++) {
  const t = streak[i];
  const r = rounds[t.index];

  console.log(`Loss ${i + 1} - Epoch ${t.epoch}:`);
  console.log(`  Signal: ${t.signal} (EMA: ${t.emaSignal}, Gap: ${t.emaGap.toFixed(3)}%)`);
  console.log(`  Bankroll: ${t.prevBankroll.toFixed(3)} → ${t.bankroll.toFixed(3)} (${t.drawdown.toFixed(1)}%)`);

  // Check conditions
  const price = getPrice(r);
  const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;
  const crowdBullPct = (bullWei / total) * 100;

  console.log(`  Crowd: ${crowdBullPct.toFixed(1)}% BULL, ${(100 - crowdBullPct).toFixed(1)}% BEAR`);
  console.log(`  Price: ${price.toFixed(2)}\n`);
}

console.log('═'.repeat(100) + '\n');
console.log('🧪 STEP 2: Test MINIMAL filters to stop the bleeding\n');
console.log('═'.repeat(100) + '\n\n');

// Filter 1: Circuit breaker after N losses
function circuitBreakerFilter(N, cooldown) {
  return (rounds, index, tradeLog, signal, emaSignal) => {
    if (tradeLog.length < N) return false;

    const recentTrades = tradeLog.slice(-N);
    const allLosses = recentTrades.every(t => !t.won);

    if (allLosses) {
      // Check if we're in cooldown
      const lastTrade = tradeLog[tradeLog.length - 1];
      const currentRound = rounds[index];
      const timeDiff = (currentRound.lock_timestamp - rounds[lastTrade.index].lock_timestamp) / 60;

      return timeDiff < cooldown; // Skip if within cooldown period
    }

    return false;
  };
}

// Filter 2: Stop after max drawdown
function maxDrawdownFilter(maxDrawdown) {
  let peakBankroll = BASE_CONFIG.STARTING_BANKROLL;

  return (rounds, index, tradeLog, signal, emaSignal) => {
    if (tradeLog.length === 0) return false;

    const currentBankroll = tradeLog[tradeLog.length - 1].bankroll;

    if (currentBankroll > peakBankroll) {
      peakBankroll = currentBankroll;
    }

    const drawdown = ((peakBankroll - currentBankroll) / peakBankroll) * 100;

    return drawdown > maxDrawdown;
  };
}

// Filter 3: Reduce position size after losses (not skip, just reduce)
function reduceAfterLosses(N, reductionFactor) {
  // This modifies the strategy, not a skip filter
  return null;
}

// Filter 4: Skip when both recent losses AND weak signal
function weakSignalAfterLossesFilter(lossCount, maxGap) {
  return (rounds, index, tradeLog, signal, emaSignal) => {
    if (tradeLog.length < lossCount) return false;

    const recentTrades = tradeLog.slice(-lossCount);
    const allLosses = recentTrades.every(t => !t.won);

    if (allLosses) {
      const emaGap = Math.abs(parseFloat(rounds[index].ema_gap) || 0);
      return emaGap < maxGap; // Skip if weak signal after losses
    }

    return false;
  };
}

const filters = [
  { name: 'BASELINE (No filter)', filter: null },
  { name: 'Circuit Breaker: Stop after 3 losses (30min cooldown)', filter: circuitBreakerFilter(3, 30) },
  { name: 'Circuit Breaker: Stop after 4 losses (30min cooldown)', filter: circuitBreakerFilter(4, 30) },
  { name: 'Circuit Breaker: Stop after 5 losses (30min cooldown)', filter: circuitBreakerFilter(5, 30) },
  { name: 'Circuit Breaker: Stop after 3 losses (60min cooldown)', filter: circuitBreakerFilter(3, 60) },
  { name: 'Max Drawdown: Stop at -30%', filter: maxDrawdownFilter(30) },
  { name: 'Max Drawdown: Stop at -40%', filter: maxDrawdownFilter(40) },
  { name: 'Max Drawdown: Stop at -50%', filter: maxDrawdownFilter(50) },
  { name: 'Weak Signal Filter: Skip weak signals (<0.1%) after 2 losses', filter: weakSignalAfterLossesFilter(2, 0.1) },
  { name: 'Weak Signal Filter: Skip weak signals (<0.15%) after 3 losses', filter: weakSignalAfterLossesFilter(3, 0.15) }
];

const results = [];

for (const filterConfig of filters) {
  const result = runOriginalStrategy(filterConfig.filter);
  results.push({
    name: filterConfig.name,
    ...result
  });
}

// Sort by ROI
results.sort((a, b) => b.roi - a.roi);

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;

  console.log(`${rank} ${r.name}`);
  console.log(`   Trades: ${r.trades} | Win Rate: ${r.winRate.toFixed(1)}% | ROI: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}%`);
  console.log(`   Final: ${r.bankroll.toFixed(3)} BNB | Skipped: ${r.skipped}\n`);
}

console.log('═'.repeat(100) + '\n');
console.log('📊 ANALYSIS: Would these filters have stopped the 13-loss streak?\n');
console.log('─'.repeat(100) + '\n');

const baseline = results.find(r => r.name.includes('BASELINE'));

console.log(`Baseline Performance:`);
console.log(`  ROI: ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(2)}%`);
console.log(`  Final: ${baseline.bankroll.toFixed(3)} BNB\n`);

for (const r of results.slice(1)) {
  const improvement = r.roi - baseline.roi;
  console.log(`${r.name}:`);
  console.log(`  ROI Change: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(2)}%`);
  console.log(`  Trades Lost: ${baseline.trades - r.trades}`);
  console.log(`  Effectiveness: ${improvement >= 0 ? '✅ HELPS' : '❌ HURTS'}\n`);
}

console.log('═'.repeat(100) + '\n');
console.log('🎯 RECOMMENDATION:\n');
console.log('─'.repeat(100) + '\n');

const best = results[0];

if (best.name.includes('BASELINE')) {
  console.log('⚠️  NO FILTER IMPROVES PERFORMANCE\n');
  console.log('The 13-loss streak was unavoidable with filters that don\'t destroy overall ROI.\n');
  console.log('💡 Alternative approach needed: Accept drawdowns or switch strategies during bad markets.\n');
} else {
  console.log(`✅ BEST FILTER: ${best.name}\n`);
  console.log(`Performance:`);
  console.log(`  ROI: ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(2)}% (vs ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(2)}% baseline)`);
  console.log(`  Improvement: ${(best.roi - baseline.roi).toFixed(2)}%`);
  console.log(`  Win Rate: ${best.winRate.toFixed(1)}%`);
  console.log(`  Trades: ${best.trades} (skipped ${best.skipped})\n`);

  console.log('💡 This filter provides the MINIMAL intervention to prevent catastrophic losses\n');
  console.log('   while preserving maximum ROI potential.\n');
}

console.log('═'.repeat(100));

db.close();
