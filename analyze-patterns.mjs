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

// Fetch TradingView candles
const lockTimes = rounds.map(r => r[1]);
const startTime = Math.min(...lockTimes) - 3600;
const endTime = Math.max(...lockTimes) + 3600;

console.log('Fetching TradingView data...');
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

console.log('Running strategy simulation...\n');

// Strategy parameters
const POSITION_SIZE = 0.065;
const EMA_GAP = 0.0005;
const CROWD_THRESHOLD = 0.65;

// Collect all trades
const trades = [];

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

  const priceUp = Number(closePrice) > Number(lockPrice);
  const won = (signalBull && priceUp) || (signalBear && !priceUp);

  trades.push({
    epoch,
    won: won ? 'W' : 'L'
  });
}

console.log(`Analyzing ${trades.length} trades for patterns...\n`);

// Pattern Analysis: What happens after N consecutive wins/losses?

function analyzePattern(previousPattern) {
  let matches = 0;
  let nextWins = 0;
  let nextLosses = 0;

  for (let i = previousPattern.length; i < trades.length; i++) {
    let match = true;
    for (let j = 0; j < previousPattern.length; j++) {
      if (trades[i - previousPattern.length + j].won !== previousPattern[j]) {
        match = false;
        break;
      }
    }

    if (match) {
      matches++;
      if (trades[i].won === 'W') nextWins++;
      else nextLosses++;
    }
  }

  return { matches, nextWins, nextLosses, winRate: matches > 0 ? (nextWins / matches) * 100 : 0 };
}

console.log('='.repeat(90));
console.log('WIN/LOSS PATTERN ANALYSIS');
console.log('='.repeat(90));
console.log();

console.log('What happens AFTER consecutive wins?');
console.log('-'.repeat(90));
const afterWins = [
  { pattern: ['W'], label: 'After 1 win' },
  { pattern: ['W', 'W'], label: 'After 2 wins' },
  { pattern: ['W', 'W', 'W'], label: 'After 3 wins' },
  { pattern: ['W', 'W', 'W', 'W'], label: 'After 4 wins' },
  { pattern: ['W', 'W', 'W', 'W', 'W'], label: 'After 5 wins' }
];

afterWins.forEach(({ pattern, label }) => {
  const result = analyzePattern(pattern);
  if (result.matches > 0) {
    console.log(`${label}:`);
    console.log(`  Occurrences: ${result.matches} times`);
    console.log(`  Next trade: ${result.nextWins}W / ${result.nextLosses}L`);
    console.log(`  Win rate: ${result.winRate.toFixed(2)}%`);
    console.log();
  }
});

console.log('What happens AFTER consecutive losses?');
console.log('-'.repeat(90));
const afterLosses = [
  { pattern: ['L'], label: 'After 1 loss' },
  { pattern: ['L', 'L'], label: 'After 2 losses' },
  { pattern: ['L', 'L', 'L'], label: 'After 3 losses' },
  { pattern: ['L', 'L', 'L', 'L'], label: 'After 4 losses' },
  { pattern: ['L', 'L', 'L', 'L', 'L'], label: 'After 5 losses' }
];

afterLosses.forEach(({ pattern, label }) => {
  const result = analyzePattern(pattern);
  if (result.matches > 0) {
    console.log(`${label}:`);
    console.log(`  Occurrences: ${result.matches} times`);
    console.log(`  Next trade: ${result.nextWins}W / ${result.nextLosses}L`);
    console.log(`  Win rate: ${result.winRate.toFixed(2)}%`);
    console.log();
  }
});

console.log('What happens AFTER alternating patterns?');
console.log('-'.repeat(90));
const alternating = [
  { pattern: ['W', 'L'], label: 'After Win → Loss' },
  { pattern: ['L', 'W'], label: 'After Loss → Win' },
  { pattern: ['W', 'L', 'W'], label: 'After Win → Loss → Win' },
  { pattern: ['L', 'W', 'L'], label: 'After Loss → Win → Loss' },
  { pattern: ['W', 'W', 'L'], label: 'After 2 Wins → Loss' },
  { pattern: ['L', 'L', 'W'], label: 'After 2 Losses → Win' }
];

alternating.forEach(({ pattern, label }) => {
  const result = analyzePattern(pattern);
  if (result.matches > 0) {
    console.log(`${label}:`);
    console.log(`  Occurrences: ${result.matches} times`);
    console.log(`  Next trade: ${result.nextWins}W / ${result.nextLosses}L`);
    console.log(`  Win rate: ${result.winRate.toFixed(2)}%`);
    console.log();
  }
});

// Streak analysis
console.log('='.repeat(90));
console.log('STREAK ANALYSIS');
console.log('='.repeat(90));
console.log();

let currentStreak = { type: trades[0].won, count: 1 };
const streaks = [];

for (let i = 1; i < trades.length; i++) {
  if (trades[i].won === currentStreak.type) {
    currentStreak.count++;
  } else {
    streaks.push({ ...currentStreak });
    currentStreak = { type: trades[i].won, count: 1 };
  }
}
streaks.push(currentStreak);

const winStreaks = streaks.filter(s => s.type === 'W').map(s => s.count);
const lossStreaks = streaks.filter(s => s.type === 'L').map(s => s.count);

console.log('Win Streaks:');
console.log(`  Longest: ${Math.max(...winStreaks)} consecutive wins`);
console.log(`  Average: ${(winStreaks.reduce((a, b) => a + b, 0) / winStreaks.length).toFixed(2)} wins`);
console.log(`  Most common: ${mode(winStreaks)} wins`);
console.log();

console.log('Loss Streaks:');
console.log(`  Longest: ${Math.max(...lossStreaks)} consecutive losses`);
console.log(`  Average: ${(lossStreaks.reduce((a, b) => a + b, 0) / lossStreaks.length).toFixed(2)} losses`);
console.log(`  Most common: ${mode(lossStreaks)} losses`);
console.log();

// Distribution
console.log('Win Streak Distribution:');
const winStreakDist = {};
winStreaks.forEach(s => {
  winStreakDist[s] = (winStreakDist[s] || 0) + 1;
});
Object.entries(winStreakDist).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([len, count]) => {
  console.log(`  ${len} wins in a row: ${count} times`);
});
console.log();

console.log('Loss Streak Distribution:');
const lossStreakDist = {};
lossStreaks.forEach(s => {
  lossStreakDist[s] = (lossStreakDist[s] || 0) + 1;
});
Object.entries(lossStreakDist).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([len, count]) => {
  console.log(`  ${len} losses in a row: ${count} times`);
});

function mode(arr) {
  const counts = {};
  arr.forEach(val => counts[val] = (counts[val] || 0) + 1);
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

console.log();
console.log('='.repeat(90));
console.log('BASELINE: Overall win rate is ' + ((trades.filter(t => t.won === 'W').length / trades.length) * 100).toFixed(2) + '%');
console.log('='.repeat(90));

db.close();
