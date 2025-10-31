import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const dbBuffer = readFileSync('./data/live.db');
const db = new SQL.Database(dbBuffer);

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
    tradeNum: trades.length + 1,
    epoch,
    won,
    result: won ? 'W' : 'L'
  });
}

console.log(`Total trades: ${trades.length}\n`);

// Identify all streaks
let currentStreak = { type: trades[0].result, count: 1, startTrade: 1, startEpoch: trades[0].epoch };
const streaks = [];

for (let i = 1; i < trades.length; i++) {
  if (trades[i].result === currentStreak.type) {
    currentStreak.count++;
  } else {
    currentStreak.endTrade = i;
    currentStreak.endEpoch = trades[i - 1].epoch;
    streaks.push({ ...currentStreak });
    currentStreak = {
      type: trades[i].result,
      count: 1,
      startTrade: i + 1,
      startEpoch: trades[i].epoch
    };
  }
}
currentStreak.endTrade = trades.length;
currentStreak.endEpoch = trades[trades.length - 1].epoch;
streaks.push(currentStreak);

const winStreaks = streaks.filter(s => s.type === 'W');
const lossStreaks = streaks.filter(s => s.type === 'L');

console.log('='.repeat(100));
console.log('DETAILED LOSS STREAK ANALYSIS');
console.log('='.repeat(100));
console.log();

// Group loss streaks by length
const lossStreaksByLength = {};
lossStreaks.forEach(streak => {
  if (!lossStreaksByLength[streak.count]) {
    lossStreaksByLength[streak.count] = [];
  }
  lossStreaksByLength[streak.count].push(streak);
});

Object.keys(lossStreaksByLength).sort((a, b) => Number(a) - Number(b)).forEach(length => {
  const streaksOfLength = lossStreaksByLength[length];
  console.log(`${length} Consecutive Losses: ${streaksOfLength.length} times`);
  console.log('-'.repeat(100));

  streaksOfLength.forEach((streak, idx) => {
    console.log(`  Occurrence ${idx + 1}:`);
    console.log(`    Trades: #${streak.startTrade} to #${streak.endTrade}`);
    console.log(`    Epochs: ${streak.startEpoch} to ${streak.endEpoch}`);
    console.log();
  });
});

console.log('='.repeat(100));
console.log('DETAILED WIN STREAK ANALYSIS');
console.log('='.repeat(100));
console.log();

// Group win streaks by length
const winStreaksByLength = {};
winStreaks.forEach(streak => {
  if (!winStreaksByLength[streak.count]) {
    winStreaksByLength[streak.count] = [];
  }
  winStreaksByLength[streak.count].push(streak);
});

Object.keys(winStreaksByLength).sort((a, b) => Number(a) - Number(b)).forEach(length => {
  const streaksOfLength = winStreaksByLength[length];
  console.log(`${length} Consecutive Wins: ${streaksOfLength.length} times`);
  console.log('-'.repeat(100));

  streaksOfLength.forEach((streak, idx) => {
    console.log(`  Occurrence ${idx + 1}:`);
    console.log(`    Trades: #${streak.startTrade} to #${streak.endTrade}`);
    console.log(`    Epochs: ${streak.startEpoch} to ${streak.endEpoch}`);
    console.log();
  });
});

console.log('='.repeat(100));
console.log('PROBABILITY ANALYSIS');
console.log('='.repeat(100));
console.log();

// Calculate probabilities
const totalWins = trades.filter(t => t.won).length;
const totalLosses = trades.filter(t => !t.won).length;
const baselineWinRate = (totalWins / trades.length) * 100;

console.log(`Baseline Statistics:`);
console.log(`  Total Trades: ${trades.length}`);
console.log(`  Wins: ${totalWins} (${baselineWinRate.toFixed(2)}%)`);
console.log(`  Losses: ${totalLosses} (${((totalLosses / trades.length) * 100).toFixed(2)}%)`);
console.log();

// Probability of streak lengths
console.log('Probability of Experiencing Each Streak Length:');
console.log('-'.repeat(100));

for (let len = 1; len <= 7; len++) {
  const winStreaksOfLen = (winStreaksByLength[len] || []).length;
  const lossStreaksOfLen = (lossStreaksByLength[len] || []).length;

  console.log(`${len} in a row:`);
  console.log(`  Win streaks: ${winStreaksOfLen} times (${((winStreaksOfLen / winStreaks.length) * 100).toFixed(1)}% of all win streaks)`);
  console.log(`  Loss streaks: ${lossStreaksOfLen} times (${((lossStreaksOfLen / lossStreaks.length) * 100).toFixed(1)}% of all loss streaks)`);
  console.log();
}

console.log('='.repeat(100));
console.log('DETAILED TRANSITION ANALYSIS');
console.log('='.repeat(100));
console.log();

// Analyze what comes after each streak length
for (let len = 1; len <= 5; len++) {
  const afterWinStreak = [];
  const afterLossStreak = [];

  // Find all instances where we had exactly 'len' wins/losses
  for (let i = len; i < trades.length; i++) {
    let allWins = true;
    let allLosses = true;

    for (let j = 0; j < len; j++) {
      if (trades[i - len + j].result !== 'W') allWins = false;
      if (trades[i - len + j].result !== 'L') allLosses = false;
    }

    // Make sure the streak is exactly 'len' long (not part of longer streak)
    if (i > len && trades[i - len - 1].result === 'W') allWins = false;
    if (i > len && trades[i - len - 1].result === 'L') allLosses = false;

    if (allWins) afterWinStreak.push(trades[i].result);
    if (allLosses) afterLossStreak.push(trades[i].result);
  }

  if (afterWinStreak.length > 0) {
    const winsAfter = afterWinStreak.filter(r => r === 'W').length;
    const lossesAfter = afterWinStreak.filter(r => r === 'L').length;
    console.log(`After EXACTLY ${len} win${len > 1 ? 's' : ''} in a row:`);
    console.log(`  Sample size: ${afterWinStreak.length} occurrences`);
    console.log(`  Next result: ${winsAfter}W / ${lossesAfter}L`);
    console.log(`  Win rate: ${((winsAfter / afterWinStreak.length) * 100).toFixed(2)}%`);
    console.log(`  vs Baseline: ${((winsAfter / afterWinStreak.length) * 100 - baselineWinRate).toFixed(2)}% ${(winsAfter / afterWinStreak.length) * 100 > baselineWinRate ? '📈' : '📉'}`);
    console.log();
  }

  if (afterLossStreak.length > 0) {
    const winsAfter = afterLossStreak.filter(r => r === 'W').length;
    const lossesAfter = afterLossStreak.filter(r => r === 'L').length;
    console.log(`After EXACTLY ${len} loss${len > 1 ? 'es' : ''} in a row:`);
    console.log(`  Sample size: ${afterLossStreak.length} occurrences`);
    console.log(`  Next result: ${winsAfter}W / ${lossesAfter}L`);
    console.log(`  Win rate: ${((winsAfter / afterLossStreak.length) * 100).toFixed(2)}%`);
    console.log(`  vs Baseline: ${((winsAfter / afterLossStreak.length) * 100 - baselineWinRate).toFixed(2)}% ${(winsAfter / afterLossStreak.length) * 100 > baselineWinRate ? '📈' : '📉'}`);
    console.log();
  }
}

console.log('='.repeat(100));
console.log('RISK ANALYSIS: What are the chances of long losing streaks?');
console.log('='.repeat(100));
console.log();

const maxLossStreak = Math.max(...lossStreaks.map(s => s.count));
console.log(`Worst case observed: ${maxLossStreak} consecutive losses`);
console.log();

for (let len = 3; len <= maxLossStreak; len++) {
  const count = (lossStreaksByLength[len] || []).length;
  const probability = (count / lossStreaks.length) * 100;
  console.log(`${len}+ consecutive losses: Happened ${count} time(s) out of ${lossStreaks.length} loss streaks (${probability.toFixed(1)}%)`);
}

db.close();
