import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('   T-20s CROWD STABILITY ANALYSIS');
console.log('   Does T-20s crowd stay as crowd at close?');
console.log('═══════════════════════════════════════════════════════════════\n');

// Get all rounds with T-20s snapshots and final results
const query = `
  SELECT
    r.epoch,
    r.winner,
    r.total_amount_wei as final_total,
    r.bull_amount_wei as final_bull,
    r.bear_amount_wei as final_bear,
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

  rounds.push({
    epoch: row.epoch,
    winner: row.winner,
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

console.log(`📊 Total rounds analyzed: ${rounds.length}\n`);

console.log('═══════════════════════════════════════════════════════════════');
console.log('CROWD STABILITY ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════\n');

let crowdStaysSame = 0;
let crowdFlips = 0;

// Track by threshold
const thresholds = [50, 55, 60, 65, 70, 75, 80, 85, 90];
const stabilityByThreshold = {};

for (const threshold of thresholds) {
  stabilityByThreshold[threshold] = {
    total: 0,
    stable: 0,
    flipped: 0
  };
}

for (const round of rounds) {
  // T-20s crowd
  const t20CrowdSide = round.t20BullAmount > round.t20BearAmount ? 'UP' : 'DOWN';
  const t20BullPct = Number(round.t20BullAmount * 10000n / round.t20TotalAmount) / 100;
  const t20BearPct = Number(round.t20BearAmount * 10000n / round.t20TotalAmount) / 100;
  const t20CrowdPct = Math.max(t20BullPct, t20BearPct);

  // Final crowd
  const finalCrowdSide = round.finalBullAmount > round.finalBearAmount ? 'UP' : 'DOWN';

  // Check if crowd stayed same
  if (t20CrowdSide === finalCrowdSide) {
    crowdStaysSame++;
  } else {
    crowdFlips++;
  }

  // Track by threshold
  for (const threshold of thresholds) {
    if (t20CrowdPct >= threshold) {
      stabilityByThreshold[threshold].total++;
      if (t20CrowdSide === finalCrowdSide) {
        stabilityByThreshold[threshold].stable++;
      } else {
        stabilityByThreshold[threshold].flipped++;
      }
    }
  }
}

const totalRounds = rounds.length;
const stableRate = (crowdStaysSame / totalRounds) * 100;
const flipRate = (crowdFlips / totalRounds) * 100;

console.log('Overall (all T-20s snapshots):');
console.log('─'.repeat(63));
console.log(`Crowd stays same:  ${crowdStaysSame}/${totalRounds} (${stableRate.toFixed(2)}%)`);
console.log(`Crowd flips:       ${crowdFlips}/${totalRounds} (${flipRate.toFixed(2)}%)\n`);

console.log('═══════════════════════════════════════════════════════════════');
console.log('STABILITY BY T-20s CROWD THRESHOLD');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('Threshold | Total | Stays Same | Flips | Stability %');
console.log('─'.repeat(63));

for (const threshold of thresholds) {
  const data = stabilityByThreshold[threshold];
  if (data.total > 0) {
    const stabilityPct = (data.stable / data.total) * 100;
    console.log(`≥${threshold}%      | ${data.total.toString().padStart(5)} | ${data.stable.toString().padStart(10)} | ${data.flipped.toString().padStart(5)} | ${stabilityPct.toFixed(2)}%`);
  }
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('KEY INSIGHTS');
console.log('═══════════════════════════════════════════════════════════════\n');

// Find best threshold for stability
let bestThreshold = 50;
let bestStability = 0;

for (const threshold of thresholds) {
  const data = stabilityByThreshold[threshold];
  if (data.total >= 20) { // Need at least 20 samples
    const stabilityPct = (data.stable / data.total) * 100;
    if (stabilityPct > bestStability) {
      bestStability = stabilityPct;
      bestThreshold = threshold;
    }
  }
}

const bestData = stabilityByThreshold[bestThreshold];
console.log(`Most stable threshold: ≥${bestThreshold}%`);
console.log(`  ${bestData.stable}/${bestData.total} rounds stay same (${bestStability.toFixed(2)}%)`);
console.log(`  Only ${bestData.flipped} rounds flip\n`);

// Check our strategy threshold (55%)
const strategy55 = stabilityByThreshold[55];
const strategy55Stability = (strategy55.stable / strategy55.total) * 100;

console.log(`Strategy threshold (≥55%):`);
console.log(`  ${strategy55.stable}/${strategy55.total} rounds stay same (${strategy55Stability.toFixed(2)}%)`);
console.log(`  ${strategy55.flipped} rounds flip (${((strategy55.flipped/strategy55.total)*100).toFixed(2)}%)\n`);

console.log('═══════════════════════════════════════════════════════════════');
console.log('CONCLUSION');
console.log('═══════════════════════════════════════════════════════════════\n');

if (strategy55Stability >= 75) {
  console.log(`✅ T-20s crowd is RELIABLE at ≥55% threshold`);
  console.log(`   ${strategy55Stability.toFixed(1)}% of the time, the T-20s crowd stays as crowd`);
  console.log(`   Your strategy's crowd confirmation is solid!\n`);
} else if (strategy55Stability >= 60) {
  console.log(`⚠️  T-20s crowd is MODERATELY RELIABLE at ≥55% threshold`);
  console.log(`   ${strategy55Stability.toFixed(1)}% of the time, the T-20s crowd stays as crowd`);
  console.log(`   Consider increasing threshold to ${bestThreshold}% for ${bestStability.toFixed(1)}% stability\n`);
} else {
  console.log(`❌ T-20s crowd is UNRELIABLE at ≥55% threshold`);
  console.log(`   Only ${strategy55Stability.toFixed(1)}% of the time, the T-20s crowd stays as crowd`);
  console.log(`   ${((strategy55.flipped/strategy55.total)*100).toFixed(1)}% flip by close\n`);
}

console.log('═══════════════════════════════════════════════════════════════\n');
