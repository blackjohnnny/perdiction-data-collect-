import initSqlJs from 'sql.js';
import fs from 'fs';

console.log('=== COMPREHENSIVE TIMEFRAME TEST ===\n');
console.log('Testing EMA 5/13 + Crowd strategy on different chart timeframes\n');

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

const rounds = allRounds[0].values.map(row => ({
  epoch: row[0],
  lockTs: row[1],
  closeTs: row[2],
  lockPrice: Number(BigInt(row[3])) / 1e8,
  closePrice: Number(BigInt(row[4])) / 1e8,
  winner: row[5]
}));

// Get snapshot epochs and their crowd data
const snapshotData = db.exec(`
  SELECT s.epoch, s.bull_amount_wei, s.bear_amount_wei, s.total_amount_wei
  FROM snapshots s
`);

const snapshotMap = new Map();
if (snapshotData[0]) {
  snapshotData[0].values.forEach(row => {
    const snapBull = BigInt(row[1]);
    const snapBear = BigInt(row[2]);
    const snapTotal = BigInt(row[3]);

    const snapBullPct = Number((snapBull * 10000n) / snapTotal) / 100;
    const snapBearPct = 100 - snapBullPct;

    const crowdBet = snapBull > snapBear ? 'UP' : 'DOWN';
    const threshold = Math.max(snapBullPct, snapBearPct);

    snapshotMap.set(row[0], {
      crowdBet,
      threshold
    });
  });
}

console.log(`Loaded ${rounds.length} rounds`);
console.log(`Loaded ${snapshotMap.size} snapshots\n`);
console.log('='.repeat(80));

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

// Helper: Aggregate rounds into candles
function aggregateToCandles(rounds, candleSizeMinutes) {
  if (candleSizeMinutes === 5) {
    // Each round IS a 5-minute candle
    return rounds.map(r => ({
      timestamp: r.closeTs,
      close: r.closePrice,
      epoch: r.epoch
    }));
  }

  // Group rounds into larger candles
  const candleDurationSeconds = candleSizeMinutes * 60;
  const candles = [];

  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i];
    const candleStartTime = Math.floor(round.closeTs / candleDurationSeconds) * candleDurationSeconds;

    // Find or create candle
    let candle = candles.find(c => c.timestamp === candleStartTime);
    if (!candle) {
      candle = {
        timestamp: candleStartTime,
        prices: [],
        epochs: []
      };
      candles.push(candle);
    }

    candle.prices.push(round.closePrice);
    candle.epochs.push(round.epoch);
  }

  // Use last price of each candle as close
  return candles.map(c => ({
    timestamp: c.timestamp,
    close: c.prices[c.prices.length - 1],
    epochs: c.epochs
  }));
}

// Test different timeframes
const timeframes = [
  { name: '1-minute', minutes: 1, description: '1 round = 5 candles' },
  { name: '5-minute', minutes: 5, description: '1 round = 1 candle (current)' },
  { name: '10-minute', minutes: 10, description: '1 candle = 2 rounds' },
  { name: '15-minute', minutes: 15, description: '1 candle = 3 rounds' },
  { name: '30-minute', minutes: 30, description: '1 candle = 6 rounds' },
  { name: '1-hour', minutes: 60, description: '1 candle = 12 rounds' },
  { name: '2-hour', minutes: 120, description: '1 candle = 24 rounds' },
  { name: '4-hour', minutes: 240, description: '1 candle = 48 rounds' },
];

console.log('\nTESTING DIFFERENT CHART TIMEFRAMES:\n');

const results = [];

for (const timeframe of timeframes) {
  console.log(`Testing ${timeframe.name} chart (${timeframe.description})...`);

  const candles = aggregateToCandles(rounds, timeframe.minutes);

  if (candles.length < 20) {
    console.log(`  ⚠ Insufficient data (only ${candles.length} candles)\n`);
    continue;
  }

  // Test EMA 5/13 on this timeframe
  let trades = 0;
  let wins = 0;

  const requiredHistory = 30; // Need enough candles for EMA calculation

  for (let i = requiredHistory; i < rounds.length; i++) {
    const round = rounds[i];
    const snapshot = snapshotMap.get(round.epoch);

    if (!snapshot || snapshot.threshold < 55) continue;

    // Find which candle this round belongs to
    const roundCandleTime = Math.floor(round.closeTs / (timeframe.minutes * 60)) * (timeframe.minutes * 60);
    const candleIndex = candles.findIndex(c => c.timestamp === roundCandleTime);

    if (candleIndex === -1 || candleIndex < 13) continue;

    // Get historical candle closes for EMA
    const historicalCloses = candles.slice(Math.max(0, candleIndex - requiredHistory), candleIndex).map(c => c.close);

    if (historicalCloses.length < 13) continue;

    const ema5 = calculateEMA(historicalCloses, 5);
    const ema13 = calculateEMA(historicalCloses, 13);

    if (!ema5 || !ema13) continue;

    const emaSignal = ema5 > ema13 ? 'UP' : 'DOWN';

    // Check if EMA agrees with crowd
    if (emaSignal === snapshot.crowdBet) {
      trades++;
      if (emaSignal === round.winner) {
        wins++;
      }
    }
  }

  const winRate = trades > 0 ? (wins / trades) * 100 : 0;
  const edge = winRate - 51.5;

  results.push({
    name: timeframe.name,
    minutes: timeframe.minutes,
    description: timeframe.description,
    trades,
    wins,
    winRate,
    edge
  });

  console.log(`  Trades: ${trades}, Wins: ${wins}, Win Rate: ${winRate.toFixed(1)}%, Edge: ${edge > 0 ? '+' : ''}${edge.toFixed(1)}%\n`);
}

console.log('='.repeat(80));
console.log('\nRESULTS RANKED BY WIN RATE:\n');

// Sort by win rate
results.sort((a, b) => b.winRate - a.winRate);

console.log('Rank | Timeframe    | Description              | Trades | Win Rate | Edge    | Quality');
console.log('-----|--------------|--------------------------|--------|----------|---------|--------');

results.forEach((result, index) => {
  const quality = result.edge > 15 ? 'EXCELLENT' :
                  result.edge > 10 ? 'GREAT' :
                  result.edge > 5 ? 'GOOD' :
                  result.edge > 0 ? 'OK' : 'POOR';

  console.log(`${(index + 1).toString().padStart(4)} | ${result.name.padEnd(12)} | ${result.description.padEnd(24)} | ` +
              `${result.trades.toString().padStart(6)} | ${result.winRate.toFixed(1).padStart(7)}% | ` +
              `${(result.edge > 0 ? '+' : '') + result.edge.toFixed(1).padStart(6)}% | ${quality}`);
});

console.log('\n' + '='.repeat(80));
console.log('\nKEY INSIGHTS:\n');

const best = results[0];
const current5min = results.find(r => r.minutes === 5);
const worst = results[results.length - 1];

console.log(`Best performing timeframe: ${best.name}`);
console.log(`  - Win rate: ${best.winRate.toFixed(1)}%`);
console.log(`  - Edge: ${best.edge > 0 ? '+' : ''}${best.edge.toFixed(1)}%`);
console.log(`  - Total trades: ${best.trades}`);
console.log('');

if (current5min) {
  console.log(`Current 5-minute timeframe:`);
  console.log(`  - Win rate: ${current5min.winRate.toFixed(1)}%`);
  console.log(`  - Edge: ${current5min.edge > 0 ? '+' : ''}${current5min.edge.toFixed(1)}%`);
  console.log(`  - Rank: #${results.indexOf(current5min) + 1} of ${results.length}`);

  if (best.minutes !== 5) {
    const improvement = best.winRate - current5min.winRate;
    console.log(`  - Improvement possible: +${improvement.toFixed(1)}% by switching to ${best.name}`);
  } else {
    console.log(`  - ✓ Already using the best timeframe!`);
  }
  console.log('');
}

console.log(`Worst performing timeframe: ${worst.name}`);
console.log(`  - Win rate: ${worst.winRate.toFixed(1)}%`);
console.log(`  - Edge: ${worst.edge > 0 ? '+' : ''}${worst.edge.toFixed(1)}%`);
console.log('');

// Analyze pattern
const shortTerm = results.filter(r => r.minutes <= 15);
const mediumTerm = results.filter(r => r.minutes > 15 && r.minutes <= 60);
const longTerm = results.filter(r => r.minutes > 60);

if (shortTerm.length > 0) {
  const avgShort = shortTerm.reduce((sum, r) => sum + r.winRate, 0) / shortTerm.length;
  console.log(`Short-term timeframes (≤15 min): ${avgShort.toFixed(1)}% average win rate`);
}

if (mediumTerm.length > 0) {
  const avgMedium = mediumTerm.reduce((sum, r) => sum + r.winRate, 0) / mediumTerm.length;
  console.log(`Medium-term timeframes (15-60 min): ${avgMedium.toFixed(1)}% average win rate`);
}

if (longTerm.length > 0) {
  const avgLong = longTerm.reduce((sum, r) => sum + r.winRate, 0) / longTerm.length;
  console.log(`Long-term timeframes (>60 min): ${avgLong.toFixed(1)}% average win rate`);
}

console.log('\n' + '='.repeat(80));
console.log('\nRECOMMENDATION:\n');

if (best.winRate >= current5min.winRate + 2) {
  console.log(`⚠ Consider switching to ${best.name} chart!`);
  console.log(`  Current (5-minute): ${current5min.winRate.toFixed(1)}% win rate`);
  console.log(`  ${best.name}: ${best.winRate.toFixed(1)}% win rate`);
  console.log(`  Improvement: +${(best.winRate - current5min.winRate).toFixed(1)}%`);
} else {
  console.log(`✓ 5-minute chart is optimal (or within 2% of best)`);
  console.log(`  Continue using EMA 5/13 on 5-minute candles.`);
}

console.log('\nNote: Each prediction round is 5 minutes long.');
console.log('      - Shorter timeframes (1-min) use intra-round price data (not available in current dataset)');
console.log('      - Longer timeframes (>5 min) smooth out short-term noise but may lag');
console.log('      - 5-minute = 1 round = 1 candle is the natural timeframe for this market');

db.close();
