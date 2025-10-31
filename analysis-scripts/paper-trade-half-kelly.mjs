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

console.log(`Running paper trade on ${rows.length} rounds...\n`);

// Fetch EMA data
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

console.log('═══════════════════════════════════════════════════════════════');
console.log('      COMPARISON: 2% vs Half Kelly (6.5%) vs 10%');
console.log('═══════════════════════════════════════════════════════════════\n');

const THRESHOLD = 0.55;
const positionSizes = [
  { size: 0.02, name: '2% (Conservative)' },
  { size: 0.065, name: '6.5% (Half Kelly)' },
  { size: 0.10, name: '10% (Aggressive)' }
];

positionSizes.forEach(({ size: posSize, name }) => {
  let bankroll = 1.0;
  let wins = 0;
  let losses = 0;
  let totalBets = 0;
  let minBankroll = 1.0;
  let maxBankroll = 1.0;

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
    if (bullPct >= THRESHOLD) crowd = 'UP';
    else if (bearPct >= THRESHOLD) crowd = 'DOWN';

    if (!crowd) return;

    const roundedLockTs = Math.floor(lockTs / 300) * 300;
    const emaData = emaMap.get(roundedLockTs);
    if (!emaData) return;

    const emaSignal = emaData.ema5 > emaData.ema13 ? 'UP' : 'DOWN';
    if (emaSignal !== crowd) return;

    const ourBet = crowd;
    const won = (ourBet === winner);
    const betSize = Math.min(bankroll * posSize, bankroll);

    totalBets++;
    bankroll -= betSize;

    if (won) {
      const payout = ourBet === 'UP' ? finalUpPayout : finalDownPayout;
      const totalReturn = betSize * payout;
      bankroll += totalReturn;
      wins++;
    } else {
      losses++;
    }

    minBankroll = Math.min(minBankroll, bankroll);
    maxBankroll = Math.max(maxBankroll, bankroll);

    if (bankroll > 1000000) bankroll = 1000000;
  });

  const winRate = (wins / totalBets * 100);
  const totalPnl = bankroll - 1.0;
  const roi = ((bankroll - 1) * 100);
  const maxDrawdown = ((minBankroll - 1.0) * 100);
  const maxGain = ((maxBankroll - 1.0) * 100);

  console.log(`═══ ${name} ═══\n`);
  console.log(`Total Trades:       ${totalBets}`);
  console.log(`Wins:               ${wins} (${winRate.toFixed(2)}%)`);
  console.log(`Losses:             ${losses} (${(100 - winRate).toFixed(2)}%)`);
  console.log(`\nStarting Bankroll:  1.0000 BNB`);
  console.log(`Ending Bankroll:    ${bankroll.toFixed(4)} BNB`);
  console.log(`Total PnL:          ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} BNB`);
  console.log(`ROI:                ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`);
  console.log(`\nMax Drawdown:       ${maxDrawdown.toFixed(2)}%`);
  console.log(`Peak Bankroll:      ${maxBankroll.toFixed(4)} BNB`);
  console.log(`Peak Gain:          ${maxGain >= 0 ? '+' : ''}${maxGain.toFixed(2)}%`);
  console.log('');
});

console.log('═══════════════════════════════════════════════════════════════\n');

console.log('📊 KELLY CRITERION EXPLAINED:\n');
console.log('Full Kelly = ~13% (maximum growth, high volatility)');
console.log('Half Kelly = ~6.5% (good balance of growth vs risk) ⭐');
console.log('Quarter Kelly = ~3.25% (conservative)');
console.log('Our 2% = Ultra-conservative (very safe)\n');

console.log('Half Kelly (6.5%) is the SWEET SPOT:');
console.log('✅ Much higher returns than 2%');
console.log('✅ Much safer than full Kelly (13%) or 10%');
console.log('✅ Recommended by many professional traders\n');

console.log('═══════════════════════════════════════════════════════════════\n');

db.close();
