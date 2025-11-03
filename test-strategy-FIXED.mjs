import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const CONFIG = {
  DATABASE: './data/live.db',
  ROUNDS: {
    mode: 'all'
  },
  STRATEGY: {
    emaFast: 3,
    emaSlow: 7,
    emaGap: 0.0005,
    crowdThreshold: 0.65,
    positionSize: 0.065
  }
};

const SQL = await initSqlJs();
const buffer = readFileSync(CONFIG.DATABASE);
const db = new SQL.Database(buffer);

// Get rounds with T-20s data
const roundsResult = db.exec(`
  SELECT
    epoch, lock_ts, lock_price, close_price, winner,
    t20s_bull_wei, t20s_bear_wei, t20s_total_wei,
    bull_amount_wei, bear_amount_wei, total_amount_wei
  FROM rounds
  WHERE t20s_total_wei != "0"
  ORDER BY epoch ASC
`);

if (!roundsResult.length) {
  console.log('No rounds found!');
  process.exit(1);
}

const rounds = roundsResult[0].values;
console.log(`Loaded ${rounds.length} rounds with T-20s data\n`);

// Fetch TradingView candles
console.log('Fetching TradingView price data...');
const lockTimes = rounds.map(r => r[1]);
const startTime = Math.min(...lockTimes) - 3600;
const endTime = Math.max(...lockTimes) + 3600;

const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.BNB/USD&resolution=5&from=${startTime}&to=${endTime}`;
const response = await globalThis.fetch(url);
const candles = await response.json();

console.log(`Fetched ${candles.t.length} candles\n`);

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const emaArray = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    emaArray.push(prices[i] * k + emaArray[i - 1] * (1 - k));
  }
  return emaArray;
}

// Build candle map
const candleMap = new Map();
for (let i = 0; i < candles.t.length; i++) {
  candleMap.set(candles.t[i], candles.c[i]);
}

const sortedCandles = candles.t.map((time, idx) => [time, candles.c[idx]]);
const closePrices = candles.c;

const emaFast = calculateEMA(closePrices, CONFIG.STRATEGY.emaFast);
const emaSlow = calculateEMA(closePrices, CONFIG.STRATEGY.emaSlow);

const emaFastMap = new Map();
const emaSlowMap = new Map();
sortedCandles.forEach(([time], idx) => {
  emaFastMap.set(time, emaFast[idx]);
  emaSlowMap.set(time, emaSlow[idx]);
});

console.log('Testing TWO scenarios:\n');
console.log('1. WRONG (current): Using FINAL pool for payout calculation');
console.log('2. CORRECT (fixed): Using T-20s IMPLIED payout\n');

// Run both simulations
function runSimulation(useFinalPayout) {
  let balance = 10.0;
  let wins = 0;
  let losses = 0;
  const trades = [];

  for (const round of rounds) {
    const [epoch, lockTs, lockPrice, closePrice, winner, t20sBull, t20sBear, t20sTotal, finalBull, finalBear, finalTotal] = round;

    const roundedLockTs = Math.floor(lockTs / 300) * 300;
    const fast = emaFastMap.get(roundedLockTs);
    const slow = emaSlowMap.get(roundedLockTs);

    if (!fast || !slow) continue;

    const emaDiff = Math.abs(fast - slow) / slow;
    if (emaDiff < CONFIG.STRATEGY.emaGap) continue;

    const emaBullish = fast > slow;
    const emaBearish = fast < slow;

    // Crowd signal (at T-20s)
    const t20sBullPct = Number(t20sBull) / Number(t20sTotal);
    const t20sBearPct = Number(t20sBear) / Number(t20sTotal);

    const crowdBullish = t20sBullPct >= CONFIG.STRATEGY.crowdThreshold;
    const crowdBearish = t20sBearPct >= CONFIG.STRATEGY.crowdThreshold;

    const signalBull = emaBullish && crowdBullish;
    const signalBear = emaBearish && crowdBearish;

    if (!signalBull && !signalBear) continue;

    // CRITICAL DIFFERENCE: Which payout do we use?
    let bullMultiple, bearMultiple;

    if (useFinalPayout) {
      // WRONG: Using final pool (future data we don't have)
      bullMultiple = Number(finalTotal) / Number(finalBull);
      bearMultiple = Number(finalTotal) / Number(finalBear);
    } else {
      // CORRECT: Using T-20s implied payout (what we actually know)
      bullMultiple = Number(t20sTotal) / Number(t20sBull);
      bearMultiple = Number(t20sTotal) / Number(t20sBear);
    }

    const position = signalBull ? 'BULL' : 'BEAR';
    const multiple = signalBull ? bullMultiple : bearMultiple;

    const priceUp = Number(closePrice) > Number(lockPrice);
    const won = (position === 'BULL' && priceUp) || (position === 'BEAR' && !priceUp);

    const betSize = balance * CONFIG.STRATEGY.positionSize;
    const payout = won ? betSize * multiple : 0;
    const profit = payout - betSize;

    balance += profit;
    if (won) wins++;
    else losses++;

    trades.push({
      epoch,
      position,
      multiple: multiple.toFixed(3),
      won,
      profit: profit.toFixed(4),
      balance: balance.toFixed(2)
    });
  }

  return { balance, wins, losses, trades };
}

console.log('═══════════════════════════════════════════════════════════\n');

const wrongResults = runSimulation(true);
console.log('❌ WRONG METHOD (using FINAL pool - future data):');
console.log(`   Starting: 10.00 BNB`);
console.log(`   Final: ${wrongResults.balance.toFixed(2)} BNB`);
console.log(`   Profit: ${(wrongResults.balance - 10).toFixed(2)} BNB`);
console.log(`   ROI: ${((wrongResults.balance / 10 - 1) * 100).toFixed(2)}%`);
console.log(`   Win Rate: ${(wrongResults.wins / (wrongResults.wins + wrongResults.losses) * 100).toFixed(2)}% (${wrongResults.wins}W / ${wrongResults.losses}L)`);
console.log(`   Total Trades: ${wrongResults.trades.length}\n`);

const correctResults = runSimulation(false);
console.log('✅ CORRECT METHOD (using T-20s IMPLIED payout):');
console.log(`   Starting: 10.00 BNB`);
console.log(`   Final: ${correctResults.balance.toFixed(2)} BNB`);
console.log(`   Profit: ${(correctResults.balance - 10).toFixed(2)} BNB`);
console.log(`   ROI: ${((correctResults.balance / 10 - 1) * 100).toFixed(2)}%`);
console.log(`   Win Rate: ${(correctResults.wins / (correctResults.wins + correctResults.losses) * 100).toFixed(2)}% (${correctResults.wins}W / ${correctResults.losses}L)`);
console.log(`   Total Trades: ${correctResults.trades.length}\n`);

console.log('═══════════════════════════════════════════════════════════\n');

const diff = correctResults.balance - wrongResults.balance;
const diffPct = ((correctResults.balance / wrongResults.balance - 1) * 100);

if (diff > 0) {
  console.log(`✅ GOOD NEWS: Correct method performs BETTER by ${diff.toFixed(2)} BNB (${diffPct.toFixed(1)}% more)`);
} else if (diff < 0) {
  console.log(`⚠️ BAD NEWS: Correct method performs WORSE by ${Math.abs(diff).toFixed(2)} BNB (${Math.abs(diffPct).toFixed(1)}% less)`);
} else {
  console.log(`➖ SAME: Both methods produce identical results`);
}

console.log('\nFirst 10 trades comparison:\n');
console.log('Epoch      | Position | Wrong Multiple | Correct Multiple | Difference');
console.log('-----------|----------|----------------|------------------|------------');
for (let i = 0; i < Math.min(10, correctResults.trades.length); i++) {
  const w = wrongResults.trades[i];
  const c = correctResults.trades[i];
  const diff = (parseFloat(c.multiple) - parseFloat(w.multiple)).toFixed(3);
  console.log(`${w.epoch} | ${w.position.padEnd(8)} | ${w.multiple.padStart(14)} | ${c.multiple.padStart(16)} | ${diff.padStart(10)}`);
}

db.close();
