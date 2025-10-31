import initSqlJs from 'sql.js';
import fs from 'fs';

console.log('=== T-20s CROWD STABILITY ANALYSIS ===\n');
console.log('How often does the T-20s crowd stay the same until lock?\n');

const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync('prediction-data.db'));

// Get all snapshots with their T-20s data and final round data
const data = db.exec(`
  SELECT
    s.epoch,
    s.snapshot_type,
    s.bull_amount_wei as snap_bull,
    s.bear_amount_wei as snap_bear,
    s.total_amount_wei as snap_total,
    s.implied_up_multiple as snap_implied_up,
    s.implied_down_multiple as snap_implied_down,
    r.bull_amount_wei as final_bull,
    r.bear_amount_wei as final_bear,
    r.total_amount_wei as final_total,
    r.winner
  FROM snapshots s
  JOIN rounds r ON s.epoch = r.epoch
  WHERE r.winner IN ('UP', 'DOWN')
  ORDER BY s.epoch ASC
`);

const rounds = data[0].values.map(row => ({
  epoch: row[0],
  snapType: row[1],
  snapBull: BigInt(row[2]),
  snapBear: BigInt(row[3]),
  snapTotal: BigInt(row[4]),
  snapImpliedUp: row[5],
  snapImpliedDown: row[6],
  finalBull: BigInt(row[7]),
  finalBear: BigInt(row[8]),
  finalTotal: BigInt(row[9]),
  winner: row[10]
}));

console.log(`Analyzing ${rounds.length} rounds\n`);
console.log('='.repeat(80));

// Test different thresholds
const thresholds = [50, 55, 60, 65, 70, 75, 80];

console.log('\nCROWD STABILITY BY THRESHOLD:\n');
console.log('Threshold | T20 Stayed | T20 Flipped | Stability | Payout\n' +
            '----------|------------|-------------|-----------|--------');

const thresholdResults = [];

for (const threshold of thresholds) {
  let stayedSame = 0;
  let flipped = 0;
  let qualifyingRounds = 0;

  for (const round of rounds) {
    const snapBullPct = Number((round.snapBull * 10000n) / round.snapTotal) / 100;
    const snapBearPct = 100 - snapBullPct;

    const finalBullPct = Number((round.finalBull * 10000n) / round.finalTotal) / 100;
    const finalBearPct = 100 - finalBullPct;

    // Check if T-20s meets threshold
    let t20Crowd = null;
    if (snapBullPct >= threshold) {
      t20Crowd = 'UP';
    } else if (snapBearPct >= threshold) {
      t20Crowd = 'DOWN';
    }

    if (!t20Crowd) continue; // Doesn't meet threshold
    qualifyingRounds++;

    // Check final crowd
    const finalCrowd = round.finalBull > round.finalBear ? 'UP' : 'DOWN';

    if (t20Crowd === finalCrowd) {
      stayedSame++;
    } else {
      flipped++;
    }
  }

  const stabilityPct = qualifyingRounds > 0 ? (stayedSame * 100 / qualifyingRounds) : 0;
  const payout = (100 * 0.97) / threshold;

  thresholdResults.push({
    threshold,
    stayedSame,
    flipped,
    total: qualifyingRounds,
    stabilityPct,
    payout
  });

  console.log(`  ${threshold.toString().padStart(3)}%    | ` +
              `${stayedSame.toString().padStart(10)} | ` +
              `${flipped.toString().padStart(11)} | ` +
              `${stabilityPct.toFixed(1).padStart(8)}% | ` +
              `<${payout.toFixed(2)}x`);
}

console.log('\n' + '='.repeat(80));
console.log('\nDETAILED BREAKDOWN:\n');

thresholdResults.forEach((r, i) => {
  console.log(`${i + 1}. T-20s shows ≥${r.threshold}% on one side (payout <${r.payout.toFixed(2)}x):`);
  console.log(`   Qualifying rounds: ${r.total}/${rounds.length} (${(r.total*100/rounds.length).toFixed(1)}%)`);
  console.log(`   Stayed same until lock: ${r.stayedSame} (${r.stabilityPct.toFixed(1)}%)`);
  console.log(`   Flipped by lock: ${r.flipped} (${(r.flipped*100/r.total).toFixed(1)}%)`);
  console.log('');
});

console.log('='.repeat(80));
console.log('\nANALYSIS OF FLIPS:\n');

// Analyze the flips in detail
console.log('Looking at rounds where T-20s crowd flipped...\n');

const flipDetails = [];

for (const round of rounds) {
  const snapBullPct = Number((round.snapBull * 10000n) / round.snapTotal) / 100;
  const finalBullPct = Number((round.finalBull * 10000n) / round.finalTotal) / 100;

  const snapCrowd = round.snapBull > round.snapBear ? 'UP' : 'DOWN';
  const finalCrowd = round.finalBull > round.finalBear ? 'UP' : 'DOWN';

  if (snapCrowd !== finalCrowd) {
    const lastSecondBull = round.finalBull - round.snapBull;
    const lastSecondBear = round.finalBear - round.snapBear;
    const lastSecondTotal = round.finalTotal - round.snapTotal;

    const lastSecondBNB = Number(lastSecondTotal) / 1e18;
    const lastSecondPct = Number((lastSecondTotal * 10000n) / round.finalTotal) / 100;

    flipDetails.push({
      epoch: round.epoch,
      snapBullPct,
      finalBullPct,
      shift: Math.abs(finalBullPct - snapBullPct),
      lastSecondBNB,
      lastSecondPct,
      snapCrowd,
      finalCrowd,
      winner: round.winner
    });
  }
}

console.log(`Total flips: ${flipDetails.length}/${rounds.length} (${(flipDetails.length*100/rounds.length).toFixed(1)}%)\n`);

// Sort by last second %
flipDetails.sort((a, b) => b.lastSecondPct - a.lastSecondPct);

console.log('Top 10 biggest last-second bet injections:\n');
console.log('Epoch   | T20    | Final  | Shift  | Last-second | T20→Final | Winner');
console.log('--------|--------|--------|--------|-------------|-----------|-------');

flipDetails.slice(0, 10).forEach(f => {
  console.log(`${f.epoch} | ${f.snapBullPct.toFixed(1).padStart(5)}% | ${f.finalBullPct.toFixed(1).padStart(5)}% | ` +
              `${f.shift.toFixed(1).padStart(5)}% | ${f.lastSecondBNB.toFixed(2).padStart(6)} BNB (${f.lastSecondPct.toFixed(1)}%) | ` +
              `${f.snapCrowd}→${f.finalCrowd.padStart(4)} | ${f.winner.padStart(4)}`);
});

console.log('\n' + '='.repeat(80));
console.log('\nKEY FINDINGS:\n');

const best = thresholdResults.find(r => r.threshold === 70);
const moderate = thresholdResults.find(r => r.threshold === 55);

console.log(`1. At 70% threshold (payout <1.39x):`);
console.log(`   - ${best.stayedSame}/${best.total} rounds (${best.stabilityPct.toFixed(1)}%) stayed the same`);
console.log(`   - ${best.flipped} rounds (${(best.flipped*100/best.total).toFixed(1)}%) flipped`);
console.log(`   - Very strong T-20s conviction = high stability\n`);

console.log(`2. At 55% threshold (payout <1.76x):`);
console.log(`   - ${moderate.stayedSame}/${moderate.total} rounds (${moderate.stabilityPct.toFixed(1)}%) stayed the same`);
console.log(`   - ${moderate.flipped} rounds (${(moderate.flipped*100/moderate.total).toFixed(1)}%) flipped`);
console.log(`   - More rounds but less stable\n`);

const avgLastSecondBNB = flipDetails.reduce((sum, f) => sum + f.lastSecondBNB, 0) / flipDetails.length;
const avgLastSecondPct = flipDetails.reduce((sum, f) => sum + f.lastSecondPct, 0) / flipDetails.length;

console.log(`3. When flips happen:`);
console.log(`   - Average last-second injection: ${avgLastSecondBNB.toFixed(2)} BNB`);
console.log(`   - Average % of final pool: ${avgLastSecondPct.toFixed(1)}%`);
console.log(`   - These are significant late bets!`);

console.log('\n' + '='.repeat(80));
console.log('\nRECOMMENDATION:\n');

const mostStable = thresholdResults.reduce((best, curr) =>
  curr.stabilityPct > best.stabilityPct ? curr : best
);

console.log(`Most stable threshold: ${mostStable.threshold}% (${mostStable.stabilityPct.toFixed(1)}% stability)`);
console.log(`But this only gives ${mostStable.total} tradeable rounds.\n`);

console.log(`Best balance: 70% threshold`);
console.log(`  - ${best.stabilityPct.toFixed(1)}% of T-20s crowds stay the same until lock`);
console.log(`  - ${best.total} tradeable rounds`);
console.log(`  - Only ${best.flipped} flips out of ${best.total} rounds`);
console.log(`\n  ✓ High stability + enough trading opportunities`);

console.log(`\nAnswer to your question:`);
console.log(`  Out of 113 snapshots, when using 70% threshold:`);
console.log(`  - ${best.total} rounds qualified`);
console.log(`  - ${best.stayedSame} had same crowd at T-20s and lock (${best.stabilityPct.toFixed(1)}%)`);
console.log(`  - ${best.flipped} flipped between T-20s and lock (${(best.flipped*100/best.total).toFixed(1)}%)`);

db.close();
