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

// Test different strategies
const strategies = [
  { name: 'Crowd Only (55%)', crowdThreshold: 0.55, useEMA: false, emaGap: 0 },
  { name: 'Crowd Only (60%)', crowdThreshold: 0.60, useEMA: false, emaGap: 0 },
  { name: 'Crowd Only (65%)', crowdThreshold: 0.65, useEMA: false, emaGap: 0 },
  { name: '55% Crowd + 0.10% EMA', crowdThreshold: 0.55, useEMA: true, emaGap: 0.10 },
  { name: '60% Crowd + 0.10% EMA', crowdThreshold: 0.60, useEMA: true, emaGap: 0.10 },
  { name: '65% Crowd + 0.10% EMA', crowdThreshold: 0.65, useEMA: true, emaGap: 0.10 },
];

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('   STRATEGY COMPARISON: Crowd Only vs Crowd + EMA');
console.log('═══════════════════════════════════════════════════════════════════\n');

const results = [];

strategies.forEach(strategy => {
  let bankroll = 1.0;
  let wins = 0;
  let losses = 0;
  let totalBets = 0;

  rows.forEach(row => {
    const [epoch, lockTs, winner, bullWei, bearWei, totalWei, finalBullWei, finalBearWei, finalTotalWei] = row;

    const bullAmount = parseFloat(bullWei) / 1e18;
    const bearAmount = parseFloat(bearWei) / 1e18;
    const totalPool = bullAmount + bearAmount;
    const bullPct = bullAmount / totalPool;
    const bearPct = bearAmount / totalPool;

    // Determine T-20s crowd
    let crowd = null;
    if (bullPct >= strategy.crowdThreshold) crowd = 'UP';
    else if (bearPct >= strategy.crowdThreshold) crowd = 'DOWN';

    if (!crowd) return;

    let betDirection = crowd;

    // If using EMA, check agreement
    if (strategy.useEMA) {
      const roundedLockTs = Math.floor(lockTs / 300) * 300;
      const emaData = emaMap.get(roundedLockTs);
      if (!emaData) return;

      const emaSignal = emaData.ema5 > emaData.ema13 ? 'UP' : 'DOWN';

      // Only bet if EMA and crowd agree
      if (emaSignal !== crowd) return;

      // Check EMA gap requirement
      const emaGap = Math.abs(emaData.ema5 - emaData.ema13);
      const gapPercentOfPrice = (emaGap / emaData.price) * 100;
      if (gapPercentOfPrice < strategy.emaGap) return;
    }

    // Place bet
    const won = (betDirection === winner);
    const betSize = bankroll * 0.065;

    totalBets++;
    bankroll -= betSize;

    if (won) {
      const finalBull = parseFloat(finalBullWei) / 1e18;
      const finalBear = parseFloat(finalBearWei) / 1e18;
      const finalTotal = finalBull + finalBear;
      const payout = betDirection === 'UP' ? (finalTotal * 0.97) / finalBull : (finalTotal * 0.97) / finalBear;
      bankroll += betSize * payout;
      wins++;
    } else {
      losses++;
    }

    if (bankroll > 1000000) bankroll = 1000000;
    if (bankroll < 0.0001) bankroll = 0.0001;
  });

  const winRate = totalBets > 0 ? (wins / totalBets * 100) : 0;
  const roi = ((bankroll - 1) * 100);

  results.push({
    name: strategy.name,
    totalBets,
    wins,
    losses,
    winRate,
    roi,
    bankroll
  });
});

console.log('Strategy                    | Trades | Wins | Losses | Win Rate | ROI       | Final');
console.log('----------------------------|--------|------|--------|----------|-----------|----------');

results.forEach(r => {
  console.log(
    `${r.name.padEnd(27)} | ` +
    `${String(r.totalBets).padStart(6)} | ` +
    `${String(r.wins).padStart(4)} | ` +
    `${String(r.losses).padStart(6)} | ` +
    `${r.winRate.toFixed(2).padStart(8)}% | ` +
    `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2).padStart(8)}% | ` +
    `${r.bankroll.toFixed(4)} BNB`
  );
});

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('TIME OF DAY ANALYSIS: 55% Crowd + 0.10% EMA');
console.log('═══════════════════════════════════════════════════════════════════\n');

// Now analyze 55% crowd + EMA by time
const timeStats = {};
for (let hour = 0; hour < 24; hour++) {
  timeStats[hour] = {
    hour,
    wins: 0,
    losses: 0,
    totalBets: 0,
    bankroll: 1.0
  };
}

rows.forEach(row => {
  const [epoch, lockTs, winner, bullWei, bearWei, totalWei, finalBullWei, finalBearWei, finalTotalWei] = row;

  const date = new Date(lockTs * 1000);
  const hour = date.getUTCHours();

  const bullAmount = parseFloat(bullWei) / 1e18;
  const bearAmount = parseFloat(bearWei) / 1e18;
  const totalPool = bullAmount + bearAmount;
  const bullPct = bullAmount / totalPool;
  const bearPct = bearAmount / totalPool;

  let crowd = null;
  if (bullPct >= 0.55) crowd = 'UP';
  else if (bearPct >= 0.55) crowd = 'DOWN';

  if (!crowd) return;

  const roundedLockTs = Math.floor(lockTs / 300) * 300;
  const emaData = emaMap.get(roundedLockTs);
  if (!emaData) return;

  const emaSignal = emaData.ema5 > emaData.ema13 ? 'UP' : 'DOWN';
  if (emaSignal !== crowd) return;

  const emaGap = Math.abs(emaData.ema5 - emaData.ema13);
  const gapPercentOfPrice = (emaGap / emaData.price) * 100;
  if (gapPercentOfPrice < 0.10) return;

  const won = (crowd === winner);
  const betSize = timeStats[hour].bankroll * 0.065;

  timeStats[hour].totalBets++;
  timeStats[hour].bankroll -= betSize;

  if (won) {
    const finalBull = parseFloat(finalBullWei) / 1e18;
    const finalBear = parseFloat(finalBearWei) / 1e18;
    const finalTotal = finalBull + finalBear;
    const payout = crowd === 'UP' ? (finalTotal * 0.97) / finalBull : (finalTotal * 0.97) / finalBear;
    timeStats[hour].bankroll += betSize * payout;
    timeStats[hour].wins++;
  } else {
    timeStats[hour].losses++;
  }
});

const hourlyResults = Object.values(timeStats)
  .filter(h => h.totalBets > 0)
  .map(h => ({
    hour: h.hour,
    totalBets: h.totalBets,
    wins: h.wins,
    losses: h.losses,
    winRate: (h.wins / h.totalBets) * 100,
    roi: ((h.bankroll - 1) * 100),
  }));

// Group into time ranges
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
  const rangeHours = hourlyResults.filter(h => range.hours.includes(h.hour));
  if (rangeHours.length === 0) return;

  const totalBets = rangeHours.reduce((sum, h) => sum + h.totalBets, 0);
  const totalWins = rangeHours.reduce((sum, h) => sum + h.wins, 0);
  const totalLosses = rangeHours.reduce((sum, h) => sum + h.losses, 0);

  // Recalculate ROI for this range
  let rangeBankroll = 1.0;
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
    if (bullPct >= 0.55) crowd = 'UP';
    else if (bearPct >= 0.55) crowd = 'DOWN';
    if (!crowd) return;

    const roundedLockTs = Math.floor(lockTs / 300) * 300;
    const emaData = emaMap.get(roundedLockTs);
    if (!emaData) return;

    const emaSignal = emaData.ema5 > emaData.ema13 ? 'UP' : 'DOWN';
    if (emaSignal !== crowd) return;

    const emaGap = Math.abs(emaData.ema5 - emaData.ema13);
    const gapPercentOfPrice = (emaGap / emaData.price) * 100;
    if (gapPercentOfPrice < 0.10) return;

    const won = (crowd === winner);
    const betSize = rangeBankroll * 0.065;
    rangeBankroll -= betSize;

    if (won) {
      const finalBull = parseFloat(finalBullWei) / 1e18;
      const finalBear = parseFloat(finalBearWei) / 1e18;
      const finalTotal = finalBull + finalBear;
      const payout = crowd === 'UP' ? (finalTotal * 0.97) / finalBull : (finalTotal * 0.97) / finalBear;
      rangeBankroll += betSize * payout;
    }
  });

  const winRate = (totalWins / totalBets) * 100;
  const roi = ((rangeBankroll - 1) * 100);
  const winRateColor = winRate >= 60 ? '✅' : winRate <= 50 ? '❌' : '  ';

  console.log(
    `${range.name.padEnd(21)} | ` +
    `${String(totalBets).padStart(6)} | ` +
    `${String(totalWins).padStart(4)} | ` +
    `${String(totalLosses).padStart(6)} | ` +
    `${winRate.toFixed(2).padStart(8)}% ${winRateColor} | ` +
    `${roi >= 0 ? '+' : ''}${roi.toFixed(2).padStart(8)}%`
  );
});

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('KEY FINDINGS:');
console.log('═══════════════════════════════════════════════════════════════════\n');

const crowdOnly55 = results.find(r => r.name === 'Crowd Only (55%)');
const emaStrategy55 = results.find(r => r.name === '55% Crowd + 0.10% EMA');
const emaStrategy65 = results.find(r => r.name === '65% Crowd + 0.10% EMA');

console.log('1. CROWD ONLY vs CROWD + EMA:');
console.log(`   Crowd Only (55%): ${crowdOnly55.winRate.toFixed(2)}% win rate, ${crowdOnly55.roi >= 0 ? '+' : ''}${crowdOnly55.roi.toFixed(2)}% ROI (${crowdOnly55.totalBets} trades)`);
console.log(`   55% + EMA:        ${emaStrategy55.winRate.toFixed(2)}% win rate, ${emaStrategy55.roi >= 0 ? '+' : ''}${emaStrategy55.roi.toFixed(2)}% ROI (${emaStrategy55.totalBets} trades)`);
console.log(`   Improvement:      +${(emaStrategy55.winRate - crowdOnly55.winRate).toFixed(2)}% win rate\n`);

console.log('2. 55% CROWD vs 65% CROWD (both with 0.10% EMA):');
console.log(`   55% Crowd:  ${emaStrategy55.totalBets} trades, ${emaStrategy55.winRate.toFixed(2)}% win rate, ${emaStrategy55.roi >= 0 ? '+' : ''}${emaStrategy55.roi.toFixed(2)}% ROI`);
console.log(`   65% Crowd:  ${emaStrategy65.totalBets} trades, ${emaStrategy65.winRate.toFixed(2)}% win rate, ${emaStrategy65.roi >= 0 ? '+' : ''}${emaStrategy65.roi.toFixed(2)}% ROI`);
console.log(`   Trade-off:  ${emaStrategy55.totalBets - emaStrategy65.totalBets} more trades but ${(emaStrategy65.winRate - emaStrategy55.winRate).toFixed(2)}% lower win rate\n`);

db.close();
