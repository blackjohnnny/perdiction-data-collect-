import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';

console.log('\n🔄 TESTING ADAPTIVE STRATEGY SWITCHING\n');
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

// Fetch 1m candles for more granular market detection
async function get1mMarketState(timestamp) {
  try {
    const endTime = timestamp * 1000;
    const startTime = endTime - (60 * 60 * 1000); // 60 candles × 1 min
    const url = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=60`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const candles = await response.json();
    if (!Array.isArray(candles) || candles.length < 60) return null;

    const closes = candles.map(c => parseFloat(c[4]));
    const highest = Math.max(...closes);
    const lowest = Math.min(...closes);
    const range = highest - lowest;
    const avgPrice = closes.reduce((a, b) => a + b) / closes.length;
    const rangePercent = (range / avgPrice) * 100;

    // Calculate volatility
    const squaredDiffs = closes.map(p => Math.pow(p - avgPrice, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b) / closes.length;
    const stdDev = Math.sqrt(variance);
    const cv = (stdDev / avgPrice) * 100;

    // Trend strength over last 60 minutes
    const firstQuarter = closes.slice(0, 15);
    const lastQuarter = closes.slice(-15);
    const firstAvg = firstQuarter.reduce((a, b) => a + b) / firstQuarter.length;
    const lastAvg = lastQuarter.reduce((a, b) => a + b) / lastQuarter.length;
    const trendStrength = Math.abs((lastAvg - firstAvg) / firstAvg) * 100;

    // More aggressive thresholds on 1m chart
    if (rangePercent < 0.5 && cv < 0.5 && trendStrength < 0.3) {
      return 'CONSOLIDATION';
    } else if (rangePercent > 1.0 && trendStrength > 0.5) {
      return 'TRENDING';
    } else if (cv > 1.0 && trendStrength < 0.3) {
      return 'CHOPPY';
    } else {
      return 'NEUTRAL';
    }
  } catch (err) {
    return null;
  }
}

// Market state from 5m candles (existing)
function detectMarketState5m(rounds, index) {
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

  const squaredDiffs = prices.map(p => Math.pow(p - avgPrice, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b) / prices.length;
  const stdDev = Math.sqrt(variance);
  const cv = (stdDev / avgPrice) * 100;

  const firstHalf = prices.slice(0, 10);
  const secondHalf = prices.slice(11);
  const firstAvg = firstHalf.reduce((a, b) => a + b) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b) / secondHalf.length;
  const trendStrength = Math.abs((secondAvg - firstAvg) / firstAvg) * 100;

  if (rangePercent < 2.0 && cv < 1.5 && trendStrength < 1.0) {
    return 'CONSOLIDATION';
  } else if (rangePercent > 3.0 && trendStrength > 1.5) {
    return 'TRENDING';
  } else if (cv > 2.0 && trendStrength < 1.0) {
    return 'CHOPPY';
  } else {
    return 'NEUTRAL';
  }
}

// Detect bad performance pattern
function detectBadPerformance(tradeLog, lookback = 10) {
  if (tradeLog.length < lookback) return false;

  const recentTrades = tradeLog.slice(-lookback);
  const recentWins = recentTrades.filter(t => t.won).length;
  const recentWinRate = (recentWins / lookback) * 100;

  // Bad performance = win rate < 40% over last 10 trades
  return recentWinRate < 40;
}

// Run adaptive strategy
function runAdaptiveStrategy(rounds, config) {
  const {
    name = 'Unnamed',
    use1mConfirmation = false,
    switchOnBadPerformance = false,
    badPerformanceLookback = 10,
    reverseMomentum = false,
    skipTrending = false
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

  let skippedTrending = 0;
  let switchedToConsensus = 0;
  let stayedContrarian = 0;

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

    // Determine market state
    let marketState = detectMarketState5m(rounds, i);

    // FILTER: Skip trending if enabled
    if (skipTrending && marketState === 'TRENDING') {
      skippedTrending++;
      continue;
    }

    // Determine if we should trade contrarian or consensus
    let useContrarian = true;

    if (switchOnBadPerformance) {
      const isBadPerformance = detectBadPerformance(tradeLog, badPerformanceLookback);
      if (isBadPerformance) {
        useContrarian = false; // Switch to consensus
        switchedToConsensus++;
      } else {
        stayedContrarian++;
      }
    } else {
      stayedContrarian++;
    }

    // Determine bet side
    let betSide = null;

    if (useContrarian) {
      // CONTRARIAN: EMA + Against Crowd
      if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
        betSide = 'BULL';
      } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
        betSide = 'BEAR';
      }
    } else {
      // CONSENSUS: EMA + With Crowd
      const crowdFavorite = bullPercent > bearPercent ? 'BULL' : 'BEAR';
      if (emaSignal === crowdFavorite) {
        betSide = emaSignal;
      }
    }

    if (!betSide) continue;

    // Position sizing
    let sizeMultiplier = 1.0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;
    const hasRecovery = lastTwoResults[0] === 'LOSS';

    if (reverseMomentum) {
      // Bigger bets on WEAK signals
      if (!hasStrongSignal) {
        sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
      }
    } else {
      // Bigger bets on strong signals
      if (hasStrongSignal) {
        sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
      }
    }

    if (hasRecovery) {
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

    tradeLog.push({
      epoch: r.epoch,
      won,
      wasContrarian: useContrarian,
      marketState
    });
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
    skippedTrending,
    switchedToConsensus,
    stayedContrarian
  };
}

console.log('🔄 Running adaptive tests...\n\n');

// Test strategies
const strategies = [
  // Baseline
  { name: 'Baseline (Contrarian only)', reverseMomentum: false, skipTrending: false, switchOnBadPerformance: false },

  // Adaptive switching based on performance
  { name: 'Switch to Consensus on bad perf (10 trades)', reverseMomentum: false, skipTrending: false, switchOnBadPerformance: true, badPerformanceLookback: 10 },
  { name: 'Switch to Consensus on bad perf (5 trades)', reverseMomentum: false, skipTrending: false, switchOnBadPerformance: true, badPerformanceLookback: 5 },
  { name: 'Switch to Consensus on bad perf (15 trades)', reverseMomentum: false, skipTrending: false, switchOnBadPerformance: true, badPerformanceLookback: 15 },

  // Combined with reverse momentum
  { name: 'Reverse Momentum + Switch (10 trades)', reverseMomentum: true, skipTrending: false, switchOnBadPerformance: true, badPerformanceLookback: 10 },
  { name: 'Reverse Momentum + Switch (5 trades)', reverseMomentum: true, skipTrending: false, switchOnBadPerformance: true, badPerformanceLookback: 5 },

  // Combined with skip trending
  { name: 'Skip Trending + Switch (10 trades)', reverseMomentum: false, skipTrending: true, switchOnBadPerformance: true, badPerformanceLookback: 10 },

  // All combined
  { name: 'Skip Trending + Reverse + Switch (10)', reverseMomentum: true, skipTrending: true, switchOnBadPerformance: true, badPerformanceLookback: 10 },
  { name: 'Skip Trending + Reverse + Switch (5)', reverseMomentum: true, skipTrending: true, switchOnBadPerformance: true, badPerformanceLookback: 5 }
];

const results = strategies.map(config => runAdaptiveStrategy(rounds, config));

// Display results
console.log('═'.repeat(100) + '\n');
console.log('📊 ADAPTIVE STRATEGY RESULTS\n');
console.log('═'.repeat(100) + '\n');

results.forEach((r, i) => {
  const roiStr = r.roi >= 0 ? `+${r.roi.toFixed(2)}%` : `${r.roi.toFixed(2)}%`;
  console.log(`${(i + 1).toString().padStart(2)}. ${r.name.padEnd(45)} | ${r.trades.toString().padStart(3)} trades | ${r.winRate.toFixed(1).padStart(5)}% WR | ${roiStr.padStart(11)} ROI`);

  if (r.switchedToConsensus > 0) {
    const switchRate = (r.switchedToConsensus / r.trades) * 100;
    console.log(`    Switched to consensus: ${r.switchedToConsensus} times (${switchRate.toFixed(1)}%)`);
  }
  if (r.skippedTrending > 0) {
    console.log(`    Skipped trending: ${r.skippedTrending}`);
  }
  console.log();
});

console.log('═'.repeat(100) + '\n');

// Rank by ROI
const ranked = [...results].sort((a, b) => b.roi - a.roi);

console.log('🏆 TOP 3 ADAPTIVE STRATEGIES:\n');
ranked.slice(0, 3).forEach((r, i) => {
  const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
  const roiStr = r.roi >= 0 ? `+${r.roi.toFixed(2)}%` : `${r.roi.toFixed(2)}%`;
  console.log(`${medal} ${r.name}`);
  console.log(`   ${r.trades} trades | ${r.winRate.toFixed(1)}% WR | ${roiStr} ROI | Final: ${r.finalBankroll.toFixed(4)} BNB`);
  if (r.switchedToConsensus > 0) {
    console.log(`   Switched to consensus ${r.switchedToConsensus} times (${((r.switchedToConsensus/r.trades)*100).toFixed(1)}% of trades)`);
  }
  console.log();
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
  console.log(`  Win Rate: ${baseline.winRate.toFixed(1)}% → ${r.winRate.toFixed(1)}%\n`);
});

console.log('═'.repeat(100) + '\n');

console.log('💡 KEY INSIGHTS:\n');
console.log('─'.repeat(100) + '\n');

const bestAdaptive = ranked[0];
const switchRate = bestAdaptive.switchedToConsensus > 0
  ? ((bestAdaptive.switchedToConsensus / bestAdaptive.trades) * 100).toFixed(1)
  : 0;

console.log(`1. Best Strategy: ${bestAdaptive.name}`);
console.log(`   ${bestAdaptive.roi.toFixed(2)}% ROI (${bestAdaptive.finalBankroll.toFixed(2)} BNB from 1 BNB)\n`);

if (bestAdaptive.switchedToConsensus > 0) {
  console.log(`2. Adaptive switching used ${switchRate}% of the time`);
  console.log(`   This shows the strategy adapts to bad performance by switching modes\n`);
}

console.log(`3. Performance comparison:`);
console.log(`   Without adaptation: ${baseline.roi.toFixed(2)}% ROI`);
console.log(`   With adaptation: ${bestAdaptive.roi.toFixed(2)}% ROI`);
console.log(`   Improvement: ${(bestAdaptive.roi - baseline.roi).toFixed(2)}%\n`);

console.log('═'.repeat(100) + '\n');

db.close();
