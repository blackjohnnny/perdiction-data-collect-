import initSqlJs from 'sql.js';
import fs from 'fs';

const sqlJs = await initSqlJs();
const buf = fs.readFileSync('../data/live-monitor.db');
const db = new sqlJs.Database(buf);

// Get all rounds with T-20s data and settled results
const query = `
  SELECT
    epoch,
    lock_ts,
    lock_price,
    close_price,
    winner,
    t20s_bull_wei,
    t20s_bear_wei,
    t20s_total_wei,
    bull_amount_wei,
    bear_amount_wei,
    total_amount_wei
  FROM rounds
  WHERE t20s_total_wei IS NOT NULL
    AND winner != 'UNKNOWN'
  ORDER BY epoch
`;

const result = db.exec(query);
const rows = result[0].values;

console.log('Fetching EMA data from TradingView...');
const lockTimestamps = rows.map(row => row[1]);
const minLockTs = Math.min(...lockTimestamps);
const maxLockTs = Math.max(...lockTimestamps);
const startTime = minLockTs - 3600;
const endTime = maxLockTs + 3600;

const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.BNB/USD&resolution=5&from=${startTime}&to=${endTime}`;
const response = await globalThis.fetch(url);
const candles = await response.json();

// Calculate EMA 5 and EMA 13
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const emaArray = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    emaArray.push(prices[i] * k + emaArray[i - 1] * (1 - k));
  }
  return emaArray;
}

const closes = candles.c;
const ema5 = calculateEMA(closes, 5);
const ema13 = calculateEMA(closes, 13);

const emaMap = new Map();
for (let i = 0; i < candles.t.length; i++) {
  emaMap.set(candles.t[i], { ema5: ema5[i], ema13: ema13[i], price: closes[i] });
}

// Use best configuration: 65% crowd + 0.10% EMA gap
const CROWD_THRESHOLD = 0.65;
const EMA_GAP_THRESHOLD = 0.10;

const trades = [];

rows.forEach(row => {
  const [epoch, lockTs, lockPrice, closePrice, winner, bullWei, bearWei, totalWei, finalBullWei, finalBearWei, finalTotalWei] = row;

  // T-20s snapshot amounts
  const bullAmount = parseFloat(bullWei) / 1e18;
  const bearAmount = parseFloat(bearWei) / 1e18;
  const totalPool = bullAmount + bearAmount;
  const bullPct = bullAmount / totalPool;
  const bearPct = bearAmount / totalPool;

  // Final amounts
  const finalBull = parseFloat(finalBullWei) / 1e18;
  const finalBear = parseFloat(finalBearWei) / 1e18;

  // Determine T-20s crowd
  let crowd = null;
  if (bullPct >= CROWD_THRESHOLD) crowd = 'UP';
  else if (bearPct >= CROWD_THRESHOLD) crowd = 'DOWN';

  if (!crowd) return;

  // Get EMA signal
  const roundedLockTs = Math.floor(lockTs / 300) * 300;
  const emaData = emaMap.get(roundedLockTs);
  if (!emaData) return;

  const emaSignal = emaData.ema5 > emaData.ema13 ? 'UP' : 'DOWN';

  // Only bet if EMA and crowd agree
  if (emaSignal !== crowd) return;

  // Check EMA gap requirement
  const currentPrice = emaData.price;
  const emaGap = Math.abs(emaData.ema5 - emaData.ema13);
  const gapPercentOfPrice = (emaGap / currentPrice) * 100;

  if (gapPercentOfPrice < EMA_GAP_THRESHOLD) return;

  // Record trade
  const won = (crowd === winner);
  const lockPriceNum = parseFloat(lockPrice) / 1e8;
  const closePriceNum = parseFloat(closePrice) / 1e8;
  const priceChange = ((closePriceNum - lockPriceNum) / lockPriceNum) * 100;
  const actualResult = closePriceNum > lockPriceNum ? 'UP' : 'DOWN';

  // Calculate crowd flip
  const finalBullPct = finalBull / (finalBull + finalBear);
  const finalBearPct = finalBear / (finalBull + finalBear);
  const finalCrowd = finalBullPct > finalBearPct ? 'UP' : 'DOWN';
  const crowdFlipped = crowd !== finalCrowd;

  // Pool change
  const t20sPool = totalPool;
  const finalPool = finalBull + finalBear;
  const poolGrowth = ((finalPool - t20sPool) / t20sPool) * 100;

  trades.push({
    epoch,
    betDirection: crowd,
    winner,
    won,
    priceChange,
    actualResult,
    emaSignal,
    gapPercent: gapPercentOfPrice,
    t20sBullPct: bullPct * 100,
    t20sBearPct: bearPct * 100,
    crowdFlipped,
    poolGrowth,
    lockPrice: lockPriceNum,
    closePrice: closePriceNum,
  });
});

// Analyze wins vs losses
const wins = trades.filter(t => t.won);
const losses = trades.filter(t => !t.won);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('LOSS ANALYSIS: 65% Crowd + 0.10% EMA Gap Strategy');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`Total Trades: ${trades.length}`);
console.log(`Wins: ${wins.length} (${(wins.length / trades.length * 100).toFixed(2)}%)`);
console.log(`Losses: ${losses.length} (${(losses.length / trades.length * 100).toFixed(2)}%)\n`);

console.log('═══════════════════════════════════════════════════════════════');
console.log('WHY DO WE LOSE TRADES?');
console.log('═══════════════════════════════════════════════════════════════\n');

// 1. Price moved against EMA prediction
const lossesWrongDirection = losses.filter(t => t.actualResult !== t.betDirection);
console.log(`1. PRICE MOVED WRONG DIRECTION: ${lossesWrongDirection.length}/${losses.length} losses (${(lossesWrongDirection.length / losses.length * 100).toFixed(1)}%)`);
console.log(`   - We bet ${lossesWrongDirection[0]?.betDirection || 'N/A'} but price went ${lossesWrongDirection[0]?.actualResult || 'N/A'}`);
console.log(`   - EMA predicted wrong direction\n`);

// 2. Crowd flipped during last 20 seconds
const lossesWithCrowdFlip = losses.filter(t => t.crowdFlipped);
console.log(`2. CROWD FLIPPED (T-20s → Close): ${lossesWithCrowdFlip.length}/${losses.length} losses (${(lossesWithCrowdFlip.length / losses.length * 100).toFixed(1)}%)`);
console.log(`   - T-20s crowd changed sides by round close`);
console.log(`   - Late money came in on opposite side\n`);

// 3. Average price change in losses
const avgPriceChangeLoss = losses.reduce((sum, t) => sum + Math.abs(t.priceChange), 0) / losses.length;
const avgPriceChangeWin = wins.reduce((sum, t) => sum + Math.abs(t.priceChange), 0) / wins.length;
console.log(`3. PRICE VOLATILITY:`);
console.log(`   - Avg price change in LOSSES: ${avgPriceChangeLoss.toFixed(3)}%`);
console.log(`   - Avg price change in WINS: ${avgPriceChangeWin.toFixed(3)}%`);
console.log(`   - ${avgPriceChangeLoss > avgPriceChangeWin ? 'Higher volatility in losses' : 'Lower volatility in losses'}\n`);

// 4. EMA gap strength
const avgGapLoss = losses.reduce((sum, t) => sum + t.gapPercent, 0) / losses.length;
const avgGapWin = wins.reduce((sum, t) => sum + t.gapPercent, 0) / wins.length;
console.log(`4. EMA GAP STRENGTH:`);
console.log(`   - Avg EMA gap in LOSSES: ${avgGapLoss.toFixed(3)}%`);
console.log(`   - Avg EMA gap in WINS: ${avgGapWin.toFixed(3)}%`);
console.log(`   - ${avgGapWin > avgGapLoss ? 'Stronger signals win more' : 'Gap strength not predictive'}\n`);

// 5. Pool growth
const avgPoolGrowthLoss = losses.reduce((sum, t) => sum + t.poolGrowth, 0) / losses.length;
const avgPoolGrowthWin = wins.reduce((sum, t) => sum + t.poolGrowth, 0) / wins.length;
console.log(`5. LATE POOL ACTIVITY (T-20s → Close):`);
console.log(`   - Avg pool growth in LOSSES: ${avgPoolGrowthLoss.toFixed(1)}%`);
console.log(`   - Avg pool growth in WINS: ${avgPoolGrowthWin.toFixed(1)}%`);
console.log(`   - ${avgPoolGrowthLoss > avgPoolGrowthWin ? 'More late activity hurts performance' : 'Late activity helps performance'}\n`);

// Show worst losses
console.log('═══════════════════════════════════════════════════════════════');
console.log('10 WORST LOSSES (Biggest Price Moves Against Us):');
console.log('═══════════════════════════════════════════════════════════════\n');

const sortedLosses = losses.sort((a, b) => Math.abs(b.priceChange) - Math.abs(a.priceChange)).slice(0, 10);

console.log('Epoch   | Bet  | Winner | Price Δ   | Crowd Flip | Pool Growth | EMA Gap');
console.log('--------|------|--------|-----------|------------|-------------|--------');

sortedLosses.forEach(t => {
  console.log(
    `${t.epoch} | ${t.betDirection.padEnd(4)} | ${t.winner.padEnd(6)} | ` +
    `${t.priceChange >= 0 ? '+' : ''}${t.priceChange.toFixed(3)}% | ` +
    `${t.crowdFlipped ? 'YES' : 'NO '} `.padEnd(12) + '| ' +
    `${t.poolGrowth >= 0 ? '+' : ''}${t.poolGrowth.toFixed(1)}%`.padEnd(12) + '| ' +
    `${t.gapPercent.toFixed(3)}%`
  );
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('SUMMARY OF LOSS REASONS:');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`Main cause: EMA predicted wrong price direction (${(lossesWrongDirection.length / losses.length * 100).toFixed(1)}% of losses)`);
console.log(`Contributing factor: Crowd flipped (${(lossesWithCrowdFlip.length / losses.length * 100).toFixed(1)}% of losses)`);
console.log(`\nNo strategy can predict 100% - accept ${(losses.length / trades.length * 100).toFixed(1)}% loss rate as normal variance.`);

db.close();
