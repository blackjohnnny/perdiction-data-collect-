import initSqlJs from 'sql.js';
import fs from 'fs';

const sqlJs = await initSqlJs();
const buf = fs.readFileSync('../data/live-monitor.db');
const db = new sqlJs.Database(buf);

const query = `
  SELECT
    epoch,
    lock_ts,
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

// Best configuration: 65% crowd + 0.10% EMA gap
const CROWD_THRESHOLD = 0.65;
const EMA_GAP_THRESHOLD = 0.10;

// Time buckets (UTC)
const timeStats = {};
for (let hour = 0; hour < 24; hour++) {
  timeStats[hour] = {
    hour,
    wins: 0,
    losses: 0,
    totalBets: 0,
    totalWagered: 0,
    totalReturned: 0,
    bankroll: 1.0
  };
}

rows.forEach(row => {
  const [epoch, lockTs, winner, bullWei, bearWei, totalWei, finalBullWei, finalBearWei, finalTotalWei] = row;

  // Get hour (UTC)
  const date = new Date(lockTs * 1000);
  const hour = date.getUTCHours();

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

  // Record trade for this hour
  const won = (crowd === winner);
  const betSize = timeStats[hour].bankroll * 0.065;

  timeStats[hour].totalBets++;
  timeStats[hour].totalWagered += betSize;
  timeStats[hour].bankroll -= betSize;

  if (won) {
    const payout = crowd === 'UP' ? finalUpPayout : finalDownPayout;
    const totalReturn = betSize * payout;
    timeStats[hour].bankroll += totalReturn;
    timeStats[hour].totalReturned += totalReturn;
    timeStats[hour].wins++;
  } else {
    timeStats[hour].losses++;
  }
});

// Convert to array and calculate metrics
const hourlyResults = Object.values(timeStats)
  .filter(h => h.totalBets > 0)
  .map(h => ({
    hour: h.hour,
    totalBets: h.totalBets,
    wins: h.wins,
    losses: h.losses,
    winRate: (h.wins / h.totalBets) * 100,
    roi: ((h.bankroll - 1) * 100),
    bankroll: h.bankroll
  }))
  .sort((a, b) => b.winRate - a.winRate);

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('   TIME OF DAY ANALYSIS: 65% Crowd + 0.10% EMA Gap');
console.log('═══════════════════════════════════════════════════════════════════\n');

console.log('Best configuration tested across 24 hours (UTC time)\n');

console.log('═══════════════════════════════════════════════════════════════════');
console.log('TOP 10 BEST HOURS (By Win Rate):');
console.log('═══════════════════════════════════════════════════════════════════\n');

console.log('Hour (UTC) | Trades | Wins | Losses | Win Rate | ROI      | Bankroll');
console.log('-----------|--------|------|--------|----------|----------|----------');

hourlyResults.slice(0, 10).forEach(h => {
  const hourLabel = `${String(h.hour).padStart(2, '0')}:00-${String(h.hour + 1).padStart(2, '0')}:00`;
  console.log(
    `${hourLabel}  | ${String(h.totalBets).padStart(6)} | ` +
    `${String(h.wins).padStart(4)} | ${String(h.losses).padStart(6)} | ` +
    `${h.winRate.toFixed(2).padStart(8)}% | ` +
    `${h.roi >= 0 ? '+' : ''}${h.roi.toFixed(2).padStart(7)}% | ` +
    `${h.bankroll.toFixed(4)} BNB`
  );
});

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('WORST 5 HOURS (By Win Rate):');
console.log('═══════════════════════════════════════════════════════════════════\n');

console.log('Hour (UTC) | Trades | Wins | Losses | Win Rate | ROI      | Bankroll');
console.log('-----------|--------|------|--------|----------|----------|----------');

hourlyResults.slice(-5).reverse().forEach(h => {
  const hourLabel = `${String(h.hour).padStart(2, '0')}:00-${String(h.hour + 1).padStart(2, '0')}:00`;
  console.log(
    `${hourLabel}  | ${String(h.totalBets).padStart(6)} | ` +
    `${String(h.wins).padStart(4)} | ${String(h.losses).padStart(6)} | ` +
    `${h.winRate.toFixed(2).padStart(8)}% | ` +
    `${h.roi >= 0 ? '+' : ''}${h.roi.toFixed(2).padStart(7)}% | ` +
    `${h.bankroll.toFixed(4)} BNB`
  );
});

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('COMPLETE 24-HOUR BREAKDOWN:');
console.log('═══════════════════════════════════════════════════════════════════\n');

// Sort by hour
const byHour = hourlyResults.sort((a, b) => a.hour - b.hour);

console.log('Hour (UTC) | Trades | Wins | Losses | Win Rate | ROI');
console.log('-----------|--------|------|--------|----------|----------');

byHour.forEach(h => {
  const hourLabel = `${String(h.hour).padStart(2, '0')}:00-${String(h.hour + 1).padStart(2, '0')}:00`;
  const winRateColor = h.winRate >= 60 ? '✅' : h.winRate <= 50 ? '❌' : '  ';
  console.log(
    `${hourLabel}  | ${String(h.totalBets).padStart(6)} | ` +
    `${String(h.wins).padStart(4)} | ${String(h.losses).padStart(6)} | ` +
    `${h.winRate.toFixed(2).padStart(8)}% ${winRateColor} | ` +
    `${h.roi >= 0 ? '+' : ''}${h.roi.toFixed(2).padStart(7)}%`
  );
});

// Calculate time ranges
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('TIME RANGE ANALYSIS (4-hour blocks):');
console.log('═══════════════════════════════════════════════════════════════════\n');

const timeRanges = [
  { name: '00:00-03:59 (Late Night)', hours: [0, 1, 2, 3] },
  { name: '04:00-07:59 (Early Morning)', hours: [4, 5, 6, 7] },
  { name: '08:00-11:59 (Morning)', hours: [8, 9, 10, 11] },
  { name: '12:00-15:59 (Afternoon)', hours: [12, 13, 14, 15] },
  { name: '16:00-19:59 (Evening)', hours: [16, 17, 18, 19] },
  { name: '20:00-23:59 (Night)', hours: [20, 21, 22, 23] },
];

console.log('Time Range            | Trades | Wins | Losses | Win Rate | ROI');
console.log('----------------------|--------|------|--------|----------|----------');

timeRanges.forEach(range => {
  const rangeStats = {
    totalBets: 0,
    wins: 0,
    losses: 0,
    totalWagered: 0,
    totalReturned: 0,
    bankroll: 1.0
  };

  range.hours.forEach(hour => {
    const hourData = timeStats[hour];
    if (hourData.totalBets === 0) return;

    rangeStats.totalBets += hourData.totalBets;
    rangeStats.wins += hourData.wins;
    rangeStats.losses += hourData.losses;
  });

  if (rangeStats.totalBets === 0) return;

  const winRate = (rangeStats.wins / rangeStats.totalBets) * 100;

  // Recalculate ROI for range
  rows.forEach(row => {
    const [epoch, lockTs, winner, bullWei, bearWei, totalWei, finalBullWei, finalBearWei, finalTotalWei] = row;

    const date = new Date(lockTs * 1000);
    const hour = date.getUTCHours();

    if (!range.hours.includes(hour)) return;

    const bullAmount = parseFloat(bullWei) / 1e18;
    const bearAmount = parseFloat(bearWei) / 1e18;
    const totalPool = bullAmount + bearAmount;
    const bullPct = bullAmount / totalPool;
    const bearPct = bearAmount / totalPool;

    let crowd = null;
    if (bullPct >= CROWD_THRESHOLD) crowd = 'UP';
    else if (bearPct >= CROWD_THRESHOLD) crowd = 'DOWN';
    if (!crowd) return;

    const roundedLockTs = Math.floor(lockTs / 300) * 300;
    const emaData = emaMap.get(roundedLockTs);
    if (!emaData) return;

    const emaSignal = emaData.ema5 > emaData.ema13 ? 'UP' : 'DOWN';
    if (emaSignal !== crowd) return;

    const emaGap = Math.abs(emaData.ema5 - emaData.ema13);
    const gapPercentOfPrice = (emaGap / emaData.price) * 100;
    if (gapPercentOfPrice < EMA_GAP_THRESHOLD) return;

    const won = (crowd === winner);
    const betSize = rangeStats.bankroll * 0.065;

    rangeStats.bankroll -= betSize;

    if (won) {
      const finalBull = parseFloat(finalBullWei) / 1e18;
      const finalBear = parseFloat(finalBearWei) / 1e18;
      const finalTotal = finalBull + finalBear;
      const payout = crowd === 'UP' ? (finalTotal * 0.97) / finalBull : (finalTotal * 0.97) / finalBear;
      rangeStats.bankroll += betSize * payout;
    }
  });

  const roi = ((rangeStats.bankroll - 1) * 100);
  const winRateColor = winRate >= 60 ? '✅' : winRate <= 50 ? '❌' : '  ';

  console.log(
    `${range.name.padEnd(21)} | ` +
    `${String(rangeStats.totalBets).padStart(6)} | ` +
    `${String(rangeStats.wins).padStart(4)} | ` +
    `${String(rangeStats.losses).padStart(6)} | ` +
    `${winRate.toFixed(2).padStart(8)}% ${winRateColor} | ` +
    `${roi >= 0 ? '+' : ''}${roi.toFixed(2).padStart(7)}%`
  );
});

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('RECOMMENDATION:');
console.log('═══════════════════════════════════════════════════════════════════\n');

const bestHour = hourlyResults.sort((a, b) => b.winRate - a.winRate)[0];
const worstHour = hourlyResults.sort((a, b) => a.winRate - b.winRate)[0];

console.log(`Best hour: ${String(bestHour.hour).padStart(2, '0')}:00 UTC (${bestHour.winRate.toFixed(2)}% win rate)`);
console.log(`Worst hour: ${String(worstHour.hour).padStart(2, '0')}:00 UTC (${worstHour.winRate.toFixed(2)}% win rate)`);
console.log(`\nDifference: ${(bestHour.winRate - worstHour.winRate).toFixed(2)}% win rate gap\n`);

if ((bestHour.winRate - worstHour.winRate) < 20) {
  console.log('⚠️  Time of day does NOT have major impact on strategy performance.');
  console.log('    Trade all hours - no need to filter by time.');
} else {
  console.log('✅ Time of day has SIGNIFICANT impact!');
  console.log(`   Consider trading only during top performing hours.`);
}

db.close();
