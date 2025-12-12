import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🎯 FAKEOUT ANALYSIS: Are we buying at local tops/bottoms?\n');
console.log('═'.repeat(80) + '\n');

const db = initDatabase(DB_PATH);

// Get all complete rounds with price data
const rounds = db.prepare(`
  SELECT
    sample_id,
    epoch,
    lock_timestamp,
    t20s_bull_wei,
    t20s_bear_wei,
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

console.log(`📊 Found ${rounds.length} complete rounds\n`);

// Strategy constants
const EMA_GAP_THRESHOLD = 0.05;
const PAYOUT_THRESHOLD = 1.45;
const MOMENTUM_THRESHOLD = 0.15;
const BASE_SIZE = 0.045;
const MOMENTUM_SIZE = 0.085;
const RECOVERY_MULTIPLIER = 1.5;

// Helper function: Detect local top/bottom
// A local top = price goes up then down (reversal after our BULL entry)
// A local bottom = price goes down then up (reversal after our BEAR entry)
function isLocalExtreme(rounds, index, direction) {
  if (index < 2 || index >= rounds.length - 2) return { isFakeout: false, type: 'N/A' };

  const prices = [];
  for (let i = index - 2; i <= Math.min(index + 2, rounds.length - 1); i++) {
    prices.push(Number(rounds[i].lock_price) / 1e8);
  }

  const entryPrice = prices[2]; // Current round (index in local window)
  const prevPrice = prices[1];
  const prev2Price = prices[0];

  // Check if we have next prices
  const hasNext = index < rounds.length - 1;
  const hasNext2 = index < rounds.length - 2;

  const nextPrice = hasNext ? prices[3] : null;
  const next2Price = hasNext2 ? prices[4] : null;

  if (direction === 'bull') {
    // We bought BULL expecting price to go UP
    // Fakeout = price was rising but then immediately reverses DOWN

    // Check if we entered during upward movement
    const risingIntoEntry = entryPrice > prevPrice && prevPrice >= prev2Price;

    // Check if price reversed down after entry
    const reversedDown = hasNext && nextPrice < entryPrice;
    const continuedDown = hasNext2 && next2Price < nextPrice;

    if (risingIntoEntry && reversedDown) {
      return {
        isFakeout: true,
        type: 'LOCAL_TOP',
        severity: continuedDown ? 'STRONG' : 'WEAK',
        entryPrice,
        nextPrice,
        priceChange: ((nextPrice - entryPrice) / entryPrice) * 100
      };
    }

  } else if (direction === 'bear') {
    // We bought BEAR expecting price to go DOWN
    // Fakeout = price was falling but then immediately reverses UP

    // Check if we entered during downward movement
    const fallingIntoEntry = entryPrice < prevPrice && prevPrice <= prev2Price;

    // Check if price reversed up after entry
    const reversedUp = hasNext && nextPrice > entryPrice;
    const continuedUp = hasNext2 && next2Price > nextPrice;

    if (fallingIntoEntry && reversedUp) {
      return {
        isFakeout: true,
        type: 'LOCAL_BOTTOM',
        severity: continuedUp ? 'STRONG' : 'WEAK',
        entryPrice,
        nextPrice,
        priceChange: ((nextPrice - entryPrice) / entryPrice) * 100
      };
    }
  }

  return { isFakeout: false, type: 'CONTINUATION' };
}

// Analyze all trades
let totalTrades = 0;
let fakeoutTrades = 0;
let localTopFakeouts = 0;
let localBottomFakeouts = 0;
let strongFakeouts = 0;
let weakFakeouts = 0;

let fakeoutWins = 0;
let fakeoutLosses = 0;
let nonFakeoutWins = 0;
let nonFakeoutLosses = 0;

const tradeDetails = [];

for (let i = 0; i < rounds.length; i++) {
  const round = rounds[i];
  const emaGap = round.ema_gap;

  // Check if we would trade
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

  totalTrades++;

  // Check if this is a local extreme
  const fakeoutAnalysis = isLocalExtreme(rounds, i, signal);

  const won = round.winner === signal;

  if (fakeoutAnalysis.isFakeout) {
    fakeoutTrades++;

    if (fakeoutAnalysis.type === 'LOCAL_TOP') localTopFakeouts++;
    if (fakeoutAnalysis.type === 'LOCAL_BOTTOM') localBottomFakeouts++;

    if (fakeoutAnalysis.severity === 'STRONG') strongFakeouts++;
    if (fakeoutAnalysis.severity === 'WEAK') weakFakeouts++;

    if (won) fakeoutWins++;
    else fakeoutLosses++;

    tradeDetails.push({
      epoch: round.epoch,
      signal,
      fakeout: true,
      type: fakeoutAnalysis.type,
      severity: fakeoutAnalysis.severity,
      won,
      priceChange: fakeoutAnalysis.priceChange,
      payout: round.winner_payout_multiple
    });

  } else {
    if (won) nonFakeoutWins++;
    else nonFakeoutLosses++;

    tradeDetails.push({
      epoch: round.epoch,
      signal,
      fakeout: false,
      type: fakeoutAnalysis.type,
      won,
      payout: round.winner_payout_multiple
    });
  }
}

console.log('📊 FAKEOUT STATISTICS\n');
console.log('═'.repeat(80) + '\n');

console.log(`Total Trades: ${totalTrades}`);
console.log(`Fakeout Trades: ${fakeoutTrades} (${(fakeoutTrades/totalTrades*100).toFixed(2)}%)`);
console.log(`Non-Fakeout Trades: ${totalTrades - fakeoutTrades} (${((totalTrades-fakeoutTrades)/totalTrades*100).toFixed(2)}%)\n`);

console.log('🎯 Fakeout Breakdown:\n');
console.log(`  Local TOP fakeouts (BULL entries): ${localTopFakeouts} (${(localTopFakeouts/fakeoutTrades*100).toFixed(1)}% of fakeouts)`);
console.log(`  Local BOTTOM fakeouts (BEAR entries): ${localBottomFakeouts} (${(localBottomFakeouts/fakeoutTrades*100).toFixed(1)}% of fakeouts)\n`);

console.log(`  Strong reversals: ${strongFakeouts} (${(strongFakeouts/fakeoutTrades*100).toFixed(1)}% of fakeouts)`);
console.log(`  Weak reversals: ${weakFakeouts} (${(weakFakeouts/fakeoutTrades*100).toFixed(1)}% of fakeouts)\n`);

console.log('═'.repeat(80) + '\n');

console.log('📈 PERFORMANCE COMPARISON\n');
console.log('═'.repeat(80) + '\n');

const fakeoutWinRate = fakeoutTrades > 0 ? (fakeoutWins / fakeoutTrades * 100) : 0;
const nonFakeoutWinRate = (totalTrades - fakeoutTrades) > 0 ? (nonFakeoutWins / (totalTrades - fakeoutTrades) * 100) : 0;

console.log('🚨 FAKEOUT Trades (entering at local extremes):');
console.log(`   Trades: ${fakeoutTrades}`);
console.log(`   Wins: ${fakeoutWins}`);
console.log(`   Losses: ${fakeoutLosses}`);
console.log(`   Win Rate: ${fakeoutWinRate.toFixed(2)}%\n`);

console.log('✅ NON-FAKEOUT Trades (continuation patterns):');
console.log(`   Trades: ${totalTrades - fakeoutTrades}`);
console.log(`   Wins: ${nonFakeoutWins}`);
console.log(`   Losses: ${nonFakeoutLosses}`);
console.log(`   Win Rate: ${nonFakeoutWinRate.toFixed(2)}%\n`);

const winRateDiff = nonFakeoutWinRate - fakeoutWinRate;

console.log('📊 Win Rate Difference:');
console.log(`   ${winRateDiff >= 0 ? '+' : ''}${winRateDiff.toFixed(2)}% (non-fakeout vs fakeout)`);
console.log(`   ${winRateDiff > 0 ? '✅ Non-fakeouts perform BETTER' : '❌ Fakeouts perform BETTER'}\n`);

console.log('═'.repeat(80) + '\n');

// Analyze by fakeout type
console.log('🔍 DETAILED FAKEOUT ANALYSIS\n');
console.log('═'.repeat(80) + '\n');

const localTopTrades = tradeDetails.filter(t => t.type === 'LOCAL_TOP');
const localBottomTrades = tradeDetails.filter(t => t.type === 'LOCAL_BOTTOM');
const strongFakeoutTrades = tradeDetails.filter(t => t.severity === 'STRONG');
const weakFakeoutTrades = tradeDetails.filter(t => t.severity === 'WEAK');

if (localTopTrades.length > 0) {
  const topWins = localTopTrades.filter(t => t.won).length;
  const topWinRate = (topWins / localTopTrades.length * 100);
  const avgPriceChange = localTopTrades.reduce((sum, t) => sum + (t.priceChange || 0), 0) / localTopTrades.length;

  console.log('📈 LOCAL TOP Entries (BULL at peak):');
  console.log(`   Count: ${localTopTrades.length}`);
  console.log(`   Win Rate: ${topWinRate.toFixed(2)}%`);
  console.log(`   Avg Price Change After Entry: ${avgPriceChange.toFixed(4)}%`);
  console.log(`   Expected: Price should go UP (we bought BULL)`);
  console.log(`   Reality: Price went DOWN (fakeout)\n`);
}

if (localBottomTrades.length > 0) {
  const bottomWins = localBottomTrades.filter(t => t.won).length;
  const bottomWinRate = (bottomWins / localBottomTrades.length * 100);
  const avgPriceChange = localBottomTrades.reduce((sum, t) => sum + (t.priceChange || 0), 0) / localBottomTrades.length;

  console.log('📉 LOCAL BOTTOM Entries (BEAR at trough):');
  console.log(`   Count: ${localBottomTrades.length}`);
  console.log(`   Win Rate: ${bottomWinRate.toFixed(2)}%`);
  console.log(`   Avg Price Change After Entry: ${avgPriceChange.toFixed(4)}%`);
  console.log(`   Expected: Price should go DOWN (we bought BEAR)`);
  console.log(`   Reality: Price went UP (fakeout)\n`);
}

if (strongFakeoutTrades.length > 0) {
  const strongWins = strongFakeoutTrades.filter(t => t.won).length;
  const strongWinRate = (strongWins / strongFakeoutTrades.length * 100);

  console.log('💥 STRONG Reversals (2+ candles):');
  console.log(`   Count: ${strongFakeoutTrades.length}`);
  console.log(`   Win Rate: ${strongWinRate.toFixed(2)}%`);
  console.log(`   Impact: Severe - price continues reversing\n`);
}

if (weakFakeoutTrades.length > 0) {
  const weakWins = weakFakeoutTrades.filter(t => t.won).length;
  const weakWinRate = (weakWins / weakFakeoutTrades.length * 100);

  console.log('💨 WEAK Reversals (1 candle):');
  console.log(`   Count: ${weakFakeoutTrades.length}`);
  console.log(`   Win Rate: ${weakWinRate.toFixed(2)}%`);
  console.log(`   Impact: Mild - price reverses briefly\n`);
}

console.log('═'.repeat(80) + '\n');

// Market condition analysis
console.log('🔬 FAKEOUT RATE BY MARKET CONDITION\n');
console.log('═'.repeat(80) + '\n');

// Calculate market condition for each trade (simplified - use slope)
const LOOKBACK = 12;

let rangingFakeouts = 0;
let rangingTotal = 0;
let trendingFakeouts = 0;
let trendingTotal = 0;

for (let i = LOOKBACK; i < rounds.length; i++) {
  const round = rounds[i];
  const emaGap = round.ema_gap;

  if (Math.abs(emaGap) < EMA_GAP_THRESHOLD) continue;

  const signal = emaGap > 0 ? 'bull' : 'bear';

  const bullWei = BigInt(round.t20s_bull_wei);
  const bearWei = BigInt(round.t20s_bear_wei);
  const totalWei = bullWei + bearWei;
  const ourSideWei = signal === 'bull' ? bullWei : bearWei;
  const estPayout = Number(totalWei) / Number(ourSideWei);

  if (estPayout < PAYOUT_THRESHOLD) continue;

  // Calculate slope
  const window = rounds.slice(i - LOOKBACK, i);
  const prices = window.map(r => Number(r.lock_price) / 1e8);
  const n = prices.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

  for (let j = 0; j < n; j++) {
    sumX += j;
    sumY += prices[j];
    sumXY += j * prices[j];
    sumX2 += j * j;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const avgPrice = sumY / n;
  const slopePercent = (slope / avgPrice) * 100;

  const isRanging = Math.abs(slopePercent) < 0.03;

  const fakeoutAnalysis = isLocalExtreme(rounds, i, signal);

  if (isRanging) {
    rangingTotal++;
    if (fakeoutAnalysis.isFakeout) rangingFakeouts++;
  } else {
    trendingTotal++;
    if (fakeoutAnalysis.isFakeout) trendingFakeouts++;
  }
}

const rangingFakeoutRate = rangingTotal > 0 ? (rangingFakeouts / rangingTotal * 100) : 0;
const trendingFakeoutRate = trendingTotal > 0 ? (trendingFakeouts / trendingTotal * 100) : 0;

console.log(`📉 RANGING Markets:`);
console.log(`   Total Trades: ${rangingTotal}`);
console.log(`   Fakeouts: ${rangingFakeouts}`);
console.log(`   Fakeout Rate: ${rangingFakeoutRate.toFixed(2)}%\n`);

console.log(`📈 TRENDING Markets:`);
console.log(`   Total Trades: ${trendingTotal}`);
console.log(`   Fakeouts: ${trendingFakeouts}`);
console.log(`   Fakeout Rate: ${trendingFakeoutRate.toFixed(2)}%\n`);

console.log(`More fakeouts in: ${rangingFakeoutRate > trendingFakeoutRate ? 'RANGING 📉' : 'TRENDING 📈'} markets`);

console.log('\n' + '═'.repeat(80) + '\n');

// Conclusion
console.log('💡 KEY FINDINGS\n');

const fakeoutPercentage = (fakeoutTrades / totalTrades * 100).toFixed(1);

if (fakeoutTrades / totalTrades > 0.3) {
  console.log(`❌ HIGH FAKEOUT RATE: ${fakeoutPercentage}% of trades are at local extremes`);
  console.log(`   This suggests we ARE getting faked out frequently.\n`);
} else {
  console.log(`✅ MODERATE FAKEOUT RATE: ${fakeoutPercentage}% of trades are at local extremes`);
  console.log(`   This is within acceptable range.\n`);
}

if (fakeoutWinRate < nonFakeoutWinRate - 5) {
  console.log(`❌ IMPACT: Fakeouts HURT performance`);
  console.log(`   Win rate drops ${(nonFakeoutWinRate - fakeoutWinRate).toFixed(2)}% when entering at extremes\n`);
  console.log(`💡 RECOMMENDATION: Add filter to avoid local tops/bottoms`);
} else if (fakeoutWinRate > nonFakeoutWinRate + 5) {
  console.log(`✅ SURPRISING: Fakeouts actually HELP performance`);
  console.log(`   Win rate increases ${(fakeoutWinRate - nonFakeoutWinRate).toFixed(2)}% at extremes\n`);
  console.log(`💡 RECOMMENDATION: Current strategy handles reversals well`);
} else {
  console.log(`➡️ NEUTRAL: Fakeouts have minimal impact on performance`);
  console.log(`   Win rate difference: ${(nonFakeoutWinRate - fakeoutWinRate).toFixed(2)}%\n`);
  console.log(`💡 RECOMMENDATION: No changes needed`);
}

console.log('\n' + '═'.repeat(80) + '\n');

db.close();
