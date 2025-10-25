import initSqlJs from 'sql.js';
import fs from 'fs';
import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';

const RPC_URL = process.env.RPC_URL || 'https://bsc-dataseed1.binance.org';

const client = createPublicClient({
  chain: bsc,
  transport: http(RPC_URL),
});

const CHAINLINK_BNB_USD = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';

const ABI = [
  {
    inputs: [{ internalType: 'uint80', name: 'roundId', type: 'uint80' }],
    name: 'getRoundData',
    outputs: [
      { internalType: 'uint80', name: 'roundId', type: 'uint80' },
      { internalType: 'int256', name: 'answer', type: 'int256' },
      { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
      { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
      { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { internalType: 'uint80', name: 'roundId', type: 'uint80' },
      { internalType: 'int256', name: 'answer', type: 'int256' },
      { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
      { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
      { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

console.log('=== EMA TIMEFRAME ANALYSIS ===\n');
console.log('First, let\'s check Chainlink update frequency...\n');

// Get latest round and check update frequency
const latest = await client.readContract({
  address: CHAINLINK_BNB_USD,
  abi: ABI,
  functionName: 'latestRoundData',
});

const latestRoundId = latest[0];
console.log(`Latest Chainlink round: ${latestRoundId}`);

// Check last 10 rounds to determine update frequency
const timestamps = [];
for (let i = 0; i < 10; i++) {
  try {
    const roundData = await client.readContract({
      address: CHAINLINK_BNB_USD,
      abi: ABI,
      functionName: 'getRoundData',
      args: [latestRoundId - BigInt(i)],
    });
    timestamps.push(Number(roundData[3]));
  } catch (e) {
    break;
  }
}

const intervals = [];
for (let i = 1; i < timestamps.length; i++) {
  intervals.push(timestamps[i - 1] - timestamps[i]);
}

const avgInterval = intervals.reduce((sum, val) => sum + val, 0) / intervals.length;
console.log(`Average Chainlink update interval: ${avgInterval.toFixed(0)} seconds (${(avgInterval / 60).toFixed(1)} minutes)`);
console.log('Each Chainlink update = 1 "candle" for EMA\n');

// Now test on different CONSTRUCTED timeframes
console.log('='.repeat(80));
console.log('Testing EMA on different chart timeframes:\n');

const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync('prediction-data.db'));

// Get all rounds from last 30 days with prices
const allRounds = db.exec(`
  SELECT epoch, lock_ts, close_ts, lock_price, close_price, winner
  FROM rounds
  WHERE lock_ts >= ${Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60)}
  AND winner IN ('UP', 'DOWN')
  ORDER BY lock_ts ASC
`);

if (!allRounds[0] || allRounds[0].values.length === 0) {
  console.log('No round data found');
  db.close();
  process.exit(0);
}

const rounds = allRounds[0].values.map(row => ({
  epoch: row[0],
  lockTs: row[1],
  closeTs: row[2],
  lockPrice: Number(BigInt(row[3])) / 1e8,
  closePrice: Number(BigInt(row[4])) / 1e8,
  winner: row[5]
}));

console.log(`Loaded ${rounds.length} rounds for analysis\n`);

// Helper: Build OHLC candles from 5-min rounds
function buildCandles(rounds, candleMinutes) {
  const candles = [];
  const candleSeconds = candleMinutes * 60;

  let currentCandleStart = Math.floor(rounds[0].lockTs / candleSeconds) * candleSeconds;

  let open = rounds[0].lockPrice;
  let high = rounds[0].lockPrice;
  let low = rounds[0].lockPrice;
  let close = rounds[0].lockPrice;
  let candleRounds = [];

  for (const round of rounds) {
    const candleStart = Math.floor(round.lockTs / candleSeconds) * candleSeconds;

    if (candleStart !== currentCandleStart) {
      // Close current candle
      candles.push({ open, high, low, close, timestamp: currentCandleStart, rounds: candleRounds });

      // Start new candle
      currentCandleStart = candleStart;
      open = round.lockPrice;
      high = round.lockPrice;
      low = round.lockPrice;
      close = round.closePrice;
      candleRounds = [round];
    } else {
      // Update current candle
      high = Math.max(high, round.lockPrice, round.closePrice);
      low = Math.min(low, round.lockPrice, round.closePrice);
      close = round.closePrice;
      candleRounds.push(round);
    }
  }

  // Close last candle
  if (candleRounds.length > 0) {
    candles.push({ open, high, low, close, timestamp: currentCandleStart, rounds: candleRounds });
  }

  return candles;
}

// Helper: Calculate EMA
function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, p) => sum + p, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

// Test different timeframes
const timeframes = [
  { minutes: 5, name: '5-minute (1 round = 1 candle)' },
  { minutes: 15, name: '15-minute (3 rounds = 1 candle)' },
  { minutes: 30, name: '30-minute (6 rounds = 1 candle)' },
  { minutes: 60, name: '1-hour (12 rounds = 1 candle)' },
  { minutes: 240, name: '4-hour (48 rounds = 1 candle)' }
];

const snapshotEpochs = new Set(
  db.exec('SELECT DISTINCT epoch FROM snapshots')[0].values.map(row => row[0])
);

const results = [];

for (const tf of timeframes) {
  console.log(`Testing ${tf.name}...`);

  const candles = buildCandles(rounds, tf.minutes);

  if (candles.length < 30) {
    console.log(`  Skipped - not enough candles\n`);
    continue;
  }

  let correct = 0;
  let wrong = 0;
  let snapshotCorrect = 0;
  let snapshotWrong = 0;

  // For each round, check EMA at that time
  for (let i = 30; i < rounds.length; i++) {
    const round = rounds[i];

    // Find which candle this round belongs to
    const candleIdx = candles.findIndex(c =>
      round.lockTs >= c.timestamp &&
      round.lockTs < c.timestamp + (tf.minutes * 60)
    );

    if (candleIdx === -1 || candleIdx < 30) continue;

    // Get candle closes up to (but not including) current candle
    const closes = candles.slice(Math.max(0, candleIdx - 30), candleIdx).map(c => c.close);

    if (closes.length < 26) continue;

    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);

    if (!ema9 || !ema21) continue;

    // Determine crowd bet
    const bullAmount = round.bullAmount || 0;
    const bearAmount = round.bearAmount || 0;

    // For rounds without snapshot data, estimate from pool at lock
    let crowdBet;
    if (snapshotEpochs.has(round.epoch)) {
      // Use actual snapshot data
      const snapshot = db.exec(`SELECT bull_amount_wei, bear_amount_wei FROM snapshots WHERE epoch = ${round.epoch}`);
      if (snapshot[0] && snapshot[0].values[0]) {
        const bull = BigInt(snapshot[0].values[0][0]);
        const bear = BigInt(snapshot[0].values[0][1]);
        crowdBet = bull > bear ? 'UP' : 'DOWN';
      }
    }

    // EMA signal
    const emaSignal = ema9 > ema21 ? 'UP' : 'DOWN';

    // Strategy: EMA AND crowd agree (only test when we have crowd data)
    if (crowdBet && emaSignal === crowdBet) {
      if (emaSignal === round.winner) {
        correct++;
        if (snapshotEpochs.has(round.epoch)) snapshotCorrect++;
      } else {
        wrong++;
        if (snapshotEpochs.has(round.epoch)) snapshotWrong++;
      }
    }
  }

  const total = correct + wrong;
  if (total > 0) {
    const winRate = (correct * 100 / total);
    const edge = winRate - 51.5;

    const snapTotal = snapshotCorrect + snapshotWrong;
    const snapWinRate = snapTotal > 0 ? (snapshotCorrect * 100 / snapTotal) : 0;
    const snapEdge = snapWinRate - 51.5;

    results.push({
      timeframe: tf.name,
      minutes: tf.minutes,
      wins: correct,
      total,
      winRate,
      edge,
      snapWins: snapshotCorrect,
      snapTotal,
      snapWinRate,
      snapEdge
    });

    console.log(`  All data: ${correct}/${total} (${winRate.toFixed(1)}%) - Edge: ${edge > 0 ? '+' : ''}${edge.toFixed(1)}%`);
    console.log(`  Snapshots: ${snapshotCorrect}/${snapTotal} (${snapWinRate.toFixed(1)}%) - Edge: ${snapEdge > 0 ? '+' : ''}${snapEdge.toFixed(1)}%\n`);
  } else {
    console.log(`  No valid trades\n`);
  }
}

console.log('='.repeat(80));
console.log('\nRESULTS SUMMARY:\n');

results.sort((a, b) => b.snapEdge - a.snapEdge);

console.log('Timeframe Performance (sorted by snapshot edge):\n');
results.forEach((r, i) => {
  console.log(`${i + 1}. ${r.timeframe}`);
  console.log(`   Snapshot data: ${r.snapWins}/${r.snapTotal} = ${r.snapWinRate.toFixed(1)}% (${r.snapEdge > 0 ? '+' : ''}${r.snapEdge.toFixed(1)}% edge)`);
  console.log(`   All data: ${r.wins}/${r.total} = ${r.winRate.toFixed(1)}% (${r.edge > 0 ? '+' : ''}${r.edge.toFixed(1)}% edge)`);
  console.log('');
});

console.log('='.repeat(80));
console.log('\nRECOMMENDATION:\n');

const best = results[0];
console.log(`Best timeframe: ${best.timeframe}`);
console.log(`  - ${best.snapWinRate.toFixed(1)}% win rate on snapshot data`);
console.log(`  - ${best.snapEdge > 0 ? '+' : ''}${best.snapEdge.toFixed(1)}% edge (need >51.5% to profit)`);
console.log(`  - Use EMA 9 and EMA 21 on ${best.timeframe} charts`);
console.log(`  - Only bet when EMA 9 > EMA 21 AND crowd agrees on UP (or vice versa for DOWN)`);

db.close();
