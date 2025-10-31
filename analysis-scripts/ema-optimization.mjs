import initSqlJs from 'sql.js';
import fs from 'fs';

console.log('=== EMA OPTIMIZATION - Testing Different EMA Combinations ===\n');

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

// Get snapshot epochs and their crowd data
const snapshotData = db.exec(`
  SELECT s.epoch, s.bull_amount_wei, s.bear_amount_wei
  FROM snapshots s
`);

const snapshotMap = new Map();
if (snapshotData[0]) {
  snapshotData[0].values.forEach(row => {
    const bull = BigInt(row[1]);
    const bear = BigInt(row[2]);
    snapshotMap.set(row[0], {
      crowdBet: bull > bear ? 'UP' : 'DOWN'
    });
  });
}

console.log(`Loaded ${snapshotMap.size} snapshots with crowd data\n`);

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

// Test different EMA combinations
const emaCombinations = [
  { fast: 5, slow: 10, name: 'EMA 5/10 (very fast)' },
  { fast: 5, slow: 13, name: 'EMA 5/13' },
  { fast: 5, slow: 20, name: 'EMA 5/20' },
  { fast: 8, slow: 13, name: 'EMA 8/13 (Fibonacci)' },
  { fast: 9, slow: 21, name: 'EMA 9/21 (current)' },
  { fast: 10, slow: 20, name: 'EMA 10/20' },
  { fast: 10, slow: 30, name: 'EMA 10/30' },
  { fast: 12, slow: 26, name: 'EMA 12/26 (MACD default)' },
  { fast: 15, slow: 30, name: 'EMA 15/30' },
  { fast: 20, slow: 50, name: 'EMA 20/50 (classic)' },
  { fast: 21, slow: 55, name: 'EMA 21/55' },
  { fast: 50, slow: 100, name: 'EMA 50/100 (very slow)' },
  { fast: 50, slow: 200, name: 'EMA 50/200 (long-term)' }
];

const results = [];

console.log('Testing EMA combinations on 5-minute chart (1 round = 1 candle)...\n');

for (const combo of emaCombinations) {
  // Need enough history for the slower EMA
  const requiredHistory = Math.max(combo.slow + 10, 30);

  let correct = 0;
  let wrong = 0;
  let trades = 0;

  // For each round with snapshot data, check EMA at that time
  for (let i = requiredHistory; i < rounds.length; i++) {
    const round = rounds[i];

    // Only test on rounds where we have snapshot (crowd) data
    const snapshot = snapshotMap.get(round.epoch);
    if (!snapshot) continue;

    // Get historical closes (using close price of each round as candle close)
    const closes = rounds.slice(i - requiredHistory, i).map(r => r.closePrice);

    if (closes.length < combo.slow) continue;

    const emaFast = calculateEMA(closes, combo.fast);
    const emaSlow = calculateEMA(closes, combo.slow);

    if (!emaFast || !emaSlow) continue;

    // EMA signal
    const emaSignal = emaFast > emaSlow ? 'UP' : 'DOWN';

    // Strategy: EMA AND crowd agree
    if (emaSignal === snapshot.crowdBet) {
      trades++;
      if (emaSignal === round.winner) {
        correct++;
      } else {
        wrong++;
      }
    }
  }

  const total = correct + wrong;
  if (total > 0) {
    const winRate = (correct * 100 / total);
    const edge = winRate - 51.5;
    const profitable = edge > 0 ? '✓' : '✗';

    results.push({
      name: combo.name,
      fast: combo.fast,
      slow: combo.slow,
      wins: correct,
      losses: wrong,
      total,
      winRate,
      edge,
      profitable,
      trades
    });

    console.log(`${combo.name.padEnd(30)} ${correct}/${total} (${winRate.toFixed(1)}%) - Edge: ${edge > 0 ? '+' : ''}${edge.toFixed(1)}% ${profitable}`);
  }
}

console.log('\n' + '='.repeat(80));
console.log('\nRESULTS RANKED BY EDGE:\n');

// Sort by edge (best first)
results.sort((a, b) => b.edge - a.edge);

console.log('Rank | EMA Combination           | Win Rate | Edge    | Trades | Profitable');
console.log('-----+---------------------------+----------+---------+--------+-----------');

results.forEach((r, i) => {
  const rank = (i + 1).toString().padStart(2);
  const name = r.name.padEnd(25);
  const winRate = `${r.wins}/${r.total} (${r.winRate.toFixed(1)}%)`.padEnd(8);
  const edge = `${r.edge > 0 ? '+' : ''}${r.edge.toFixed(1)}%`.padStart(7);
  const trades = r.total.toString().padStart(6);
  const profitable = r.edge > 0 ? '   YES' : '    NO';

  console.log(`${rank}   | ${name} | ${winRate} | ${edge} | ${trades} | ${profitable}`);
});

console.log('\n' + '='.repeat(80));
console.log('\nTOP 3 PERFORMERS:\n');

for (let i = 0; i < Math.min(3, results.length); i++) {
  const r = results[i];
  console.log(`${i + 1}. ${r.name}`);
  console.log(`   Fast EMA: ${r.fast}, Slow EMA: ${r.slow}`);
  console.log(`   Win Rate: ${r.winRate.toFixed(1)}% (${r.wins} wins, ${r.losses} losses)`);
  console.log(`   Edge: ${r.edge > 0 ? '+' : ''}${r.edge.toFixed(1)}% ${r.edge > 0 ? '✓ PROFITABLE' : '✗ NOT PROFITABLE'}`);
  console.log(`   Total Trades: ${r.total}`);
  console.log('');
}

console.log('='.repeat(80));
console.log('\nCONCLUSION:\n');

const best = results[0];
const ema9_21 = results.find(r => r.fast === 9 && r.slow === 21);
const ema20_50 = results.find(r => r.fast === 20 && r.slow === 50);

console.log(`Best performing: ${best.name}`);
console.log(`  - ${best.winRate.toFixed(1)}% win rate with ${best.edge.toFixed(1)}% edge`);
console.log('');

if (ema9_21) {
  console.log(`EMA 9/21 (current): ${ema9_21.winRate.toFixed(1)}% win rate with ${ema9_21.edge.toFixed(1)}% edge`);
}

if (ema20_50) {
  console.log(`EMA 20/50 (classic): ${ema20_50.winRate.toFixed(1)}% win rate with ${ema20_50.edge.toFixed(1)}% edge`);
}

console.log('');

if (best === ema9_21) {
  console.log('✓ EMA 9/21 is already optimal!');
} else if (best === ema20_50) {
  console.log('✓ EMA 20/50 is the best choice!');
} else {
  console.log(`✓ ${best.name} outperforms both 9/21 and 20/50`);
  if (ema9_21 && ema20_50) {
    console.log(`  Improvement over 9/21: +${(best.edge - ema9_21.edge).toFixed(1)}%`);
    console.log(`  Improvement over 20/50: +${(best.edge - ema20_50.edge).toFixed(1)}%`);
  }
}

db.close();
