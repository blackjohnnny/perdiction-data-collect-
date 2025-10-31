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
  LIMIT 113
`;

const result = db.exec(query);
const rows = result[0].values;

console.log(`Testing on first ${rows.length} rounds...\n`);
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

const configs = [
  { name: 'Crowd Only (55%)', crowd: 0.55, useEMA: false, gap: 0 },
  { name: '55% Crowd + 0.10% EMA', crowd: 0.55, useEMA: true, gap: 0.10 },
  { name: '60% Crowd + 0.10% EMA', crowd: 0.60, useEMA: true, gap: 0.10 },
  { name: '65% Crowd + 0.10% EMA', crowd: 0.65, useEMA: true, gap: 0.10 },
  { name: '70% Crowd + 0.10% EMA', crowd: 0.70, useEMA: true, gap: 0.10 },
];

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log(`   TESTING ON FIRST 113 ROUNDS (6.5% Position Size)`);
console.log('═══════════════════════════════════════════════════════════════════\n');

const results = [];

configs.forEach(config => {
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

    let crowd = null;
    if (bullPct >= config.crowd) crowd = 'UP';
    else if (bearPct >= config.crowd) crowd = 'DOWN';

    if (!crowd) return;

    let betDirection = crowd;

    if (config.useEMA) {
      const roundedLockTs = Math.floor(lockTs / 300) * 300;
      const emaData = emaMap.get(roundedLockTs);
      if (!emaData) return;

      const emaSignal = emaData.ema5 > emaData.ema13 ? 'UP' : 'DOWN';
      if (emaSignal !== crowd) return;

      const emaGap = Math.abs(emaData.ema5 - emaData.ema13);
      const gapPercentOfPrice = (emaGap / emaData.price) * 100;
      if (gapPercentOfPrice < config.gap) return;
    }

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
    name: config.name,
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
console.log('COMPARISON: First 113 vs All 578 Rounds');
console.log('═══════════════════════════════════════════════════════════════════\n');

const best113 = results.find(r => r.name === '65% Crowd + 0.10% EMA');

console.log('65% Crowd + 0.10% EMA Strategy:');
console.log(`  First 113 rounds: ${best113.totalBets} trades, ${best113.winRate.toFixed(2)}% win rate, ${best113.roi >= 0 ? '+' : ''}${best113.roi.toFixed(2)}% ROI`);
console.log(`  All 578 rounds:   73 trades, 58.90% win rate, +78.83% ROI`);
console.log(`\nStrategy performs ${best113.roi > 78.83 ? 'BETTER' : best113.roi < 0 ? 'WORSE' : 'SIMILARLY'} on first 113 rounds.\n`);

db.close();
