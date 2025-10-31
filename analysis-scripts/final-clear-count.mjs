import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('=== FINAL CLEAR COUNT ===\n');

// Total rounds in database
const totalStmt = db.prepare('SELECT COUNT(*) as count FROM rounds');
totalStmt.step();
const total = totalStmt.getAsObject().count;
totalStmt.free();

console.log(`📊 TOTAL ROUNDS IN DATABASE: ${total}\n`);

// Breakdown by winner
console.log('Breakdown by winner status:');
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

// Rounds with known results
const knownStmt = db.prepare(`SELECT COUNT(*) as count FROM rounds WHERE winner IN ('UP', 'DOWN')`);
knownStmt.step();
const known = knownStmt.getAsObject().count;
knownStmt.free();

console.log(`\n✅ Rounds with known winners (UP/DOWN): ${known}`);
console.log(`⏳ Rounds with UNKNOWN winner: ${total - known}\n`);

// Snapshot counts
console.log('=== SNAPSHOT COVERAGE ===\n');

const t20Stmt = db.prepare(`SELECT COUNT(DISTINCT epoch) as count FROM snapshots WHERE snapshot_type = 'T_MINUS_20S'`);
t20Stmt.step();
const t20 = t20Stmt.getAsObject().count;
t20Stmt.free();

const t8Stmt = db.prepare(`SELECT COUNT(DISTINCT epoch) as count FROM snapshots WHERE snapshot_type = 'T_MINUS_8S'`);
t8Stmt.step();
const t8 = t8Stmt.getAsObject().count;
t8Stmt.free();

const t4Stmt = db.prepare(`SELECT COUNT(DISTINCT epoch) as count FROM snapshots WHERE snapshot_type = 'T_MINUS_4S'`);
t4Stmt.step();
const t4 = t4Stmt.getAsObject().count;
t4Stmt.free();

console.log(`Rounds with T-20s snapshots: ${t20}`);
console.log(`Rounds with T-8s snapshots: ${t8}`);
console.log(`Rounds with T-4s snapshots: ${t4}\n`);

// Usable for strategy (has T-20s AND known winner)
const usableStmt = db.prepare(`
  SELECT COUNT(DISTINCT r.epoch) as count
  FROM rounds r
  JOIN snapshots s ON r.epoch = s.epoch AND s.snapshot_type = 'T_MINUS_20S'
  WHERE r.winner IN ('UP', 'DOWN')
`);
usableStmt.step();
const usable = usableStmt.getAsObject().count;
usableStmt.free();

console.log(`🎯 USABLE FOR STRATEGY (has T-20s + known winner): ${usable}\n`);

// Show the math
console.log('=== THE MATH ===\n');
console.log(`Total rounds: ${total}`);
console.log(`  - Rounds with known winners: ${known}`);
console.log(`  - Rounds with T-20s snapshots: ${t20}`);
console.log(`  = Rounds usable for strategy: ${usable} (overlap of above two)`);

db.close();
