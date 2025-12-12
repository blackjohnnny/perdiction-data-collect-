import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('\n📊 PAYOUT DRIFT ANALYSIS: T-20s vs Settlement\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL
  AND winner IS NOT NULL
  ORDER BY sample_id ASC
`).all();

console.log('Total rounds:', rounds.length, '\n');

let drifts = [];
let winningTrades = [];
let losingTrades = [];

for (const r of rounds) {
  const bull = parseFloat(r.t20s_bull_wei) / 1e18;
  const bear = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bull + bear;

  if (total === 0) continue;

  const bullPct = (bull / total) * 100;
  const bearPct = (bear / total) * 100;

  let betSide = null;
  if (bullPct >= 65) betSide = 'BULL';
  else if (bearPct >= 65) betSide = 'BEAR';

  if (!betSide) continue;

  // Calculate T-20s payout
  const netPool = total * 0.97;
  const t20sPayout = betSide === 'BULL' ? netPool / bull : netPool / bear;

  // Settlement payout
  const settlementPayout = r.winner_payout_multiple;

  // Drift (how much payout changed from T-20s to settlement)
  const drift = settlementPayout - t20sPayout;
  const driftPercent = (drift / t20sPayout) * 100;

  drifts.push({
    sample_id: r.sample_id,
    betSide,
    t20sPayout,
    settlementPayout,
    drift,
    driftPercent,
    won: betSide.toLowerCase() === r.winner
  });

  if (betSide.toLowerCase() === r.winner) {
    winningTrades.push(driftPercent);
  } else {
    losingTrades.push(driftPercent);
  }
}

// Calculate statistics
const avgDrift = drifts.reduce((sum, d) => sum + d.driftPercent, 0) / drifts.length;
const avgWinningDrift = winningTrades.reduce((sum, d) => sum + d, 0) / winningTrades.length;
const avgLosingDrift = losingTrades.reduce((sum, d) => sum + d, 0) / losingTrades.length;

console.log('Overall Payout Drift:');
console.log('  Average drift: ' + avgDrift.toFixed(2) + '%');
console.log('  Winning trades avg drift: ' + avgWinningDrift.toFixed(2) + '%');
console.log('  Losing trades avg drift: ' + avgLosingDrift.toFixed(2) + '%\n');

// Show extreme drifts
const sortedByDrift = [...drifts].sort((a, b) => b.driftPercent - a.driftPercent);

console.log('Top 10 BIGGEST POSITIVE drifts (payout increased):');
for (let i = 0; i < Math.min(10, sortedByDrift.length); i++) {
  const d = sortedByDrift[i];
  console.log(`  #${d.sample_id}: ${d.t20sPayout.toFixed(3)}x → ${d.settlementPayout.toFixed(3)}x (+${d.driftPercent.toFixed(1)}%) ${d.won ? '✅' : '❌'}`);
}

console.log('\nTop 10 BIGGEST NEGATIVE drifts (payout decreased):');
const reversed = [...sortedByDrift].reverse();
for (let i = 0; i < Math.min(10, reversed.length); i++) {
  const d = reversed[i];
  console.log(`  #${d.sample_id}: ${d.t20sPayout.toFixed(3)}x → ${d.settlementPayout.toFixed(3)}x (${d.driftPercent.toFixed(1)}%) ${d.won ? '✅' : '❌'}`);
}

// Pattern analysis
const positiveDriftWins = drifts.filter(d => d.driftPercent > 0 && d.won).length;
const positiveDriftTotal = drifts.filter(d => d.driftPercent > 0).length;
const negativeDriftWins = drifts.filter(d => d.driftPercent < 0 && d.won).length;
const negativeDriftTotal = drifts.filter(d => d.driftPercent < 0).length;

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('💡 PATTERN ANALYSIS:\n');
console.log('When payout INCREASES (T-20s → settlement):');
console.log(`  Win rate: ${positiveDriftWins}/${positiveDriftTotal} = ${(positiveDriftWins/positiveDriftTotal*100).toFixed(2)}%\n`);

console.log('When payout DECREASES (T-20s → settlement):');
console.log(`  Win rate: ${negativeDriftWins}/${negativeDriftTotal} = ${(negativeDriftWins/negativeDriftTotal*100).toFixed(2)}%\n`);

console.log('💡 INSIGHT:');
console.log('If payout INCREASES, more people joined YOUR side (bad for you).');
console.log('If payout DECREASES, more people joined OPPOSITE side (good for you).\n');

db.close();
