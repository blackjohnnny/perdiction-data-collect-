import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('=== FINAL DATABASE VERIFICATION ===\n');

// Total rounds
const totalStmt = db.prepare('SELECT COUNT(*) as count FROM rounds');
totalStmt.step();
const total = totalStmt.getAsObject().count;
totalStmt.free();

console.log(`📊 TOTAL ROUNDS: ${total}\n`);

// Check round numbering
const numberingStmt = db.prepare(`
  SELECT MIN(round_number) as min, MAX(round_number) as max, COUNT(DISTINCT round_number) as distinct_count
  FROM rounds
`);
numberingStmt.step();
const numbering = numberingStmt.getAsObject();
numberingStmt.free();

console.log('Round Numbering:');
console.log(`  Range: #${numbering.min} to #${numbering.max}`);
console.log(`  Distinct numbers: ${numbering.distinct_count}`);
console.log(`  ${numbering.distinct_count === total ? '✅' : '❌'} All rounds uniquely numbered\n`);

// Check for gaps in numbering
const gapStmt = db.prepare(`
  WITH RECURSIVE numbers AS (
    SELECT 1 as n
    UNION ALL
    SELECT n + 1 FROM numbers WHERE n < ${total}
  )
  SELECT COUNT(*) as missing
  FROM numbers
  WHERE n NOT IN (SELECT round_number FROM rounds)
`);
gapStmt.step();
const gaps = gapStmt.getAsObject().missing;
gapStmt.free();

if (gaps === 0) {
  console.log('✅ No gaps in round numbering (sequential 1-' + total + ')\n');
} else {
  console.log(`⚠️  ${gaps} missing round numbers\n`);
}

// Breakdown by winner
console.log('Breakdown by Winner:');
const winnerStmt = db.prepare(`
  SELECT winner, COUNT(*) as count
  FROM rounds
  GROUP BY winner
  ORDER BY winner
`);

while (winnerStmt.step()) {
  const row = winnerStmt.getAsObject();
  console.log(`  ${row.winner}: ${row.count}`);
}
winnerStmt.free();

// Snapshot coverage
console.log('\nSnapshot Coverage:');
const t20Stmt = db.prepare('SELECT COUNT(DISTINCT epoch) as count FROM snapshots WHERE snapshot_type = "T_MINUS_20S"');
t20Stmt.step();
const t20 = t20Stmt.getAsObject().count;
t20Stmt.free();

const t8Stmt = db.prepare('SELECT COUNT(DISTINCT epoch) as count FROM snapshots WHERE snapshot_type = "T_MINUS_8S"');
t8Stmt.step();
const t8 = t8Stmt.getAsObject().count;
t8Stmt.free();

const t4Stmt = db.prepare('SELECT COUNT(DISTINCT epoch) as count FROM snapshots WHERE snapshot_type = "T_MINUS_4S"');
t4Stmt.step();
const t4 = t4Stmt.getAsObject().count;
t4Stmt.free();

console.log(`  T-20s: ${t20} rounds`);
console.log(`  T-8s: ${t8} rounds`);
console.log(`  T-4s: ${t4} rounds`);

// Show backfilled range
console.log('\n=== Backfilled Range (425681-425761) ===\n');
const backfilledStmt = db.prepare(`
  SELECT COUNT(*) as count, MIN(round_number) as min_num, MAX(round_number) as max_num
  FROM rounds
  WHERE epoch >= 425681 AND epoch <= 425761
`);
backfilledStmt.step();
const backfilled = backfilledStmt.getAsObject();
backfilledStmt.free();

console.log(`Rounds: ${backfilled.count}`);
if (backfilled.count > 0) {
  console.log(`Round numbers: #${backfilled.min_num} to #${backfilled.max_num}`);
}

// Show latest rounds
console.log('\n=== Latest 5 Rounds (from live monitoring) ===\n');
const latestStmt = db.prepare(`
  SELECT round_number, epoch, winner
  FROM rounds
  ORDER BY epoch DESC
  LIMIT 5
`);

while (latestStmt.step()) {
  const row = latestStmt.getAsObject();
  console.log(`Round #${row.round_number}: Epoch ${row.epoch} - Winner: ${row.winner}`);
}
latestStmt.free();

console.log('\n✅ Verification complete!');
console.log(`\nNext time you want to know how many rounds: ${total} rounds (#1 to #${total})`);

db.close();
