import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('   OPTION 2: T-20s POOL SIZE vs FINAL POOL SIZE');
console.log('═══════════════════════════════════════════════════════════════\n');

// Get all rounds with T-20s snapshots and final results
const query = `
  SELECT
    r.epoch,
    r.winner,
    r.close_price,
    r.lock_price,
    r.total_amount_wei as final_total,
    r.bull_amount_wei as final_bull,
    r.bear_amount_wei as final_bear,
    s.implied_up_multiple as t20_up,
    s.implied_down_multiple as t20_down,
    s.bull_amount_wei as t20_bull,
    s.bear_amount_wei as t20_bear,
    s.total_amount_wei as t20_total
  FROM rounds r
  JOIN snapshots s ON r.epoch = s.epoch
  WHERE r.winner IN ('UP', 'DOWN')
    AND s.snapshot_type = 'T_MINUS_20S'
  ORDER BY r.epoch ASC
`;

const stmt = db.prepare(query);
const rounds = [];
while (stmt.step()) {
  const row = stmt.getAsObject();

  const t20TotalBNB = Number(BigInt(row.t20_total)) / 1e18;
  const finalTotalBNB = Number(BigInt(row.final_total)) / 1e18;

  rounds.push({
    epoch: row.epoch,
    winner: row.winner,
    closePrice: BigInt(row.close_price),
    lockPrice: BigInt(row.lock_price),
    t20TotalBNB,
    finalTotalBNB,
    t20BullAmount: BigInt(row.t20_bull),
    t20BearAmount: BigInt(row.t20_bear),
    t20TotalAmount: BigInt(row.t20_total),
    finalBullAmount: BigInt(row.final_bull),
    finalBearAmount: BigInt(row.final_bear),
    finalTotalAmount: BigInt(row.final_total)
  });
}
stmt.free();
db.close();

console.log(`Total rounds analyzed: ${rounds.length}\n`);

// Analyze correlation
console.log('═══════════════════════════════════════════════════════════════');
console.log('CORRELATION ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════\n');

// Check: If T-20s pool is small, does final pool stay small?
const smallThreshold = 1.5; // BNB

let t20SmallFinalSmall = 0;
let t20SmallFinalLarge = 0;
let t20LargeFinalSmall = 0;
let t20LargeFinalLarge = 0;

for (const round of rounds) {
  const t20Small = round.t20TotalBNB < smallThreshold;
  const finalSmall = round.finalTotalBNB < smallThreshold;

  if (t20Small && finalSmall) t20SmallFinalSmall++;
  if (t20Small && !finalSmall) t20SmallFinalLarge++;
  if (!t20Small && finalSmall) t20LargeFinalSmall++;
  if (!t20Small && !finalSmall) t20LargeFinalLarge++;
}

console.log(`Threshold: ${smallThreshold} BNB\n`);
console.log('Contingency Table:');
console.log('─────────────────────────────────────────────────────');
console.log('                    │ Final Small  │ Final Large');
console.log('─────────────────────────────────────────────────────');
console.log(`T-20s Small         │ ${t20SmallFinalSmall.toString().padStart(11)} │ ${t20SmallFinalLarge.toString().padStart(11)}`);
console.log(`T-20s Large         │ ${t20LargeFinalSmall.toString().padStart(11)} │ ${t20LargeFinalLarge.toString().padStart(11)}`);
console.log('─────────────────────────────────────────────────────\n');

const totalT20Small = t20SmallFinalSmall + t20SmallFinalLarge;
const totalT20Large = t20LargeFinalSmall + t20LargeFinalLarge;

if (totalT20Small > 0) {
  const staySmallRate = (t20SmallFinalSmall / totalT20Small) * 100;
  console.log(`When T-20s pool is SMALL (<${smallThreshold} BNB):`);
  console.log(`  → Stays small at close: ${t20SmallFinalSmall}/${totalT20Small} (${staySmallRate.toFixed(1)}%)`);
  console.log(`  → Grows large at close: ${t20SmallFinalLarge}/${totalT20Small} (${(100-staySmallRate).toFixed(1)}%)`);

  if (staySmallRate >= 70) {
    console.log(`  ✅ RELIABLE - Can use T-20s pool size to filter!\n`);
  } else {
    console.log(`  ❌ UNRELIABLE - T-20s pool size doesn't predict final size\n`);
  }
}

if (totalT20Large > 0) {
  const stayLargeRate = (t20LargeFinalLarge / totalT20Large) * 100;
  console.log(`When T-20s pool is LARGE (≥${smallThreshold} BNB):`);
  console.log(`  → Stays large at close: ${t20LargeFinalLarge}/${totalT20Large} (${stayLargeRate.toFixed(1)}%)`);
  console.log(`  → Shrinks small at close: ${t20LargeFinalSmall}/${totalT20Large} (${(100-stayLargeRate).toFixed(1)}%)\n`);
}

// Calculate average growth from T-20s to final
let totalGrowth = 0;
let avgT20Pool = 0;
let avgFinalPool = 0;

for (const round of rounds) {
  const growth = round.finalTotalBNB - round.t20TotalBNB;
  totalGrowth += growth;
  avgT20Pool += round.t20TotalBNB;
  avgFinalPool += round.finalTotalBNB;
}

avgT20Pool /= rounds.length;
avgFinalPool /= rounds.length;
const avgGrowth = totalGrowth / rounds.length;
const avgGrowthPct = (avgGrowth / avgT20Pool) * 100;

console.log('═══════════════════════════════════════════════════════════════');
console.log('POOL GROWTH STATISTICS');
console.log('═══════════════════════════════════════════════════════════════\n');
console.log(`Average T-20s pool:   ${avgT20Pool.toFixed(3)} BNB`);
console.log(`Average Final pool:   ${avgFinalPool.toFixed(3)} BNB`);
console.log(`Average Growth:       +${avgGrowth.toFixed(3)} BNB (+${avgGrowthPct.toFixed(1)}%)`);

// Show distribution
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('POOL SIZE DISTRIBUTION');
console.log('═══════════════════════════════════════════════════════════════\n');

const t20Buckets = { '<0.5': 0, '0.5-1.0': 0, '1.0-1.5': 0, '1.5-2.0': 0, '2.0+': 0 };
const finalBuckets = { '<0.5': 0, '0.5-1.0': 0, '1.0-1.5': 0, '1.5-2.0': 0, '2.0+': 0 };

for (const round of rounds) {
  // T-20s distribution
  if (round.t20TotalBNB < 0.5) t20Buckets['<0.5']++;
  else if (round.t20TotalBNB < 1.0) t20Buckets['0.5-1.0']++;
  else if (round.t20TotalBNB < 1.5) t20Buckets['1.0-1.5']++;
  else if (round.t20TotalBNB < 2.0) t20Buckets['1.5-2.0']++;
  else t20Buckets['2.0+']++;

  // Final distribution
  if (round.finalTotalBNB < 0.5) finalBuckets['<0.5']++;
  else if (round.finalTotalBNB < 1.0) finalBuckets['0.5-1.0']++;
  else if (round.finalTotalBNB < 1.5) finalBuckets['1.0-1.5']++;
  else if (round.finalTotalBNB < 2.0) finalBuckets['1.5-2.0']++;
  else finalBuckets['2.0+']++;
}

console.log('T-20s Pool Size Distribution:');
for (const [bucket, count] of Object.entries(t20Buckets)) {
  const pct = (count / rounds.length * 100).toFixed(1);
  console.log(`  ${bucket.padEnd(10)} BNB: ${count.toString().padStart(3)} rounds (${pct}%)`);
}

console.log('\nFinal Pool Size Distribution:');
for (const [bucket, count] of Object.entries(finalBuckets)) {
  const pct = (count / rounds.length * 100).toFixed(1);
  console.log(`  ${bucket.padEnd(10)} BNB: ${count.toString().padStart(3)} rounds (${pct}%)`);
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('CONCLUSION');
console.log('═══════════════════════════════════════════════════════════════\n');

if (totalT20Small > 0) {
  const staySmallRate = (t20SmallFinalSmall / totalT20Small) * 100;
  if (staySmallRate >= 70) {
    console.log(`✅ Strategy B is VIABLE!`);
    console.log(`   When T-20s pool < ${smallThreshold} BNB, it stays small ${staySmallRate.toFixed(1)}% of the time.`);
    console.log(`   We can reliably filter by T-20s pool size.\n`);
  } else {
    console.log(`❌ Strategy B is NOT RELIABLE.`);
    console.log(`   When T-20s pool < ${smallThreshold} BNB, it only stays small ${staySmallRate.toFixed(1)}% of the time.`);
    console.log(`   ${(100-staySmallRate).toFixed(1)}% of "small" pools at T-20s become large by close.`);
    console.log(`   Consider using time-based filtering (Option 3) instead.\n`);
  }
}

console.log('═══════════════════════════════════════════════════════════════\n');
