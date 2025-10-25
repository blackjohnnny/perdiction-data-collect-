import initSqlJs from 'sql.js';
import fs from 'fs';

console.log('=== EMA vs CROWD vs COMBINED STRATEGY ===\n');

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
  SELECT s.epoch, s.bull_amount_wei, s.bear_amount_wei
  FROM snapshots s
`);

const snapshotMap = new Map();
if (snapshotData[0]) {
  snapshotData[0].values.forEach(row => {
    const bull = BigInt(row[1]);
    const bear = BigInt(row[2]);
    snapshotMap.set(row[0], {
      crowdBet: bull > bear ? 'UP' : 'DOWN',
      bull,
      bear
    });
  });
}

console.log(`Testing on ${snapshotMap.size} snapshot rounds\n`);

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

// Test 3 strategies
const strategies = {
  ema_only: { correct: 0, wrong: 0 },
  crowd_only: { correct: 0, wrong: 0 },
  ema_AND_crowd: { correct: 0, wrong: 0 },
  ema_OR_crowd: { correct: 0, wrong: 0 },
  ema_CONTRADICT_crowd: { correct: 0, wrong: 0 }
};

const emaFast = 5;
const emaSlow = 13;
const requiredHistory = 30;

for (let i = requiredHistory; i < rounds.length; i++) {
  const round = rounds[i];

  // Only test on rounds where we have snapshot (crowd) data
  const snapshot = snapshotMap.get(round.epoch);
  if (!snapshot) continue;

  // Get historical closes
  const closes = rounds.slice(i - requiredHistory, i).map(r => r.closePrice);

  if (closes.length < emaSlow) continue;

  const ema5 = calculateEMA(closes, emaFast);
  const ema13 = calculateEMA(closes, emaSlow);

  if (!ema5 || !ema13) continue;

  // EMA signal
  const emaSignal = ema5 > ema13 ? 'UP' : 'DOWN';
  const crowdBet = snapshot.crowdBet;

  // Strategy 1: EMA only (ignore crowd)
  if (emaSignal === round.winner) strategies.ema_only.correct++;
  else strategies.ema_only.wrong++;

  // Strategy 2: Crowd only (ignore EMA)
  if (crowdBet === round.winner) strategies.crowd_only.correct++;
  else strategies.crowd_only.wrong++;

  // Strategy 3: EMA AND crowd agree (ONLY bet when both agree)
  if (emaSignal === crowdBet) {
    if (emaSignal === round.winner) strategies.ema_AND_crowd.correct++;
    else strategies.ema_AND_crowd.wrong++;
  }

  // Strategy 4: EMA OR crowd (bet if either says UP/DOWN)
  // This is complex - skip for now

  // Strategy 5: EMA contradicts crowd (bet EMA when it disagrees with crowd)
  if (emaSignal !== crowdBet) {
    if (emaSignal === round.winner) strategies.ema_CONTRADICT_crowd.correct++;
    else strategies.ema_CONTRADICT_crowd.wrong++;
  }
}

console.log('='.repeat(80));
console.log('STRATEGY COMPARISON\n');

const results = [];

// EMA only
const emaTotal = strategies.ema_only.correct + strategies.ema_only.wrong;
const emaWinRate = (strategies.ema_only.correct * 100 / emaTotal);
const emaEdge = emaWinRate - 51.5;
results.push({
  name: 'EMA 5/13 only (ignore crowd)',
  wins: strategies.ema_only.correct,
  losses: strategies.ema_only.wrong,
  total: emaTotal,
  winRate: emaWinRate,
  edge: emaEdge
});

// Crowd only
const crowdTotal = strategies.crowd_only.correct + strategies.crowd_only.wrong;
const crowdWinRate = (strategies.crowd_only.correct * 100 / crowdTotal);
const crowdEdge = crowdWinRate - 51.5;
results.push({
  name: 'Crowd only (ignore EMA)',
  wins: strategies.crowd_only.correct,
  losses: strategies.crowd_only.wrong,
  total: crowdTotal,
  winRate: crowdWinRate,
  edge: crowdEdge
});

// EMA AND crowd
const andTotal = strategies.ema_AND_crowd.correct + strategies.ema_AND_crowd.wrong;
const andWinRate = (strategies.ema_AND_crowd.correct * 100 / andTotal);
const andEdge = andWinRate - 51.5;
results.push({
  name: 'EMA 5/13 AND Crowd (both agree)',
  wins: strategies.ema_AND_crowd.correct,
  losses: strategies.ema_AND_crowd.wrong,
  total: andTotal,
  winRate: andWinRate,
  edge: andEdge
});

// EMA contradicts crowd
const contradictTotal = strategies.ema_CONTRADICT_crowd.correct + strategies.ema_CONTRADICT_crowd.wrong;
if (contradictTotal > 0) {
  const contradictWinRate = (strategies.ema_CONTRADICT_crowd.correct * 100 / contradictTotal);
  const contradictEdge = contradictWinRate - 51.5;
  results.push({
    name: 'EMA contradicts crowd (follow EMA)',
    wins: strategies.ema_CONTRADICT_crowd.correct,
    losses: strategies.ema_CONTRADICT_crowd.wrong,
    total: contradictTotal,
    winRate: contradictWinRate,
    edge: contradictEdge
  });
}

// Sort by edge
results.sort((a, b) => b.edge - a.edge);

console.log('Rank | Strategy                        | Win Rate         | Edge    | Trades | Result');
console.log('-----+---------------------------------+------------------+---------+--------+--------');

results.forEach((r, i) => {
  const rank = (i + 1).toString().padStart(2);
  const name = r.name.padEnd(31);
  const winRate = `${r.wins}/${r.total} (${r.winRate.toFixed(1)}%)`.padEnd(16);
  const edge = `${r.edge > 0 ? '+' : ''}${r.edge.toFixed(1)}%`.padStart(7);
  const trades = r.total.toString().padStart(6);
  const result = r.edge > 0 ? '  WIN' : ' LOSE';

  console.log(`${rank}   | ${name} | ${winRate} | ${edge} | ${trades} | ${result}`);
});

console.log('\n' + '='.repeat(80));
console.log('\nDETAILED BREAKDOWN:\n');

results.forEach((r, i) => {
  console.log(`${i + 1}. ${r.name}`);
  console.log(`   Wins: ${r.wins}, Losses: ${r.losses}, Total: ${r.total}`);
  console.log(`   Win Rate: ${r.winRate.toFixed(1)}%`);
  console.log(`   Edge: ${r.edge > 0 ? '+' : ''}${r.edge.toFixed(1)}% ${r.edge > 0 ? '✓ PROFITABLE' : '✗ NOT PROFITABLE'}`);

  if (i === 0 && i < results.length - 1) {
    const improvement = r.edge - results[i + 1].edge;
    console.log(`   Improvement over #${i + 2}: +${improvement.toFixed(1)}%`);
  }
  console.log('');
});

console.log('='.repeat(80));
console.log('\nCONCLUSION:\n');

const best = results[0];
const emaOnly = results.find(r => r.name.includes('EMA 5/13 only'));
const crowdOnly = results.find(r => r.name.includes('Crowd only'));
const combined = results.find(r => r.name.includes('AND Crowd'));

console.log(`✓ Best Strategy: ${best.name}`);
console.log(`  Win Rate: ${best.winRate.toFixed(1)}%`);
console.log(`  Edge: ${best.edge > 0 ? '+' : ''}${best.edge.toFixed(1)}%`);
console.log(`  Total Trades: ${best.total}\n`);

if (combined === best) {
  console.log('✓✓ YES - You MUST bet WITH THE CROWD when EMA confirms!');
  console.log(`   Betting with crowd + EMA: ${combined.winRate.toFixed(1)}%`);
  console.log(`   EMA alone: ${emaOnly.winRate.toFixed(1)}%`);
  console.log(`   Crowd alone: ${crowdOnly.winRate.toFixed(1)}%`);
  console.log(`\n   The combination is ${(combined.edge - emaOnly.edge).toFixed(1)}% better than EMA alone!`);
} else if (emaOnly === best) {
  console.log('✗ EMA alone is better than combining with crowd');
} else if (crowdOnly === best) {
  console.log('✗ Just following the crowd is better than using EMA');
}

db.close();
