import initSqlJs from 'sql.js';
import fs from 'fs';

const sqlJs = await initSqlJs();
const buf = fs.readFileSync('../data/prediction-data.db');
const db = new sqlJs.Database(buf);

const query = `
  SELECT
    r.epoch,
    r.lock_ts,
    r.winner,
    s.snapshot_type,
    s.bull_amount_wei,
    s.bear_amount_wei,
    r.bull_amount_wei as final_bull_wei,
    r.bear_amount_wei as final_bear_wei
  FROM snapshots s
  JOIN rounds r ON s.epoch = r.epoch
  WHERE s.snapshot_type = 'T_MINUS_8S'
    AND r.winner != 'UNKNOWN'
  ORDER BY r.epoch
`;

const result = db.exec(query);
if (result.length === 0 || result[0].values.length === 0) {
  console.log('No T-8s snapshots with results found');
  db.close();
  process.exit(0);
}
const rows = result[0].values;

console.log(`Found ${rows.length} rounds with T-8s snapshots and results\n`);

// Fetch EMA data
const lockTimestamps = rows.map(row => row[1]);
const minLockTs = Math.min(...lockTimestamps);
const maxLockTs = Math.max(...lockTimestamps);
const startTime = minLockTs - 3600;
const endTime = maxLockTs + 3600;

console.log('Fetching EMA data from TradingView...');
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
  emaMap.set(candles.t[i], { ema5: ema5[i], ema13: ema13[i] });
}

console.log(`Fetched ${candles.t.length} 5-minute candles\n`);

// Test multiple thresholds
const thresholds = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75];

console.log('=== EMA 5/13 + T-8s Crowd Strategy - Different Thresholds (176 Rounds) ===\n');
console.log('Threshold | Bets | Wins | Losses | Win Rate | Edge/Bet | ROI');
console.log('----------|------|------|--------|----------|----------|--------');

thresholds.forEach(threshold => {
  let bankroll = 1.0;
  let wins = 0;
  let losses = 0;
  let totalBets = 0;
  let totalWagered = 0;
  let totalReturned = 0;

  rows.forEach(row => {
    const [epoch, lockTs, winner, snapshotType, bullWei, bearWei, finalBullWei, finalBearWei] = row;

    const bullAmount = parseFloat(bullWei) / 1e18;
    const bearAmount = parseFloat(bearWei) / 1e18;
    const totalPool = bullAmount + bearAmount;
    const bullPct = bullAmount / totalPool;
    const bearPct = bearAmount / totalPool;

    const finalBull = parseFloat(finalBullWei) / 1e18;
    const finalBear = parseFloat(finalBearWei) / 1e18;
    const finalTotal = finalBull + finalBear;
    const finalUpPayout = (finalTotal * 0.97) / finalBull;
    const finalDownPayout = (finalTotal * 0.97) / finalBear;

    let crowd = null;
    if (bullPct >= threshold) crowd = 'UP';
    else if (bearPct >= threshold) crowd = 'DOWN';

    if (!crowd) return;

    const roundedLockTs = Math.floor(lockTs / 300) * 300;
    const emaData = emaMap.get(roundedLockTs);
    if (!emaData) return;

    const emaSignal = emaData.ema5 > emaData.ema13 ? 'UP' : 'DOWN';
    if (emaSignal !== crowd) return;

    const ourBet = crowd;
    const won = (ourBet === winner);
    const betSize = Math.min(bankroll * 0.02, bankroll);

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
  });

  const winRate = totalBets > 0 ? (wins / totalBets * 100).toFixed(2) : '0.00';
  const edge = totalBets > 0 ? ((totalReturned / totalWagered - 1) * 100).toFixed(2) : '0.00';
  const roi = ((bankroll - 1) * 100).toFixed(2);
  const payout = threshold >= 0.55 ? (1 / threshold / 0.97).toFixed(2) : 'N/A';

  console.log(`≥${(threshold * 100).toFixed(0)}% (≤${payout}x) | ${totalBets.toString().padStart(4)} | ${wins.toString().padStart(4)} | ${losses.toString().padStart(6)} | ${winRate.padStart(7)}% | ${edge.padStart(7)}% | ${roi.padStart(6)}%`);
});

console.log('\n=== T-8s Crowd-Only Performance (No EMA) ===\n');
console.log('Threshold | Bets | Wins | Losses | Win Rate | Edge/Bet | ROI');
console.log('----------|------|------|--------|----------|----------|--------');

thresholds.forEach(threshold => {
  let bankroll = 1.0;
  let wins = 0;
  let losses = 0;
  let totalBets = 0;
  let totalWagered = 0;
  let totalReturned = 0;

  rows.forEach(row => {
    const [epoch, lockTs, winner, snapshotType, bullWei, bearWei, finalBullWei, finalBearWei] = row;

    const bullAmount = parseFloat(bullWei) / 1e18;
    const bearAmount = parseFloat(bearWei) / 1e18;
    const totalPool = bullAmount + bearAmount;
    const bullPct = bullAmount / totalPool;
    const bearPct = bearAmount / totalPool;

    const finalBull = parseFloat(finalBullWei) / 1e18;
    const finalBear = parseFloat(finalBearWei) / 1e18;
    const finalTotal = finalBull + finalBear;
    const finalUpPayout = (finalTotal * 0.97) / finalBull;
    const finalDownPayout = (finalTotal * 0.97) / finalBear;

    let crowd = null;
    if (bullPct >= threshold) crowd = 'UP';
    else if (bearPct >= threshold) crowd = 'DOWN';

    if (!crowd) return;

    const ourBet = crowd;
    const won = (ourBet === winner);
    const betSize = Math.min(bankroll * 0.02, bankroll);

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
  });

  const winRate = totalBets > 0 ? (wins / totalBets * 100).toFixed(2) : '0.00';
  const edge = totalBets > 0 ? ((totalReturned / totalWagered - 1) * 100).toFixed(2) : '0.00';
  const roi = ((bankroll - 1) * 100).toFixed(2);
  const payout = threshold >= 0.55 ? (1 / threshold / 0.97).toFixed(2) : 'N/A';

  console.log(`≥${(threshold * 100).toFixed(0)}% (≤${payout}x) | ${totalBets.toString().padStart(4)} | ${wins.toString().padStart(4)} | ${losses.toString().padStart(6)} | ${winRate.padStart(7)}% | ${edge.padStart(7)}% | ${roi.padStart(6)}%`);
});

db.close();
