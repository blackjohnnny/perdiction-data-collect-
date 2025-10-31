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

// Test VERY strict filters to maximize win rate
const crowdThresholds = [0.70, 0.75, 0.80, 0.85];
const emaGaps = [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.60, 0.70, 0.80, 1.0];

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('   MAXIMIZE WIN RATE: Ultra-Strict Filters (6.5% Position Size)');
console.log('═══════════════════════════════════════════════════════════════════\n');

console.log('Strategy: Only take the HIGHEST CONVICTION trades');
console.log('Goal: Minimize losses, maximize win rate, sacrifice trade frequency\n');

const allResults = [];

crowdThresholds.forEach(threshold => {
  emaGaps.forEach(gapPercent => {
    let bankroll = 1.0;
    let wins = 0;
    let losses = 0;
    let totalBets = 0;
    let totalWagered = 0;
    let totalReturned = 0;

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
      const finalTotal = finalBull + finalBear;
      const finalUpPayout = (finalTotal * 0.97) / finalBull;
      const finalDownPayout = (finalTotal * 0.97) / finalBear;

      // Determine T-20s crowd
      let crowd = null;
      if (bullPct >= threshold) crowd = 'UP';
      else if (bearPct >= threshold) crowd = 'DOWN';

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

      if (gapPercentOfPrice < gapPercent) return;

      // Place bet
      const ourBet = crowd;
      const won = (ourBet === winner);
      const betSize = Math.min(bankroll * 0.065, bankroll);

      totalWagered += betSize;
      totalBets++;
      bankroll -= betSize;

      if (won) {
        const payout = ourBet === 'UP' ? finalUpPayout : finalDownPayout;
        const totalReturn = betSize * payout;
        bankroll += totalReturn;
        totalReturned += totalReturn;
        wins++;
      } else {
        losses++;
      }

      if (bankroll > 1000000) bankroll = 1000000;
      if (bankroll < 0.0001) bankroll = 0.0001;
    });

    if (totalBets === 0) return;

    const winRate = (wins / totalBets * 100);
    const edge = ((totalReturned / totalWagered - 1) * 100);
    const roi = ((bankroll - 1) * 100);

    allResults.push({
      threshold,
      gapPercent,
      totalBets,
      wins,
      losses,
      winRate,
      edge,
      roi,
      bankroll
    });
  });
});

// Sort by win rate
const sortedByWinRate = allResults.sort((a, b) => b.winRate - a.winRate);

console.log('═══════════════════════════════════════════════════════════════════');
console.log('TOP 15 CONFIGURATIONS BY WIN RATE:');
console.log('═══════════════════════════════════════════════════════════════════\n');

console.log('Rank | Crowd  | EMA Gap | Bets | Wins | Losses | Win%   | ROI      | Bankroll');
console.log('-----|--------|---------|------|------|--------|--------|----------|----------');

sortedByWinRate.slice(0, 15).forEach((r, i) => {
  console.log(
    `${String(i + 1).padStart(4)} | ` +
    `≥${(r.threshold * 100).toFixed(0)}%`.padEnd(7) + '| ' +
    `≥${r.gapPercent.toFixed(2)}%`.padEnd(8) + '| ' +
    String(r.totalBets).padStart(4) + ' | ' +
    String(r.wins).padStart(4) + ' | ' +
    String(r.losses).padStart(6) + ' | ' +
    `${r.winRate.toFixed(2).padStart(6)}% | ` +
    `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2).padStart(7)}% | ` +
    `${r.bankroll.toFixed(4)} BNB`
  );
});

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('BEST CONFIGURATIONS WITH >65% WIN RATE:');
console.log('═══════════════════════════════════════════════════════════════════\n');

const highWinRate = allResults.filter(r => r.winRate >= 65 && r.totalBets >= 5);

if (highWinRate.length > 0) {
  console.log('Crowd  | EMA Gap | Bets | Wins | Losses | Win%   | ROI      | Bankroll');
  console.log('-------|---------|------|------|--------|--------|----------|----------');

  highWinRate.sort((a, b) => b.roi - a.roi).slice(0, 10).forEach(r => {
    console.log(
      `≥${(r.threshold * 100).toFixed(0)}%`.padEnd(7) + '| ' +
      `≥${r.gapPercent.toFixed(2)}%`.padEnd(8) + '| ' +
      String(r.totalBets).padStart(4) + ' | ' +
      String(r.wins).padStart(4) + ' | ' +
      String(r.losses).padStart(6) + ' | ' +
      `${r.winRate.toFixed(2).padStart(6)}% | ` +
      `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2).padStart(7)}% | ` +
      `${r.bankroll.toFixed(4)} BNB`
    );
  });
} else {
  console.log('No configurations found with >=65% win rate and >=5 trades');
}

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('ANALYSIS: Trade-Off Between Win Rate and Trade Frequency');
console.log('═══════════════════════════════════════════════════════════════════\n');

// Group by trade frequency buckets
const buckets = [
  { min: 50, max: 999, label: '50+ trades' },
  { min: 30, max: 49, label: '30-49 trades' },
  { min: 20, max: 29, label: '20-29 trades' },
  { min: 10, max: 19, label: '10-19 trades' },
  { min: 5, max: 9, label: '5-9 trades' },
  { min: 1, max: 4, label: '1-4 trades' },
];

console.log('Trade Count | Best Win%  | Best ROI   | Config');
console.log('------------|------------|------------|--------------------------------');

buckets.forEach(bucket => {
  const inBucket = allResults.filter(r => r.totalBets >= bucket.min && r.totalBets <= bucket.max);
  if (inBucket.length === 0) return;

  const bestWinRate = inBucket.sort((a, b) => b.winRate - a.winRate)[0];
  const bestROI = inBucket.sort((a, b) => b.roi - a.roi)[0];

  console.log(
    bucket.label.padEnd(12) + '| ' +
    `${bestWinRate.winRate.toFixed(2)}%`.padEnd(11) + '| ' +
    `${bestROI.roi >= 0 ? '+' : ''}${bestROI.roi.toFixed(2)}%`.padEnd(11) + '| ' +
    `≥${(bestROI.threshold * 100).toFixed(0)}% crowd, ≥${bestROI.gapPercent.toFixed(2)}% gap (${bestROI.totalBets} trades)`
  );
});

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('RECOMMENDATION:');
console.log('═══════════════════════════════════════════════════════════════════\n');

const bestOverall = sortedByWinRate.filter(r => r.totalBets >= 10 && r.roi > 0).sort((a, b) => b.winRate - a.winRate)[0];

if (bestOverall) {
  console.log(`To maximize win rate with meaningful trade count:`);
  console.log(`  Crowd Threshold: ≥${(bestOverall.threshold * 100).toFixed(0)}%`);
  console.log(`  EMA Gap: ≥${bestOverall.gapPercent.toFixed(2)}%`);
  console.log(`  Trade Count: ${bestOverall.totalBets}`);
  console.log(`  Win Rate: ${bestOverall.winRate.toFixed(2)}%`);
  console.log(`  Loss Rate: ${((bestOverall.losses / bestOverall.totalBets) * 100).toFixed(2)}%`);
  console.log(`  ROI: ${bestOverall.roi >= 0 ? '+' : ''}${bestOverall.roi.toFixed(2)}%`);
  console.log(`\n  This configuration reduces losses from 30 to ${bestOverall.losses} trades.`);
}

db.close();
