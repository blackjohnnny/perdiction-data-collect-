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

console.log(`Dataset: ${rows.length} rounds with T-20s snapshots\n`);

// Fetch EMA data
console.log('Fetching EMA data...');
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
  emaMap.set(candles.t[i], { ema5: ema5[i], ema13: ema13[i] });
}

console.log('Done!\n');

console.log('═══════════════════════════════════════════════════════════════');
console.log('           Strategy Comparison: EMA vs Crowd vs Combined');
console.log('═══════════════════════════════════════════════════════════════\n');

// Test thresholds
const thresholds = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75];

console.log('═══ 1️⃣  EMA ONLY (No Crowd Filter) ═══\n');
console.log('Bets | Wins | Win%   | Edge/Bet | ROI      | Bankroll');
console.log('-----|------|--------|----------|----------|----------');

// EMA Only
let bankroll = 1.0;
let wins = 0;
let losses = 0;
let totalBets = 0;
let totalWagered = 0;
let totalReturned = 0;

rows.forEach(row => {
  const [epoch, lockTs, winner, bullWei, bearWei, totalWei, finalBullWei, finalBearWei, finalTotalWei] = row;

  const finalBull = parseFloat(finalBullWei) / 1e18;
  const finalBear = parseFloat(finalBearWei) / 1e18;
  const finalTotal = finalBull + finalBear;
  const finalUpPayout = (finalTotal * 0.97) / finalBull;
  const finalDownPayout = (finalTotal * 0.97) / finalBear;

  const roundedLockTs = Math.floor(lockTs / 300) * 300;
  const emaData = emaMap.get(roundedLockTs);
  if (!emaData) return;

  const emaSignal = emaData.ema5 > emaData.ema13 ? 'UP' : 'DOWN';
  const ourBet = emaSignal;
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

const emaWinRate = (wins / totalBets * 100);
const emaEdge = ((totalReturned / totalWagered - 1) * 100);
const emaRoi = ((bankroll - 1) * 100);

console.log(
  `${totalBets.toString().padStart(4)} | ` +
  `${wins.toString().padStart(4)} | ` +
  `${emaWinRate.toFixed(2).padStart(6)}% | ` +
  `${emaEdge >= 0 ? '+' : ''}${emaEdge.toFixed(2).padStart(7)}% | ` +
  `${emaRoi >= 0 ? '+' : ''}${emaRoi.toFixed(2).padStart(7)}% | ` +
  `${bankroll.toFixed(4)} BNB`
);

console.log('\n═══ 2️⃣  CROWD ONLY (No EMA Filter) ═══\n');
console.log('Threshold | Bets | Wins | Win%   | Edge/Bet | ROI      | Bankroll');
console.log('----------|------|------|--------|----------|----------|----------');

thresholds.forEach(threshold => {
  let bankroll = 1.0;
  let wins = 0;
  let losses = 0;
  let totalBets = 0;
  let totalWagered = 0;
  let totalReturned = 0;

  rows.forEach(row => {
    const [epoch, lockTs, winner, bullWei, bearWei, totalWei, finalBullWei, finalBearWei, finalTotalWei] = row;

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

  const winRate = (wins / totalBets * 100);
  const edge = ((totalReturned / totalWagered - 1) * 100);
  const roi = ((bankroll - 1) * 100);
  const payoutThreshold = (1 / threshold / 0.97).toFixed(2) + 'x';

  console.log(
    `≥${(threshold * 100).toFixed(0)}% (≤${payoutThreshold}) | ` +
    `${totalBets.toString().padStart(4)} | ` +
    `${wins.toString().padStart(4)} | ` +
    `${winRate.toFixed(2).padStart(6)}% | ` +
    `${edge >= 0 ? '+' : ''}${edge.toFixed(2).padStart(7)}% | ` +
    `${roi >= 0 ? '+' : ''}${roi.toFixed(2).padStart(7)}% | ` +
    `${bankroll.toFixed(4)} BNB`
  );
});

console.log('\n═══ 3️⃣  EMA + CROWD COMBINED (Our Strategy) ═══\n');
console.log('Threshold | Bets | Wins | Win%   | Edge/Bet | ROI      | Bankroll');
console.log('----------|------|------|--------|----------|----------|----------');

thresholds.forEach(threshold => {
  let bankroll = 1.0;
  let wins = 0;
  let losses = 0;
  let totalBets = 0;
  let totalWagered = 0;
  let totalReturned = 0;

  rows.forEach(row => {
    const [epoch, lockTs, winner, bullWei, bearWei, totalWei, finalBullWei, finalBearWei, finalTotalWei] = row;

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

  const winRate = (wins / totalBets * 100);
  const edge = ((totalReturned / totalWagered - 1) * 100);
  const roi = ((bankroll - 1) * 100);
  const payoutThreshold = (1 / threshold / 0.97).toFixed(2) + 'x';

  console.log(
    `≥${(threshold * 100).toFixed(0)}% (≤${payoutThreshold}) | ` +
    `${totalBets.toString().padStart(4)} | ` +
    `${wins.toString().padStart(4)} | ` +
    `${winRate.toFixed(2).padStart(6)}% | ` +
    `${edge >= 0 ? '+' : ''}${edge.toFixed(2).padStart(7)}% | ` +
    `${roi >= 0 ? '+' : ''}${roi.toFixed(2).padStart(7)}% | ` +
    `${bankroll.toFixed(4)} BNB`
  );
});

console.log('\n═══════════════════════════════════════════════════════════════\n');

console.log('📊 COMPARISON SUMMARY:\n');
console.log('Strategy          | Best Win% | Best ROI   | Breakeven?');
console.log('------------------|-----------|------------|------------');
console.log(`EMA Only          | ${emaWinRate.toFixed(2).padStart(8)}% | ${emaRoi >= 0 ? '+' : ''}${emaRoi.toFixed(2).padStart(9)}% | ${emaWinRate > 51.5 ? '✅ Yes' : '❌ No'}`);
console.log(`Crowd Only (≥55%) | Coming... | Coming...  | ...`);
console.log(`Combined (≥50%)   | Coming... | Coming...  | ...`);

console.log('\n═══════════════════════════════════════════════════════════════\n');

db.close();
