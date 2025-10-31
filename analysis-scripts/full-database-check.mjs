import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('=== FULL DATABASE CHECK: live-monitor.db ===\n');

// Total rounds
const totalStmt = db.prepare('SELECT COUNT(*) as count FROM rounds');
totalStmt.step();
const total = totalStmt.getAsObject().count;
totalStmt.free();

console.log(`Total rounds: ${total}\n`);

// Total snapshots
const snapshotTotalStmt = db.prepare('SELECT COUNT(*) as count FROM snapshots');
snapshotTotalStmt.step();
const snapshotTotal = snapshotTotalStmt.getAsObject().count;
snapshotTotalStmt.free();

console.log(`Total snapshots: ${snapshotTotal}\n`);

// Snapshots by type
console.log('Snapshots by type:');
const typeStmt = db.prepare(`
  SELECT snapshot_type, COUNT(*) as count, MIN(epoch) as min_epoch, MAX(epoch) as max_epoch
  FROM snapshots
  GROUP BY snapshot_type
`);

while (typeStmt.step()) {
  const row = typeStmt.getAsObject();
  console.log(`  ${row.snapshot_type}: ${row.count} snapshots (epochs ${row.min_epoch} - ${row.max_epoch})`);
}
typeStmt.free();

// Check specific epoch ranges
console.log('\n=== Snapshot Coverage by Epoch Range ===\n');

const ranges = [
  { name: 'Original data', start: 423620, end: 425620 },
  { name: 'Gap (backfilled)', start: 425681, end: 425761 },
  { name: 'Live monitoring', start: 425762, end: 999999 },
];

for (const range of ranges) {
  const stmt = db.prepare(`
    SELECT
      COUNT(DISTINCT r.epoch) as total_rounds,
      COUNT(DISTINCT CASE WHEN s.snapshot_type = 'T_MINUS_20S' THEN s.epoch END) as t20s,
      COUNT(DISTINCT CASE WHEN s.snapshot_type = 'T_MINUS_8S' THEN s.epoch END) as t8s,
      COUNT(DISTINCT CASE WHEN s.snapshot_type = 'T_MINUS_4S' THEN s.epoch END) as t4s
    FROM rounds r
    LEFT JOIN snapshots s ON r.epoch = s.epoch
    WHERE r.epoch >= ${range.start} AND r.epoch <= ${range.end}
  `);

  stmt.step();
  const data = stmt.getAsObject();
  stmt.free();

  console.log(`${range.name} (${range.start}-${range.end}):`);
  console.log(`  Rounds: ${data.total_rounds}`);
  console.log(`  T-20s: ${data.t20s}`);
  console.log(`  T-8s: ${data.t8s}`);
  console.log(`  T-4s: ${data.t4s}`);
  console.log('');
}

// Show some sample rounds with their snapshots
console.log('=== Sample: First 10 Rounds with Snapshots ===\n');

const sampleStmt = db.prepare(`
  SELECT r.epoch, GROUP_CONCAT(s.snapshot_type) as snapshot_types
  FROM rounds r
  LEFT JOIN snapshots s ON r.epoch = s.epoch
  GROUP BY r.epoch
  HAVING snapshot_types IS NOT NULL
  ORDER BY r.epoch
  LIMIT 10
`);

while (sampleStmt.step()) {
  const row = sampleStmt.getAsObject();
  console.log(`Epoch ${row.epoch}: ${row.snapshot_types || 'NO SNAPSHOTS'}`);
}
sampleStmt.free();

// Check if we have T-20s data at all
console.log('\n=== Summary ===\n');

const hasT20Stmt = db.prepare(`
  SELECT COUNT(DISTINCT epoch) as count FROM snapshots WHERE snapshot_type = 'T_MINUS_20S'
`);
hasT20Stmt.step();
const hasT20 = hasT20Stmt.getAsObject().count;
hasT20Stmt.free();

if (hasT20 > 0) {
  console.log(`✅ Database HAS T-20s data: ${hasT20} epochs`);
} else {
  console.log('❌ Database has NO T-20s data!');
}

db.close();
