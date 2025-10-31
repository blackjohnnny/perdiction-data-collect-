import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const dbBuffer = readFileSync('./data/live.db');
const db = new SQL.Database(dbBuffer);

console.log('Loading all rounds...\n');

const roundsData = db.exec(`
  SELECT epoch, lock_ts, lock_price, close_price, winner, t20s_bull_wei, t20s_bear_wei, t20s_total_wei,
         bull_amount_wei, bear_amount_wei, total_amount_wei
  FROM rounds
  ORDER BY epoch ASC
`)[0];

const rounds = roundsData.values;
console.log(`Loaded ${rounds.length} rounds\n`);

// Fetch TradingView candles
const lockTimes = rounds.map(r => r[1]);
const startTime = Math.min(...lockTimes) - 3600;
const endTime = Math.max(...lockTimes) + 3600;

console.log('Fetching TradingView price data...');
const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.BNB/USD&resolution=5&from=${startTime}&to=${endTime}`;
const response = await globalThis.fetch(url);
const candles = await response.json();

const candleMap = new Map();
for (let i = 0; i < candles.t.length; i++) {
  candleMap.set(candles.t[i], candles.c[i]);
}

// Calculate EMAs
function calculateEMA(prices, period) {
  const multiplier = 2 / (period + 1);
  let ema = prices[0];
  const result = [ema];
  for (let i = 1; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
    result.push(ema);
  }
  return result;
}

const sortedCandles = Array.from(candleMap.entries()).sort((a, b) => a[0] - b[0]);
const closePrices = sortedCandles.map(([_, close]) => close);

const emaFast = calculateEMA(closePrices, 3);
const emaSlow = calculateEMA(closePrices, 7);

const emaFastMap = new Map();
const emaSlowMap = new Map();
sortedCandles.forEach(([time], idx) => {
  emaFastMap.set(time, emaFast[idx]);
  emaSlowMap.set(time, emaSlow[idx]);
});

console.log('Calculated EMAs\n');

// Strategy parameters
const POSITION_SIZE = 0.065;
const EMA_GAP = 0.0005;
const CROWD_THRESHOLD = 0.65;

// Run full simulation first to get all trades
let allTrades = [];

for (const round of rounds) {
  const [epoch, lockTs, lockPrice, closePrice, winner, t20sBull, t20sBear, t20sTotal, finalBull, finalBear, finalTotal] = round;

  const roundedLockTs = Math.floor(lockTs / 300) * 300;
  const fast = emaFastMap.get(roundedLockTs);
  const slow = emaSlowMap.get(roundedLockTs);

  if (!fast || !slow) continue;

  const emaDiff = Math.abs(fast - slow) / slow;
  if (emaDiff < EMA_GAP) continue;

  const emaBullish = fast > slow;
  const emaBearish = fast < slow;

  const t20sBullPct = Number(t20sBull) / Number(t20sTotal);
  const t20sBearPct = Number(t20sBear) / Number(t20sTotal);

  const crowdBullish = t20sBullPct >= CROWD_THRESHOLD;
  const crowdBearish = t20sBearPct >= CROWD_THRESHOLD;

  const signalBull = emaBullish && crowdBullish;
  const signalBear = emaBearish && crowdBearish;

  if (!signalBull && !signalBear) continue;

  const bullMultiple = Number(finalTotal) / Number(finalBull);
  const bearMultiple = Number(finalTotal) / Number(finalBear);

  const position = signalBull ? 'BULL' : 'BEAR';
  const multiple = signalBull ? bullMultiple : bearMultiple;

  const priceUp = Number(closePrice) > Number(lockPrice);
  const won = (position === 'BULL' && priceUp) || (position === 'BEAR' && !priceUp);

  allTrades.push({
    epoch,
    lockTs,
    position,
    multiple,
    won
  });
}

console.log(`Found ${allTrades.length} trades\n`);

// Analyze by batches of 100 rounds
const BATCH_SIZE = 100;
const batches = [];

for (let i = 0; i < allTrades.length; i += BATCH_SIZE) {
  const batch = allTrades.slice(i, i + BATCH_SIZE);
  let balance = 1.0;
  let wins = 0;
  let losses = 0;

  for (const trade of batch) {
    const betSize = balance * POSITION_SIZE;
    const payout = trade.won ? betSize * trade.multiple : 0;
    const profit = payout - betSize;
    balance += profit;
    if (trade.won) wins++;
    else losses++;
  }

  batches.push({
    start: i + 1,
    end: Math.min(i + BATCH_SIZE, allTrades.length),
    count: batch.length,
    wins,
    losses,
    winRate: (wins / batch.length) * 100,
    startBalance: 1.0,
    endBalance: balance,
    roi: ((balance - 1.0) / 1.0) * 100,
    firstEpoch: batch[0].epoch,
    lastEpoch: batch[batch.length - 1].epoch
  });
}

console.log('='.repeat(90));
console.log('BATCH ANALYSIS (Every 100 Trades)');
console.log('='.repeat(90));
console.log();

batches.forEach((b, idx) => {
  console.log(`Batch ${idx + 1}: Trades ${b.start}-${b.end} (${b.count} trades)`);
  console.log(`  Epochs: ${b.firstEpoch} to ${b.lastEpoch}`);
  console.log(`  Wins: ${b.wins} | Losses: ${b.losses} | Win Rate: ${b.winRate.toFixed(2)}%`);
  console.log(`  Starting: 1.0000 BNB | Ending: ${b.endBalance.toFixed(4)} BNB`);
  console.log(`  ROI: ${b.roi >= 0 ? '+' : ''}${b.roi.toFixed(2)}%`);
  console.log();
});

// Analyze by day
console.log('='.repeat(90));
console.log('DAILY ANALYSIS');
console.log('='.repeat(90));
console.log();

const dailyTrades = new Map();

for (const trade of allTrades) {
  const date = new Date(trade.lockTs * 1000).toISOString().split('T')[0];
  if (!dailyTrades.has(date)) {
    dailyTrades.set(date, []);
  }
  dailyTrades.get(date).push(trade);
}

const dailyResults = [];

for (const [date, trades] of Array.from(dailyTrades.entries()).sort()) {
  let balance = 1.0;
  let wins = 0;
  let losses = 0;

  for (const trade of trades) {
    const betSize = balance * POSITION_SIZE;
    const payout = trade.won ? betSize * trade.multiple : 0;
    const profit = payout - betSize;
    balance += profit;
    if (trade.won) wins++;
    else losses++;
  }

  dailyResults.push({
    date,
    trades: trades.length,
    wins,
    losses,
    winRate: (wins / trades.length) * 100,
    startBalance: 1.0,
    endBalance: balance,
    roi: ((balance - 1.0) / 1.0) * 100,
    profit: balance - 1.0
  });
}

dailyResults.forEach(day => {
  const status = day.profit >= 0 ? '✅' : '❌';
  console.log(`${day.date} ${status}`);
  console.log(`  Trades: ${day.trades} | Wins: ${day.wins} | Losses: ${day.losses} | Win Rate: ${day.winRate.toFixed(2)}%`);
  console.log(`  P&L: ${day.profit >= 0 ? '+' : ''}${day.profit.toFixed(4)} BNB (${day.roi >= 0 ? '+' : ''}${day.roi.toFixed(2)}%)`);
  console.log();
});

// Summary
const losingDays = dailyResults.filter(d => d.profit < 0);
const winningDays = dailyResults.filter(d => d.profit >= 0);

console.log('='.repeat(90));
console.log('SUMMARY');
console.log('='.repeat(90));
console.log();
console.log(`Total trading days: ${dailyResults.length}`);
console.log(`Winning days: ${winningDays.length} (${((winningDays.length / dailyResults.length) * 100).toFixed(1)}%)`);
console.log(`Losing days: ${losingDays.length} (${((losingDays.length / dailyResults.length) * 100).toFixed(1)}%)`);

if (losingDays.length > 0) {
  console.log();
  console.log('Losing days:');
  losingDays.forEach(d => {
    console.log(`  ${d.date}: ${d.roi.toFixed(2)}% (${d.wins}W/${d.losses}L, ${d.winRate.toFixed(1)}% win rate)`);
  });
}

db.close();
