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

console.log(`Fetching EMA data for ${rows.length} rounds...`);

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

console.log('Done!\n');

console.log('═══════════════════════════════════════════════════════════════');
console.log('           PAPER TRADE: T-20s Strategy (≥55% Threshold)');
console.log('═══════════════════════════════════════════════════════════════');
console.log('Strategy: EMA 5/13 + T-20s Crowd ≥55% (≤1.87x payout)');
console.log('Starting Bankroll: 1.00 BNB');
console.log('Position Size: 2% of bankroll per trade\n');
console.log('═══════════════════════════════════════════════════════════════\n');

const THRESHOLD = 0.55;
let bankroll = 1.0;
let tradeNum = 0;
const trades = [];

console.log('Epoch   | Our Bet | Actual | Bet Size | Payout | PnL      | Bankroll');
console.log('--------|---------|--------|----------|--------|----------|----------');

rows.forEach(row => {
  const [epoch, lockTs, winner, bullWei, bearWei, totalWei, finalBullWei, finalBearWei, finalTotalWei] = row;

  // T-20s snapshot
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

  // Determine crowd
  let crowd = null;
  if (bullPct >= THRESHOLD) crowd = 'UP';
  else if (bearPct >= THRESHOLD) crowd = 'DOWN';

  if (!crowd) return; // Skip if no clear crowd

  // Get EMA signal
  const roundedLockTs = Math.floor(lockTs / 300) * 300;
  const emaData = emaMap.get(roundedLockTs);
  if (!emaData) return;

  const emaSignal = emaData.ema5 > emaData.ema13 ? 'UP' : 'DOWN';

  // Only bet if EMA and crowd agree
  if (emaSignal !== crowd) return;

  // Place trade
  tradeNum++;
  const ourBet = crowd;
  const won = (ourBet === winner);
  const betSize = Math.min(bankroll * 0.02, bankroll);

  bankroll -= betSize; // Remove bet

  let payout = 0;
  let pnl = 0;

  if (won) {
    payout = ourBet === 'UP' ? finalUpPayout : finalDownPayout;
    const totalReturn = betSize * payout;
    bankroll += totalReturn;
    pnl = totalReturn - betSize; // Profit
  } else {
    payout = ourBet === 'UP' ? finalUpPayout : finalDownPayout;
    pnl = -betSize; // Loss
  }

  const result = won ? '✅' : '❌';

  trades.push({
    tradeNum,
    epoch,
    ourBet,
    winner,
    betSize,
    payout,
    pnl,
    bankroll,
    won
  });

  console.log(
    `${epoch} | ${ourBet.padEnd(7)} | ${winner.padEnd(6)} | ` +
    `${betSize.toFixed(4)} | ` +
    `${payout.toFixed(2)}x | ` +
    `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} | ` +
    `${bankroll.toFixed(4)} ${result}`
  );

  if (bankroll > 1000000) bankroll = 1000000;
});

console.log('\n═══════════════════════════════════════════════════════════════\n');

// Calculate stats
const totalTrades = trades.length;
const wins = trades.filter(t => t.won).length;
const losses = trades.filter(t => !t.won).length;
const totalPnl = bankroll - 1.0;
const winRate = (wins / totalTrades * 100);
const avgWin = trades.filter(t => t.won).reduce((sum, t) => sum + t.pnl, 0) / wins;
const avgLoss = trades.filter(t => !t.won).reduce((sum, t) => sum + t.pnl, 0) / losses;
const largestWin = Math.max(...trades.map(t => t.pnl));
const largestLoss = Math.min(...trades.map(t => t.pnl));

console.log('📊 PAPER TRADE SUMMARY:\n');
console.log(`Total Trades:       ${totalTrades}`);
console.log(`Wins:               ${wins} (${winRate.toFixed(2)}%)`);
console.log(`Losses:             ${losses} (${(100 - winRate).toFixed(2)}%)`);
console.log(`\nAverage Win:        +${avgWin.toFixed(4)} BNB`);
console.log(`Average Loss:       ${avgLoss.toFixed(4)} BNB`);
console.log(`Largest Win:        +${largestWin.toFixed(4)} BNB`);
console.log(`Largest Loss:       ${largestLoss.toFixed(4)} BNB`);
console.log(`\nStarting Bankroll:  1.0000 BNB`);
console.log(`Ending Bankroll:    ${bankroll.toFixed(4)} BNB`);
console.log(`Total PnL:          ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} BNB`);
console.log(`ROI:                ${totalPnl >= 0 ? '+' : ''}${(totalPnl * 100).toFixed(2)}%`);

console.log('\n═══════════════════════════════════════════════════════════════\n');

// Save trades to CSV
const csvLines = [];
csvLines.push('Trade#,Epoch,Our Bet,Winner,Bet Size (BNB),Payout,PnL (BNB),Bankroll (BNB),Result');

trades.forEach(t => {
  csvLines.push(
    `${t.tradeNum},${t.epoch},${t.ourBet},${t.winner},${t.betSize.toFixed(4)},${t.payout.toFixed(2)}x,${t.pnl.toFixed(4)},${t.bankroll.toFixed(4)},${t.won ? 'WIN' : 'LOSS'}`
  );
});

fs.writeFileSync('../data/paper-trade-results.csv', csvLines.join('\n'));
console.log('✅ Trade log saved to: paper-trade-results.csv\n');

db.close();
