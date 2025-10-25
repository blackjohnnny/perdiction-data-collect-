import initSqlJs from 'sql.js';
import fs from 'fs';

console.log('=== CROWD DEFINITION ANALYSIS ===\n');
console.log('Testing different crowd definitions using T-20s snapshot data\n');

const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync('prediction-data.db'));

// Get all snapshots with their T-20s data and final round data
const data = db.exec(`
  SELECT
    s.epoch,
    s.snapshot_type,
    s.bull_amount_wei as snap_bull,
    s.bear_amount_wei as snap_bear,
    s.implied_up_multiple as snap_implied_up,
    s.implied_down_multiple as snap_implied_down,
    r.bull_amount_wei as final_bull,
    r.bear_amount_wei as final_bear,
    r.total_amount_wei as final_total,
    r.lock_price,
    r.close_price,
    r.winner,
    r.winner_multiple as final_payout
  FROM snapshots s
  JOIN rounds r ON s.epoch = r.epoch
  WHERE r.winner IN ('UP', 'DOWN')
  ORDER BY s.epoch ASC
`);

if (!data[0] || data[0].values.length === 0) {
  console.log('No data found');
  db.close();
  process.exit(0);
}

const rounds = data[0].values.map(row => ({
  epoch: row[0],
  snapType: row[1],
  snapBull: BigInt(row[2]),
  snapBear: BigInt(row[3]),
  snapImpliedUp: row[4],
  snapImpliedDown: row[5],
  finalBull: BigInt(row[6]),
  finalBear: BigInt(row[7]),
  finalTotal: BigInt(row[8]),
  lockPrice: row[9],
  closePrice: row[10],
  winner: row[11],
  finalPayout: row[12]
}));

console.log(`Analyzing ${rounds.length} rounds with T-20s snapshot data\n`);

// Different crowd definitions to test
const definitions = {
  snap_larger_pool: { name: 'T-20s: Larger pool side', correct: 0, wrong: 0, flipped: 0 },
  snap_lower_payout: { name: 'T-20s: Lower payout (implied odds)', correct: 0, wrong: 0 },
  snap_higher_pool_pct: { name: 'T-20s: >55% of pool', correct: 0, wrong: 0, trades: 0 },
  snap_higher_pool_pct_60: { name: 'T-20s: >60% of pool', correct: 0, wrong: 0, trades: 0 },
  snap_higher_pool_pct_65: { name: 'T-20s: >65% of pool', correct: 0, wrong: 0, trades: 0 },
  snap_higher_pool_pct_70: { name: 'T-20s: >70% of pool', correct: 0, wrong: 0, trades: 0 },
  final_larger_pool: { name: 'Final: Larger pool side', correct: 0, wrong: 0 },
  final_lower_payout: { name: 'Final: Lower payout side', correct: 0, wrong: 0 }
};

console.log('Testing crowd definitions...\n');

let lastSecondFlips = 0;
let significantFlips = 0;

for (const round of rounds) {
  const snapTotal = round.snapBull + round.snapBear;
  const snapBullPct = Number((round.snapBull * 10000n) / snapTotal) / 100;
  const snapBearPct = 100 - snapBullPct;

  const finalTotal = round.finalBull + round.finalBear;
  const finalBullPct = Number((round.finalBull * 10000n) / finalTotal) / 100;
  const finalBearPct = 100 - finalBullPct;

  // Check if crowd flipped between T-20s and final
  const snapCrowd = round.snapBull > round.snapBear ? 'UP' : 'DOWN';
  const finalCrowd = round.finalBull > round.finalBear ? 'UP' : 'DOWN';

  if (snapCrowd !== finalCrowd) {
    lastSecondFlips++;
    // Check if it was a significant flip (not just barely flipping)
    if (Math.abs(snapBullPct - 50) > 5) {
      significantFlips++;
    }
  }

  // Definition 1: T-20s larger pool
  const def1 = snapCrowd;
  if (def1 === round.winner) definitions.snap_larger_pool.correct++;
  else definitions.snap_larger_pool.wrong++;
  if (snapCrowd !== finalCrowd) definitions.snap_larger_pool.flipped++;

  // Definition 2: T-20s lower payout (higher implied odds)
  const def2 = round.snapImpliedUp < round.snapImpliedDown ? 'UP' : 'DOWN';
  if (def2 === round.winner) definitions.snap_lower_payout.correct++;
  else definitions.snap_lower_payout.wrong++;

  // Definition 3: T-20s >55% of pool
  if (snapBullPct > 55) {
    definitions.snap_higher_pool_pct.trades++;
    if ('UP' === round.winner) definitions.snap_higher_pool_pct.correct++;
    else definitions.snap_higher_pool_pct.wrong++;
  } else if (snapBearPct > 55) {
    definitions.snap_higher_pool_pct.trades++;
    if ('DOWN' === round.winner) definitions.snap_higher_pool_pct.correct++;
    else definitions.snap_higher_pool_pct.wrong++;
  }

  // Definition 4: T-20s >60% of pool
  if (snapBullPct > 60) {
    definitions.snap_higher_pool_pct_60.trades++;
    if ('UP' === round.winner) definitions.snap_higher_pool_pct_60.correct++;
    else definitions.snap_higher_pool_pct_60.wrong++;
  } else if (snapBearPct > 60) {
    definitions.snap_higher_pool_pct_60.trades++;
    if ('DOWN' === round.winner) definitions.snap_higher_pool_pct_60.correct++;
    else definitions.snap_higher_pool_pct_60.wrong++;
  }

  // Definition 5: T-20s >65% of pool
  if (snapBullPct > 65) {
    definitions.snap_higher_pool_pct_65.trades++;
    if ('UP' === round.winner) definitions.snap_higher_pool_pct_65.correct++;
    else definitions.snap_higher_pool_pct_65.wrong++;
  } else if (snapBearPct > 65) {
    definitions.snap_higher_pool_pct_65.trades++;
    if ('DOWN' === round.winner) definitions.snap_higher_pool_pct_65.correct++;
    else definitions.snap_higher_pool_pct_65.wrong++;
  }

  // Definition 6: T-20s >70% of pool
  if (snapBullPct > 70) {
    definitions.snap_higher_pool_pct_70.trades++;
    if ('UP' === round.winner) definitions.snap_higher_pool_pct_70.correct++;
    else definitions.snap_higher_pool_pct_70.wrong++;
  } else if (snapBearPct > 70) {
    definitions.snap_higher_pool_pct_70.trades++;
    if ('DOWN' === round.winner) definitions.snap_higher_pool_pct_70.correct++;
    else definitions.snap_higher_pool_pct_70.wrong++;
  }

  // Definition 7: Final larger pool
  const def7 = finalCrowd;
  if (def7 === round.winner) definitions.final_larger_pool.correct++;
  else definitions.final_larger_pool.wrong++;

  // Definition 8: Final lower payout
  // Calculate final implied payout
  const finalImpliedUp = round.finalBull > 0n
    ? Number((finalTotal * 97n * 1000n) / (round.finalBull * 100n)) / 1000
    : 999;
  const finalImpliedDown = round.finalBear > 0n
    ? Number((finalTotal * 97n * 1000n) / (round.finalBear * 100n)) / 1000
    : 999;
  const def8 = finalImpliedUp < finalImpliedDown ? 'UP' : 'DOWN';
  if (def8 === round.winner) definitions.final_lower_payout.correct++;
  else definitions.final_lower_payout.wrong++;
}

console.log('='.repeat(80));
console.log('LAST-SECOND BET ANALYSIS:\n');
console.log(`Total rounds: ${rounds.length}`);
console.log(`Crowd flipped between T-20s and final: ${lastSecondFlips} (${(lastSecondFlips*100/rounds.length).toFixed(1)}%)`);
console.log(`Significant flips (>5% away from 50/50): ${significantFlips} (${(significantFlips*100/rounds.length).toFixed(1)}%)`);

console.log('\n' + '='.repeat(80));
console.log('CROWD DEFINITION COMPARISON:\n');

const results = [];

for (const [key, def] of Object.entries(definitions)) {
  const total = def.correct + def.wrong;
  if (total === 0) continue;

  const winRate = (def.correct * 100 / total);
  const edge = winRate - 51.5;

  results.push({
    name: def.name,
    wins: def.correct,
    losses: def.wrong,
    total: total,
    trades: def.trades || total,
    winRate,
    edge,
    flipped: def.flipped || 0
  });
}

results.sort((a, b) => b.edge - a.edge);

console.log('Rank | Definition                        | Win Rate         | Edge    | Trades | Flips');
console.log('-----+-----------------------------------+------------------+---------+--------+-------');

results.forEach((r, i) => {
  const rank = (i + 1).toString().padStart(2);
  const name = r.name.padEnd(33);
  const winRate = `${r.wins}/${r.total} (${r.winRate.toFixed(1)}%)`.padEnd(16);
  const edge = `${r.edge > 0 ? '+' : ''}${r.edge.toFixed(1)}%`.padStart(7);
  const trades = r.trades.toString().padStart(6);
  const flips = r.flipped > 0 ? r.flipped.toString().padStart(5) : '    -';

  console.log(`${rank}   | ${name} | ${winRate} | ${edge} | ${trades} | ${flips}`);
});

console.log('\n' + '='.repeat(80));
console.log('\nDETAILED RESULTS:\n');

results.forEach((r, i) => {
  console.log(`${i + 1}. ${r.name}`);
  console.log(`   Wins: ${r.wins}, Losses: ${r.losses}`);
  console.log(`   Win Rate: ${r.winRate.toFixed(1)}%`);
  console.log(`   Edge: ${r.edge > 0 ? '+' : ''}${r.edge.toFixed(1)}% ${r.edge > 0 ? '✓ PROFITABLE' : '✗ NOT PROFITABLE'}`);
  console.log(`   Trades: ${r.trades} rounds`);
  if (r.flipped > 0) {
    console.log(`   Flipped by last-second bets: ${r.flipped} times`);
  }
  console.log('');
});

console.log('='.repeat(80));
console.log('\nRECOMMENDATION:\n');

const best = results[0];
const snapLarger = results.find(r => r.name.includes('T-20s: Larger pool'));
const finalLarger = results.find(r => r.name.includes('Final: Larger pool'));

console.log(`Best definition: ${best.name}`);
console.log(`  Win Rate: ${best.winRate.toFixed(1)}%`);
console.log(`  Edge: ${best.edge > 0 ? '+' : ''}${best.edge.toFixed(1)}%`);
console.log(`  Trades: ${best.trades}\n`);

console.log('KEY INSIGHTS:\n');

console.log(`1. Last-second bets flipped the crowd ${lastSecondFlips} times (${(lastSecondFlips*100/rounds.length).toFixed(1)}%)`);

if (snapLarger.flipped > 0) {
  console.log(`   ${snapLarger.flipped} of your T-20s bets would have been on the "wrong" final side`);
}

console.log(`\n2. T-20s snapshot vs Final:`);
console.log(`   T-20s larger pool: ${snapLarger.winRate.toFixed(1)}% win rate`);
console.log(`   Final larger pool: ${finalLarger.winRate.toFixed(1)}% win rate`);

if (snapLarger.edge > finalLarger.edge) {
  console.log(`   ✓ T-20s is BETTER by ${(snapLarger.edge - finalLarger.edge).toFixed(1)}%`);
} else if (finalLarger.edge > snapLarger.edge) {
  console.log(`   ✓ Final is BETTER by ${(finalLarger.edge - snapLarger.edge).toFixed(1)}%`);
} else {
  console.log(`   = Both are equal`);
}

console.log(`\n3. Pool threshold strategies:`);
const thresholds = results.filter(r => r.name.includes('>'));
thresholds.forEach(t => {
  console.log(`   ${t.name}: ${t.winRate.toFixed(1)}% (${t.trades} trades)`);
});

console.log('\n' + '='.repeat(80));
console.log('\nFINAL STRATEGY:\n');

console.log(`Use: ${best.name}`);
console.log(`Why: Best win rate (${best.winRate.toFixed(1)}%) with ${best.edge > 0 ? '+' : ''}${best.edge.toFixed(1)}% edge`);

if (best.trades < rounds.length * 0.7) {
  console.log(`Note: This strategy is selective (only ${best.trades}/${rounds.length} trades = ${(best.trades*100/rounds.length).toFixed(0)}%)`);
  console.log(`      Higher quality over quantity - better edge per trade!`);
}

db.close();
