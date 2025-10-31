import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('=== Data Collection Status ===\n');

// Total rounds
const totalStmt = db.prepare('SELECT COUNT(*) as count FROM rounds');
totalStmt.step();
const total = totalStmt.getAsObject().count;
totalStmt.free();

console.log(`Total rounds in database: ${total}`);

// Latest epoch
const latestStmt = db.prepare('SELECT MAX(epoch) as latest FROM rounds');
latestStmt.step();
const latest = latestStmt.getAsObject().latest;
latestStmt.free();

console.log(`Latest epoch: ${latest}`);

// Oldest epoch
const oldestStmt = db.prepare('SELECT MIN(epoch) as oldest FROM rounds');
oldestStmt.step();
const oldest = oldestStmt.getAsObject().oldest;
oldestStmt.free();

console.log(`Oldest epoch: ${oldest}\n`);

// Snapshot counts
console.log('=== Snapshot Counts ===\n');

const t20Stmt = db.prepare("SELECT COUNT(DISTINCT epoch) as count FROM snapshots WHERE snapshot_type = 't20s' OR snapshot_type = 'T_MINUS_20S'");
t20Stmt.step();
const t20 = t20Stmt.getAsObject().count;
t20Stmt.free();

const t8Stmt = db.prepare("SELECT COUNT(DISTINCT epoch) as count FROM snapshots WHERE snapshot_type = 't8s' OR snapshot_type = 'T_MINUS_8S'");
t8Stmt.step();
const t8 = t8Stmt.getAsObject().count;
t8Stmt.free();

const t4Stmt = db.prepare("SELECT COUNT(DISTINCT epoch) as count FROM snapshots WHERE snapshot_type = 't4s' OR snapshot_type = 'T_MINUS_4S'");
t4Stmt.step();
const t4 = t4Stmt.getAsObject().count;
t4Stmt.free();

console.log(`T-20s snapshots: ${t20} epochs`);
console.log(`T-8s snapshots: ${t8} epochs`);
console.log(`T-4s snapshots: ${t4} epochs`);

// Check all snapshot types
const allSnapshotTypesStmt = db.prepare("SELECT DISTINCT snapshot_type FROM snapshots");
const snapshotTypes = [];
while (allSnapshotTypesStmt.step()) {
  snapshotTypes.push(allSnapshotTypesStmt.getAsObject().snapshot_type);
}
allSnapshotTypesStmt.free();

console.log(`\nSnapshot types in database: ${snapshotTypes.join(', ')}`);

// Rounds with complete snapshot sets (all 3)
const completeStmt = db.prepare(`
  SELECT COUNT(DISTINCT r.epoch) as count
  FROM rounds r
  WHERE EXISTS (
    SELECT 1 FROM snapshots s1
    WHERE s1.epoch = r.epoch AND (s1.snapshot_type = 't20s' OR s1.snapshot_type = 'T_MINUS_20S')
  )
  AND EXISTS (
    SELECT 1 FROM snapshots s2
    WHERE s2.epoch = r.epoch AND (s2.snapshot_type = 't8s' OR s2.snapshot_type = 'T_MINUS_8S')
  )
  AND EXISTS (
    SELECT 1 FROM snapshots s3
    WHERE s3.epoch = r.epoch AND (s3.snapshot_type = 't4s' OR s3.snapshot_type = 'T_MINUS_4S')
  )
`);
completeStmt.step();
const complete = completeStmt.getAsObject().count;
completeStmt.free();

console.log(`\nRounds with all 3 snapshots (T-20s, T-8s, T-4s): ${complete}`);

// Rounds with results (known winner)
const resultsStmt = db.prepare("SELECT COUNT(*) as count FROM rounds WHERE winner IN ('UP', 'DOWN')");
resultsStmt.step();
const withResults = resultsStmt.getAsObject().count;
resultsStmt.free();

console.log(`Rounds with complete results (winner known): ${withResults}`);

db.close();
