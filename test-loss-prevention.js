import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🛡️  LOSS PREVENTION ANALYSIS\n');
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

console.log(`📊 Analyzing ${rounds.length} complete rounds\n`);
console.log('─'.repeat(100) + '\n');

// Fakeout detection (existing)
function detectFakeout(rounds, index, signal, emaGap) {
  if (index < 2 || index >= rounds.length - 1) return false;

  const current = rounds[index];
  const prev = rounds[index - 1];

  const currentGap = Math.abs(parseFloat(emaGap));
  const prevGap = Math.abs(parseFloat(prev.ema_gap));

  const bullWei = parseFloat(current.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(current.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;
  if (total === 0) return false;

  const bullPct = (bullWei / total) * 100;
  const bearPct = (bearWei / total) * 100;

  const lookback = 14;
  const startIdx = Math.max(0, index - lookback);
  const priceWindow = rounds.slice(startIdx, index + 1);
  const prices = priceWindow.map(r => {
    const lock = Number(r.lock_price);
    const close = Number(r.close_price);
    if (lock > 0) return lock / 1e8;
    if (close > 0) return close / 1e8;
    return 0;
  }).filter(p => p > 0);

  if (prices.length === 0) return false;

  const highest = Math.max(...prices);
  const lowest = Math.min(...prices);
  const range = highest - lowest;
  if (range === 0) return false;

  const currentLock = Number(current.lock_price);
  const currentClose = Number(current.close_price);
  const currentPrice = currentLock > 0 ? currentLock / 1e8 : currentClose > 0 ? currentClose / 1e8 : 0;
  if (currentPrice === 0) return false;

  const pricePosition = (currentPrice - lowest) / range;

  let fakeoutScore = 0;

  if (currentGap < prevGap * 0.8) fakeoutScore += 1;
  if (signal === 'BULL' && bullPct > 80) fakeoutScore += 1;
  else if (signal === 'BEAR' && bearPct > 80) fakeoutScore += 1;
  if (signal === 'BULL' && pricePosition > 0.8) fakeoutScore += 1;
  else if (signal === 'BEAR' && pricePosition < 0.2) fakeoutScore += 1;

  return fakeoutScore >= 2;
}

// Market state detection
function detectMarketState(rounds, index) {
  if (index < 20) return 'UNKNOWN';

  const window = rounds.slice(index - 20, index + 1);
  const prices = window.map(r => {
    const lock = Number(r.lock_price);
    const close = Number(r.close_price);
    if (lock > 0) return lock / 1e8;
    if (close > 0) return close / 1e8;
    return null;
  }).filter(p => p !== null);

  if (prices.length < 21) return 'UNKNOWN';

  const highest = Math.max(...prices);
  const lowest = Math.min(...prices);
  const range = highest - lowest;
  const avgPrice = prices.reduce((a, b) => a + b) / prices.length;
  const rangePercent = (range / avgPrice) * 100;

  // Calculate price volatility
  const squaredDiffs = prices.map(p => Math.pow(p - avgPrice, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b) / prices.length;
  const stdDev = Math.sqrt(variance);
  const cv = (stdDev / avgPrice) * 100; // Coefficient of variation

  // Trend strength
  const firstHalf = prices.slice(0, 10);
  const secondHalf = prices.slice(11);
  const firstAvg = firstHalf.reduce((a, b) => a + b) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b) / secondHalf.length;
  const trendStrength = Math.abs((secondAvg - firstAvg) / firstAvg) * 100;

  // Consolidation: Low range, low volatility, weak trend
  if (rangePercent < 2.0 && cv < 1.5 && trendStrength < 1.0) {
    return 'CONSOLIDATION';
  }
  // Strong trend: High range, clear direction
  else if (rangePercent > 3.0 && trendStrength > 1.5) {
    return 'TRENDING';
  }
  // Choppy: High volatility, but no clear trend
  else if (cv > 2.0 && trendStrength < 1.0) {
    return 'CHOPPY';
  }
  else {
    return 'NEUTRAL';
  }
}

// Consecutive loss pattern detection
function getRecentLossStreak(tradeLog) {
  let streak = 0;
  for (let i = tradeLog.length - 1; i >= 0; i--) {
    if (!tradeLog[i].won) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// Run baseline strategy
function runStrategy(rounds, config) {
  const {
    useFakeoutFilter = true,
    useMarketStateFilter = false,
    useConsecutiveLossFilter = false,
    maxConsecutiveLosses = 3,
    allowedMarketStates = ['TRENDING', 'NEUTRAL', 'CHOPPY', 'CONSOLIDATION'],
    useVolatilityFilter = false,
    minVolatility = 0,
    useWeakSignalFilter = false,
    weakSignalThreshold = 0.1
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
  const tradeLog = [];

  let skippedFakeout = 0;
  let skippedMarketState = 0;
  let skippedConsecutiveLoss = 0;
  let skippedVolatility = 0;
  let skippedWeakSignal = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    const emaSignal = r.ema_signal;
    const emaGap = parseFloat(r.ema_gap);
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPercent = (bullWei / total) * 100;
    const bearPercent = (bearWei / total) * 100;
    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    // CONTRARIAN: EMA + Against Crowd
    let betSide = null;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BULL';
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BEAR';
    }

    if (!betSide) continue;

    // FILTER 1: Fakeout detection
    if (useFakeoutFilter) {
      const isFakeout = detectFakeout(rounds, i, emaSignal, emaGap);
      if (isFakeout) {
        skippedFakeout++;
        continue;
      }
    }

    // FILTER 2: Market state
    if (useMarketStateFilter) {
      const marketState = detectMarketState(rounds, i);
      if (!allowedMarketStates.includes(marketState)) {
        skippedMarketState++;
        continue;
      }
    }

    // FILTER 3: Consecutive loss streak
    if (useConsecutiveLossFilter) {
      const lossStreak = getRecentLossStreak(tradeLog);
      if (lossStreak >= maxConsecutiveLosses) {
        skippedConsecutiveLoss++;
        continue;
      }
    }

    // FILTER 4: Volatility filter
    if (useVolatilityFilter) {
      if (i >= 20) {
        const window = rounds.slice(i - 20, i + 1);
        const prices = window.map(r => {
          const lock = Number(r.lock_price);
          const close = Number(r.close_price);
          if (lock > 0) return lock / 1e8;
          if (close > 0) return close / 1e8;
          return null;
        }).filter(p => p !== null);

        if (prices.length >= 21) {
          const avgPrice = prices.reduce((a, b) => a + b) / prices.length;
          const squaredDiffs = prices.map(p => Math.pow(p - avgPrice, 2));
          const variance = squaredDiffs.reduce((a, b) => a + b) / prices.length;
          const stdDev = Math.sqrt(variance);
          const cv = (stdDev / avgPrice) * 100;

          if (cv < minVolatility) {
            skippedVolatility++;
            continue;
          }
        }
      }
    }

    // FILTER 5: Weak signal filter
    if (useWeakSignalFilter) {
      if (Math.abs(emaGap) < weakSignalThreshold) {
        skippedWeakSignal++;
        continue;
      }
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

    const marketState = detectMarketState(rounds, i);

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

    tradeLog.push({
      index: i,
      epoch: r.epoch,
      won,
      bankroll,
      marketState
    });
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = (totalProfit / BASE_CONFIG.STARTING_BANKROLL) * 100;

  return {
    trades: totalTrades,
    wins,
    losses,
    winRate,
    roi,
    finalBankroll: bankroll,
    profit: totalProfit,
    skippedFakeout,
    skippedMarketState,
    skippedConsecutiveLoss,
    skippedVolatility,
    skippedWeakSignal,
    tradeLog
  };
}

console.log('🔄 Running tests on different loss prevention approaches...\n\n');

// TEST 1: Baseline (current strategy)
console.log('TEST 1: BASELINE (Current Strategy)\n');
const baseline = runStrategy(rounds, { useFakeoutFilter: true });
console.log(`  Trades: ${baseline.trades} | WR: ${baseline.winRate.toFixed(1)}% | ROI: ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(2)}%`);
console.log(`  Fakeout filtered: ${baseline.skippedFakeout}\n`);

// TEST 2: Check if fakeout filter is working
console.log('TEST 2: NO FAKEOUT FILTER (Check if it\'s working)\n');
const noFakeout = runStrategy(rounds, { useFakeoutFilter: false });
console.log(`  Trades: ${noFakeout.trades} | WR: ${noFakeout.winRate.toFixed(1)}% | ROI: ${noFakeout.roi >= 0 ? '+' : ''}${noFakeout.roi.toFixed(2)}%`);
console.log(`  Difference: ${noFakeout.trades - baseline.trades} more trades, ${(noFakeout.roi - baseline.roi).toFixed(2)}% ROI impact\n`);

// TEST 3: Market state filter - avoid consolidation
console.log('TEST 3: AVOID CONSOLIDATION (Skip consolidating markets)\n');
const avoidConsolidation = runStrategy(rounds, {
  useFakeoutFilter: true,
  useMarketStateFilter: true,
  allowedMarketStates: ['TRENDING', 'NEUTRAL', 'CHOPPY']
});
console.log(`  Trades: ${avoidConsolidation.trades} | WR: ${avoidConsolidation.winRate.toFixed(1)}% | ROI: ${avoidConsolidation.roi >= 0 ? '+' : ''}${avoidConsolidation.roi.toFixed(2)}%`);
console.log(`  Skipped consolidation: ${avoidConsolidation.skippedMarketState}`);
console.log(`  vs Baseline: ${(avoidConsolidation.roi - baseline.roi).toFixed(2)}% ROI improvement\n`);

// TEST 4: Only trending markets
console.log('TEST 4: ONLY TRENDING MARKETS\n');
const onlyTrending = runStrategy(rounds, {
  useFakeoutFilter: true,
  useMarketStateFilter: true,
  allowedMarketStates: ['TRENDING']
});
console.log(`  Trades: ${onlyTrending.trades} | WR: ${onlyTrending.winRate.toFixed(1)}% | ROI: ${onlyTrending.roi >= 0 ? '+' : ''}${onlyTrending.roi.toFixed(2)}%`);
console.log(`  vs Baseline: ${(onlyTrending.roi - baseline.roi).toFixed(2)}% ROI improvement\n`);

// TEST 5: Stop after 3 consecutive losses
console.log('TEST 5: STOP AFTER 3 CONSECUTIVE LOSSES\n');
const stopAfter3Losses = runStrategy(rounds, {
  useFakeoutFilter: true,
  useConsecutiveLossFilter: true,
  maxConsecutiveLosses: 3
});
console.log(`  Trades: ${stopAfter3Losses.trades} | WR: ${stopAfter3Losses.winRate.toFixed(1)}% | ROI: ${stopAfter3Losses.roi >= 0 ? '+' : ''}${stopAfter3Losses.roi.toFixed(2)}%`);
console.log(`  Skipped after losses: ${stopAfter3Losses.skippedConsecutiveLoss}`);
console.log(`  vs Baseline: ${(stopAfter3Losses.roi - baseline.roi).toFixed(2)}% ROI improvement\n`);

// TEST 6: Stop after 4 consecutive losses
console.log('TEST 6: STOP AFTER 4 CONSECUTIVE LOSSES\n');
const stopAfter4Losses = runStrategy(rounds, {
  useFakeoutFilter: true,
  useConsecutiveLossFilter: true,
  maxConsecutiveLosses: 4
});
console.log(`  Trades: ${stopAfter4Losses.trades} | WR: ${stopAfter4Losses.winRate.toFixed(1)}% | ROI: ${stopAfter4Losses.roi >= 0 ? '+' : ''}${stopAfter4Losses.roi.toFixed(2)}%`);
console.log(`  Skipped after losses: ${stopAfter4Losses.skippedConsecutiveLoss}`);
console.log(`  vs Baseline: ${(stopAfter4Losses.roi - baseline.roi).toFixed(2)}% ROI improvement\n`);

// TEST 7: Require minimum volatility
console.log('TEST 7: MINIMUM VOLATILITY (CV ≥ 1.0%)\n');
const minVolatility = runStrategy(rounds, {
  useFakeoutFilter: true,
  useVolatilityFilter: true,
  minVolatility: 1.0
});
console.log(`  Trades: ${minVolatility.trades} | WR: ${minVolatility.winRate.toFixed(1)}% | ROI: ${minVolatility.roi >= 0 ? '+' : ''}${minVolatility.roi.toFixed(2)}%`);
console.log(`  Skipped low volatility: ${minVolatility.skippedVolatility}`);
console.log(`  vs Baseline: ${(minVolatility.roi - baseline.roi).toFixed(2)}% ROI improvement\n`);

// TEST 8: Skip weak signals (EMA gap < 0.1)
console.log('TEST 8: SKIP WEAK SIGNALS (EMA gap < 0.1%)\n');
const noWeakSignals = runStrategy(rounds, {
  useFakeoutFilter: true,
  useWeakSignalFilter: true,
  weakSignalThreshold: 0.1
});
console.log(`  Trades: ${noWeakSignals.trades} | WR: ${noWeakSignals.winRate.toFixed(1)}% | ROI: ${noWeakSignals.roi >= 0 ? '+' : ''}${noWeakSignals.roi.toFixed(2)}%`);
console.log(`  Skipped weak signals: ${noWeakSignals.skippedWeakSignal}`);
console.log(`  vs Baseline: ${(noWeakSignals.roi - baseline.roi).toFixed(2)}% ROI improvement\n`);

// TEST 9: Combined best filters
console.log('TEST 9: COMBINED (Avoid consolidation + Stop after 3 losses + Min volatility)\n');
const combined = runStrategy(rounds, {
  useFakeoutFilter: true,
  useMarketStateFilter: true,
  allowedMarketStates: ['TRENDING', 'NEUTRAL', 'CHOPPY'],
  useConsecutiveLossFilter: true,
  maxConsecutiveLosses: 3,
  useVolatilityFilter: true,
  minVolatility: 1.0
});
console.log(`  Trades: ${combined.trades} | WR: ${combined.winRate.toFixed(1)}% | ROI: ${combined.roi >= 0 ? '+' : ''}${combined.roi.toFixed(2)}%`);
console.log(`  vs Baseline: ${(combined.roi - baseline.roi).toFixed(2)}% ROI improvement\n`);

console.log('═'.repeat(100) + '\n');

// Rank all results
const results = [
  { name: 'Baseline (Current)', ...baseline },
  { name: 'No Fakeout Filter', ...noFakeout },
  { name: 'Avoid Consolidation', ...avoidConsolidation },
  { name: 'Only Trending', ...onlyTrending },
  { name: 'Stop After 3 Losses', ...stopAfter3Losses },
  { name: 'Stop After 4 Losses', ...stopAfter4Losses },
  { name: 'Min Volatility 1.0%', ...minVolatility },
  { name: 'Skip Weak Signals <0.1', ...noWeakSignals },
  { name: 'Combined Filters', ...combined }
].sort((a, b) => b.roi - a.roi);

console.log('🏆 RANKING BY ROI:\n');
results.forEach((r, i) => {
  const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
  const roiStr = r.roi >= 0 ? `+${r.roi.toFixed(2)}%` : `${r.roi.toFixed(2)}%`;
  const improvement = r.roi - baseline.roi;
  const impStr = improvement >= 0 ? `+${improvement.toFixed(2)}%` : `${improvement.toFixed(2)}%`;
  console.log(`${medal} ${(i+1).toString().padStart(2)}. ${r.name.padEnd(30)} | ${r.trades.toString().padStart(3)} trades | ${r.winRate.toFixed(1).padStart(5)}% WR | ${roiStr.padStart(10)} | ${impStr.padStart(8)}`);
});

console.log('\n' + '═'.repeat(100) + '\n');

db.close();
