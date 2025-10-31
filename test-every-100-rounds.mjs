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

// Analyze by batches of 100 ROUNDS
const BATCH_SIZE = 100;
const batches = [];

for (let batchStart = 0; batchStart < rounds.length; batchStart += BATCH_SIZE) {
  const batchRounds = rounds.slice(batchStart, batchStart + BATCH_SIZE);

  let balance = 1.0;
  let wins = 0;
  let losses = 0;
  let tradesEntered = 0;

  for (const round of batchRounds) {
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

    const betSize = balance * POSITION_SIZE;
    const payout = won ? betSize * multiple : 0;
    const profit = payout - betSize;
    balance += profit;

    tradesEntered++;
    if (won) wins++;
    else losses++;
  }

  batches.push({
    batchNum: Math.floor(batchStart / BATCH_SIZE) + 1,
    roundsStart: batchStart + 1,
    roundsEnd: Math.min(batchStart + BATCH_SIZE, rounds.length),
    roundCount: batchRounds.length,
    tradesEntered,
    wins,
    losses,
    winRate: tradesEntered > 0 ? (wins / tradesEntered) * 100 : 0,
    startBalance: 1.0,
    endBalance: balance,
    roi: ((balance - 1.0) / 1.0) * 100,
    profit: balance - 1.0,
    firstEpoch: batchRounds[0][0],
    lastEpoch: batchRounds[batchRounds.length - 1][0]
  });
}

console.log('='.repeat(100));
console.log('BATCH ANALYSIS - Every 100 Rounds');
console.log('='.repeat(100));
console.log();

batches.forEach((b) => {
  const status = b.profit >= 0 ? '✅' : '❌';
  console.log(`Batch ${b.batchNum}: Rounds ${b.roundsStart}-${b.roundsEnd} (${b.roundCount} rounds) ${status}`);
  console.log(`  Epochs: ${b.firstEpoch} to ${b.lastEpoch}`);
  console.log(`  Trades entered: ${b.tradesEntered} out of ${b.roundCount} rounds (${((b.tradesEntered / b.roundCount) * 100).toFixed(1)}% frequency)`);
  if (b.tradesEntered > 0) {
    console.log(`  Results: ${b.wins}W / ${b.losses}L | Win Rate: ${b.winRate.toFixed(2)}%`);
    console.log(`  Balance: 1.0000 → ${b.endBalance.toFixed(4)} BNB`);
    console.log(`  ROI: ${b.roi >= 0 ? '+' : ''}${b.roi.toFixed(2)}%`);
  } else {
    console.log(`  No trades (no signals met criteria)`);
  }
  console.log();
});

// Summary
const losingBatches = batches.filter(b => b.profit < 0);
const winningBatches = batches.filter(b => b.profit >= 0);

console.log('='.repeat(100));
console.log('BATCH SUMMARY');
console.log('='.repeat(100));
console.log();
console.log(`Total batches: ${batches.length}`);
console.log(`Winning batches: ${winningBatches.length} (${((winningBatches.length / batches.length) * 100).toFixed(1)}%)`);
console.log(`Losing batches: ${losingBatches.length} (${((losingBatches.length / batches.length) * 100).toFixed(1)}%)`);

if (losingBatches.length > 0) {
  console.log();
  console.log('Losing batches:');
  losingBatches.forEach(b => {
    console.log(`  Batch ${b.batchNum} (Rounds ${b.roundsStart}-${b.roundsEnd}): ${b.roi.toFixed(2)}% (${b.tradesEntered} trades, ${b.wins}W/${b.losses}L)`);
  });
}

db.close();
