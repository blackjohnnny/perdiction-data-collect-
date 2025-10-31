import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

// ============================================================================
// CONFIGURATION - Change these parameters to test different scenarios
// ============================================================================

const CONFIG = {
  // Database selection
  DATABASE: './data/live.db',  // Use live.db for rounds with T-20s data

  // Round selection
  ROUNDS: {
    mode: 'all',        // Options: 'all', 'latest', 'range', 'first'
    count: 150,         // Used when mode = 'latest' or 'first'
    from: 423620,       // Used when mode = 'range'
    to: 425000          // Used when mode = 'range'
  },

  // Strategy parameters
  STRATEGY: {
    emaFast: 3,                 // Fast EMA period
    emaSlow: 7,                 // Slow EMA period
    emaGap: 0.0005,            // Minimum EMA gap (0.05%)
    crowdThreshold: 0.65,      // Crowd threshold (65%)
    positionSize: 0.065        // Position size per trade (6.5%)
  }
};

// ============================================================================
// STRATEGY LOGIC - Do not modify unless changing strategy
// ============================================================================

const SQL = await initSqlJs();
const dbBuffer = readFileSync(CONFIG.DATABASE);
const db = new SQL.Database(dbBuffer);

console.log('Loading rounds from database...\n');

// Build query based on ROUNDS configuration
let query = 'SELECT epoch, lock_ts, lock_price, close_price, winner, t20s_bull_wei, t20s_bear_wei, t20s_total_wei, bull_amount_wei, bear_amount_wei, total_amount_wei FROM rounds';
let orderBy = ' ORDER BY epoch ASC';
let limit = '';

if (CONFIG.ROUNDS.mode === 'latest') {
  orderBy = ' ORDER BY epoch DESC';
  limit = ` LIMIT ${CONFIG.ROUNDS.count}`;
} else if (CONFIG.ROUNDS.mode === 'first') {
  limit = ` LIMIT ${CONFIG.ROUNDS.count}`;
} else if (CONFIG.ROUNDS.mode === 'range') {
  query += ` WHERE epoch >= ${CONFIG.ROUNDS.from} AND epoch <= ${CONFIG.ROUNDS.to}`;
}

const roundsData = db.exec(query + orderBy + limit)[0];

if (!roundsData || roundsData.values.length === 0) {
  console.log('No rounds found!');
  process.exit(1);
}

const rounds = CONFIG.ROUNDS.mode === 'latest'
  ? roundsData.values.reverse()
  : roundsData.values;

console.log(`Loaded ${rounds.length} rounds\n`);

// Fetch TradingView candles
console.log('Fetching TradingView price data...');
const lockTimes = rounds.map(r => r[1]);
const startTime = Math.min(...lockTimes) - 3600;
const endTime = Math.max(...lockTimes) + 3600;

const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.BNB/USD&resolution=5&from=${startTime}&to=${endTime}`;
const response = await globalThis.fetch(url);
const candles = await response.json();

console.log(`Fetched ${candles.t.length} candles\n`);

// Build candle map
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

const emaFast = calculateEMA(closePrices, CONFIG.STRATEGY.emaFast);
const emaSlow = calculateEMA(closePrices, CONFIG.STRATEGY.emaSlow);

const emaFastMap = new Map();
const emaSlowMap = new Map();
sortedCandles.forEach(([time], idx) => {
  emaFastMap.set(time, emaFast[idx]);
  emaSlowMap.set(time, emaSlow[idx]);
});

console.log(`Calculated EMA ${CONFIG.STRATEGY.emaFast}/${CONFIG.STRATEGY.emaSlow}\n`);
console.log('Running strategy simulation...\n');

// Simulate strategy
let balance = 1.0;
let wins = 0;
let losses = 0;
const trades = [];

for (const round of rounds) {
  const [epoch, lockTs, lockPrice, closePrice, winner, t20sBull, t20sBear, t20sTotal, finalBull, finalBear, finalTotal] = round;

  // Get EMA values
  const roundedLockTs = Math.floor(lockTs / 300) * 300;
  const fast = emaFastMap.get(roundedLockTs);
  const slow = emaSlowMap.get(roundedLockTs);

  if (!fast || !slow) continue;

  // EMA signal
  const emaDiff = Math.abs(fast - slow) / slow;
  if (emaDiff < CONFIG.STRATEGY.emaGap) continue;

  const emaBullish = fast > slow;
  const emaBearish = fast < slow;

  // Crowd signal
  const t20sBullPct = Number(t20sBull) / Number(t20sTotal);
  const t20sBearPct = Number(t20sBear) / Number(t20sTotal);

  const crowdBullish = t20sBullPct >= CONFIG.STRATEGY.crowdThreshold;
  const crowdBearish = t20sBearPct >= CONFIG.STRATEGY.crowdThreshold;

  // Must agree
  const signalBull = emaBullish && crowdBullish;
  const signalBear = emaBearish && crowdBearish;

  if (!signalBull && !signalBear) continue;

  // Calculate multiples
  const bullMultiple = Number(finalTotal) / Number(finalBull);
  const bearMultiple = Number(finalTotal) / Number(finalBear);

  const position = signalBull ? 'BULL' : 'BEAR';
  const multiple = signalBull ? bullMultiple : bearMultiple;

  // Determine winner
  const priceUp = Number(closePrice) > Number(lockPrice);
  const won = (position === 'BULL' && priceUp) || (position === 'BEAR' && !priceUp);

  // Calculate P&L
  const betSize = balance * CONFIG.STRATEGY.positionSize;
  const payout = won ? betSize * multiple : 0;
  const profit = payout - betSize;

  balance += profit;
  if (won) wins++;
  else losses++;

  trades.push({
    epoch,
    position,
    emaDiff: (emaDiff * 100).toFixed(3),
    crowdPct: (signalBull ? t20sBullPct * 100 : t20sBearPct * 100).toFixed(1),
    multiple: multiple.toFixed(3),
    won,
    profit,
    balance
  });
}

// Display results
console.log('='.repeat(80));
console.log('STRATEGY TEST RESULTS');
console.log('='.repeat(80));
console.log();
console.log('Configuration:');
console.log(`  Database: ${CONFIG.DATABASE}`);
console.log(`  Rounds: ${CONFIG.ROUNDS.mode === 'all' ? 'All' : CONFIG.ROUNDS.mode === 'latest' ? `Latest ${CONFIG.ROUNDS.count}` : CONFIG.ROUNDS.mode === 'first' ? `First ${CONFIG.ROUNDS.count}` : `Range ${CONFIG.ROUNDS.from}-${CONFIG.ROUNDS.to}`}`);
console.log(`  EMA: ${CONFIG.STRATEGY.emaFast}/${CONFIG.STRATEGY.emaSlow} (gap: ${(CONFIG.STRATEGY.emaGap * 100).toFixed(2)}%)`);
console.log(`  Crowd Threshold: ${(CONFIG.STRATEGY.crowdThreshold * 100).toFixed(0)}%`);
console.log(`  Position Size: ${(CONFIG.STRATEGY.positionSize * 100).toFixed(1)}%`);
console.log();
console.log('Results:');
console.log(`  Rounds analyzed: ${rounds.length}`);
console.log(`  Trades entered: ${trades.length}`);
console.log(`  Trade frequency: ${((trades.length / rounds.length) * 100).toFixed(1)}%`);
console.log();
console.log(`  Wins: ${wins}`);
console.log(`  Losses: ${losses}`);
console.log(`  Win rate: ${trades.length > 0 ? ((wins / trades.length) * 100).toFixed(2) : 0}%`);
console.log();
console.log(`  Starting balance: 1.0000 BNB`);
console.log(`  Final balance: ${balance.toFixed(4)} BNB`);
console.log(`  Total profit: ${(balance - 1.0).toFixed(4)} BNB`);
console.log(`  ROI: ${(((balance - 1.0) / 1.0) * 100).toFixed(2)}%`);
console.log();
console.log('='.repeat(80));

if (trades.length > 0) {
  const showCount = Math.min(30, trades.length);
  console.log();
  console.log(`First ${showCount} Trades:`);
  console.log('-'.repeat(90));
  console.log('Epoch      | Pos  | EMA Gap | Crowd | Mult  | Result | Profit    | Balance');
  console.log('-'.repeat(90));
  trades.slice(0, showCount).forEach(t => {
    const result = t.won ? 'WIN ✓' : 'LOSS ✗';
    const profitStr = t.profit >= 0 ? `+${t.profit.toFixed(4)}` : t.profit.toFixed(4);
    console.log(
      `${t.epoch} | ${t.position} | ${t.emaDiff}%  | ${t.crowdPct}%  | ${t.multiple} | ${result.padEnd(6)} | ${profitStr.padStart(9)} | ${t.balance.toFixed(4)}`
    );
  });
}

db.close();
