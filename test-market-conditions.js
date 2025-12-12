import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n📊 MARKET CONDITION ANALYSIS: RANGING vs TRENDING\n');
console.log('═'.repeat(80) + '\n');

const db = initDatabase(DB_PATH);

// Get all complete rounds with EMA data
const rounds = db.prepare(`
  SELECT
    sample_id,
    epoch,
    lock_timestamp,
    t20s_bull_wei,
    t20s_bear_wei,
    lock_bull_wei,
    lock_bear_wei,
    lock_price,
    close_price,
    winner,
    winner_payout_multiple,
    ema_gap
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_gap IS NOT NULL
    AND lock_price IS NOT NULL
    AND close_price IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Found ${rounds.length} complete rounds with all data\n`);

// Calculate market condition indicators for each round
// We'll look at a window of recent rounds to classify the market

const LOOKBACK_WINDOW = 12; // Look back 12 rounds (1 hour on 5min chart)

function calculateMarketCondition(rounds, index) {
  if (index < LOOKBACK_WINDOW) return null; // Not enough history

  const window = rounds.slice(index - LOOKBACK_WINDOW, index);

  // Extract lock prices for the window
  const prices = window.map(r => Number(r.lock_price) / 1e8);

  // Method 1: ADX-like - Average Directional Movement
  // Calculate price changes
  let upMoves = 0;
  let downMoves = 0;
  let totalMoves = 0;

  for (let i = 1; i < prices.length; i++) {
    const change = Math.abs(prices[i] - prices[i-1]);
    totalMoves += change;

    if (prices[i] > prices[i-1]) {
      upMoves += change;
    } else {
      downMoves += change;
    }
  }

  // Directional movement ratio
  const avgMove = totalMoves / (prices.length - 1);
  const directionalStrength = Math.abs(upMoves - downMoves) / totalMoves;

  // Method 2: Price Range vs Movement
  const highest = Math.max(...prices);
  const lowest = Math.min(...prices);
  const range = highest - lowest;
  const avgPrice = prices.reduce((a, b) => a + b) / prices.length;
  const rangePercent = (range / avgPrice) * 100;

  // Method 3: Linear Regression Slope
  const n = prices.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += prices[i];
    sumXY += i * prices[i];
    sumX2 += i * i;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const slopePercent = (slope / avgPrice) * 100;

  // Method 4: Price oscillation (how much it bounces)
  let reversals = 0;
  for (let i = 2; i < prices.length; i++) {
    const prev = prices[i-2];
    const curr = prices[i-1];
    const next = prices[i];

    // Check for local peak or trough
    if ((curr > prev && curr > next) || (curr < prev && curr < next)) {
      reversals++;
    }
  }

  const reversalRate = reversals / (prices.length - 2);

  // Method 5: EMA Gap Volatility
  const emaGaps = window.map(r => Math.abs(r.ema_gap));
  const avgEmaGap = emaGaps.reduce((a, b) => a + b) / emaGaps.length;
  const emaGapStd = Math.sqrt(
    emaGaps.reduce((sum, val) => sum + Math.pow(val - avgEmaGap, 2), 0) / emaGaps.length
  );

  return {
    directionalStrength,    // Higher = trending
    rangePercent,           // Range size
    slopePercent,          // Trend direction strength
    reversalRate,          // Higher = ranging (more oscillation)
    avgMove,               // Average price movement
    avgEmaGap,             // Average EMA separation
    emaGapStd,             // EMA gap volatility
    avgPrice
  };
}

// Classify each round and test multiple methods
const classified = [];

for (let i = 0; i < rounds.length; i++) {
  const condition = calculateMarketCondition(rounds, i);

  if (condition) {
    classified.push({
      round: rounds[i],
      condition,
      index: i
    });
  }
}

console.log(`📈 Classified ${classified.length} rounds with market conditions\n`);

// Test different classification methods
const methods = [
  {
    name: 'Method 1: Directional Strength',
    classify: (c) => c.directionalStrength > 0.4 ? 'trending' : 'ranging',
    threshold: 0.4
  },
  {
    name: 'Method 2: High Reversals',
    classify: (c) => c.reversalRate > 0.35 ? 'ranging' : 'trending',
    threshold: 0.35
  },
  {
    name: 'Method 3: Range % + Reversals',
    classify: (c) => (c.rangePercent < 0.4 || c.reversalRate > 0.35) ? 'ranging' : 'trending',
    threshold: 'combined'
  },
  {
    name: 'Method 4: Slope Strength',
    classify: (c) => Math.abs(c.slopePercent) > 0.03 ? 'trending' : 'ranging',
    threshold: 0.03
  },
  {
    name: 'Method 5: EMA Gap Consistency',
    classify: (c) => (c.avgEmaGap > 0.15 && c.emaGapStd < 0.1) ? 'trending' : 'ranging',
    threshold: 'combined'
  }
];

// Constants for strategy testing
const STARTING_BANKROLL = 1.0;
const EMA_GAP_THRESHOLD = 0.05;
const PAYOUT_THRESHOLD = 1.45;
const MOMENTUM_THRESHOLD = 0.15;
const BASE_SIZE = 0.045;
const MOMENTUM_SIZE = 0.085;
const RECOVERY_MULTIPLIER = 1.5;
const PROFIT_TAKING_SIZE = 0.045;

function testStrategy(rounds) {
  let bankroll = STARTING_BANKROLL;
  let wins = 0;
  let losses = 0;
  let totalTrades = 0;
  let lastTwoResults = [];
  let maxBankroll = STARTING_BANKROLL;
  let maxDrawdown = 0;

  for (const round of rounds) {
    const emaGap = round.ema_gap;

    // Check EMA signal
    if (Math.abs(emaGap) < EMA_GAP_THRESHOLD) continue;

    const signal = emaGap > 0 ? 'bull' : 'bear';

    // Calculate estimated payout at T-20s
    const bullWei = BigInt(round.t20s_bull_wei);
    const bearWei = BigInt(round.t20s_bear_wei);
    const totalWei = bullWei + bearWei;
    const ourSideWei = signal === 'bull' ? bullWei : bearWei;
    const estPayout = Number(totalWei) / Number(ourSideWei);

    // Payout filter
    if (estPayout < PAYOUT_THRESHOLD) continue;

    // Calculate bet size with dynamic positioning
    const hasMomentum = Math.abs(emaGap) > MOMENTUM_THRESHOLD;
    const lastResult = lastTwoResults[0];
    const profitTakingNext = lastTwoResults.length === 2 &&
                              lastTwoResults[0] === 'WIN' &&
                              lastTwoResults[1] === 'WIN';

    let betSize;
    if (profitTakingNext) {
      betSize = bankroll * PROFIT_TAKING_SIZE;
    } else if (lastResult === 'LOSS') {
      if (hasMomentum) {
        betSize = bankroll * MOMENTUM_SIZE * RECOVERY_MULTIPLIER;
      } else {
        betSize = bankroll * BASE_SIZE * RECOVERY_MULTIPLIER;
      }
    } else if (hasMomentum) {
      betSize = bankroll * MOMENTUM_SIZE;
    } else {
      betSize = bankroll * BASE_SIZE;
    }

    // Execute trade
    const won = round.winner === signal;

    if (won) {
      const profit = betSize * (round.winner_payout_multiple - 1);
      bankroll += profit;
      wins++;
      lastTwoResults.unshift('WIN');
    } else {
      bankroll -= betSize;
      losses++;
      lastTwoResults.unshift('LOSS');
    }

    if (lastTwoResults.length > 2) lastTwoResults.pop();
    totalTrades++;

    // Track drawdown
    maxBankroll = Math.max(maxBankroll, bankroll);
    const drawdown = ((maxBankroll - bankroll) / maxBankroll) * 100;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const roi = ((bankroll - STARTING_BANKROLL) / STARTING_BANKROLL) * 100;

  return {
    trades: totalTrades,
    wins,
    losses,
    winRate,
    finalBankroll: bankroll,
    roi,
    maxDrawdown
  };
}

console.log('🧪 TESTING CLASSIFICATION METHODS\n');
console.log('═'.repeat(80) + '\n');

const methodResults = [];

for (const method of methods) {
  console.log(`📊 ${method.name}`);
  console.log(`   Threshold: ${method.threshold}\n`);

  // Classify rounds
  const ranging = [];
  const trending = [];

  for (const item of classified) {
    const type = method.classify(item.condition);

    if (type === 'ranging') {
      ranging.push(item.round);
    } else {
      trending.push(item.round);
    }
  }

  console.log(`   Ranging markets: ${ranging.length} rounds (${(ranging.length/classified.length*100).toFixed(1)}%)`);
  console.log(`   Trending markets: ${trending.length} rounds (${(trending.length/classified.length*100).toFixed(1)}%)\n`);

  // Test strategy on each market type
  const rangingResults = testStrategy(ranging);
  const trendingResults = testStrategy(trending);

  console.log(`   📉 RANGING Market Performance:`);
  console.log(`      Trades: ${rangingResults.trades}`);
  console.log(`      Win Rate: ${rangingResults.winRate.toFixed(2)}%`);
  console.log(`      ROI: ${rangingResults.roi >= 0 ? '+' : ''}${rangingResults.roi.toFixed(2)}%`);
  console.log(`      Final: ${rangingResults.finalBankroll.toFixed(4)} BNB`);
  console.log(`      Max DD: ${rangingResults.maxDrawdown.toFixed(2)}%\n`);

  console.log(`   📈 TRENDING Market Performance:`);
  console.log(`      Trades: ${trendingResults.trades}`);
  console.log(`      Win Rate: ${trendingResults.winRate.toFixed(2)}%`);
  console.log(`      ROI: ${trendingResults.roi >= 0 ? '+' : ''}${trendingResults.roi.toFixed(2)}%`);
  console.log(`      Final: ${trendingResults.finalBankroll.toFixed(4)} BNB`);
  console.log(`      Max DD: ${trendingResults.maxDrawdown.toFixed(2)}%\n`);

  const winRateDiff = trendingResults.winRate - rangingResults.winRate;
  const roiDiff = trendingResults.roi - rangingResults.roi;

  console.log(`   📊 Performance Difference:`);
  console.log(`      Win Rate Δ: ${winRateDiff >= 0 ? '+' : ''}${winRateDiff.toFixed(2)}% (trending vs ranging)`);
  console.log(`      ROI Δ: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}%`);
  console.log(`      Better in: ${trendingResults.winRate > rangingResults.winRate ? 'TRENDING 📈' : 'RANGING 📉'}\n`);

  console.log('─'.repeat(80) + '\n');

  methodResults.push({
    method: method.name,
    rangingCount: ranging.length,
    trendingCount: trending.length,
    rangingResults,
    trendingResults,
    winRateDiff,
    roiDiff,
    accuracy: Math.abs(winRateDiff) // Higher difference = better classification
  });
}

// Find best classification method
console.log('═'.repeat(80) + '\n');
console.log('🏆 BEST CLASSIFICATION METHOD\n');

const bestMethod = methodResults.reduce((best, current) =>
  current.accuracy > best.accuracy ? current : best
);

console.log(`Best Method: ${bestMethod.method}`);
console.log(`Differentiates markets with ${bestMethod.accuracy.toFixed(2)}% win rate difference\n`);

console.log(`📉 RANGING Markets:`);
console.log(`   Rounds: ${bestMethod.rangingCount}`);
console.log(`   Win Rate: ${bestMethod.rangingResults.winRate.toFixed(2)}%`);
console.log(`   ROI: ${bestMethod.rangingResults.roi >= 0 ? '+' : ''}${bestMethod.rangingResults.roi.toFixed(2)}%`);
console.log(`   Final: ${bestMethod.rangingResults.finalBankroll.toFixed(4)} BNB\n`);

console.log(`📈 TRENDING Markets:`);
console.log(`   Rounds: ${bestMethod.trendingCount}`);
console.log(`   Win Rate: ${bestMethod.trendingResults.winRate.toFixed(2)}%`);
console.log(`   ROI: ${bestMethod.trendingResults.roi >= 0 ? '+' : ''}${bestMethod.trendingResults.roi.toFixed(2)}%`);
console.log(`   Final: ${bestMethod.trendingResults.finalBankroll.toFixed(4)} BNB\n`);

console.log('═'.repeat(80) + '\n');

// Summary statistics
console.log('📊 SUMMARY STATISTICS\n');

console.log('All Methods Average Performance:\n');

const avgRangingWinRate = methodResults.reduce((sum, m) => sum + m.rangingResults.winRate, 0) / methodResults.length;
const avgTrendingWinRate = methodResults.reduce((sum, m) => sum + m.trendingResults.winRate, 0) / methodResults.length;
const avgRangingROI = methodResults.reduce((sum, m) => sum + m.rangingResults.roi, 0) / methodResults.length;
const avgTrendingROI = methodResults.reduce((sum, m) => sum + m.trendingResults.roi, 0) / methodResults.length;

console.log(`Average Ranging Win Rate: ${avgRangingWinRate.toFixed(2)}%`);
console.log(`Average Trending Win Rate: ${avgTrendingWinRate.toFixed(2)}%`);
console.log(`Average Ranging ROI: ${avgRangingROI >= 0 ? '+' : ''}${avgRangingROI.toFixed(2)}%`);
console.log(`Average Trending ROI: ${avgTrendingROI >= 0 ? '+' : ''}${avgTrendingROI.toFixed(2)}%\n`);

console.log(`Strategy performs better in: ${avgTrendingWinRate > avgRangingWinRate ? 'TRENDING 📈 markets' : 'RANGING 📉 markets'}\n`);

console.log('═'.repeat(80) + '\n');

db.close();
