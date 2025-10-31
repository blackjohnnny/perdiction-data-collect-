import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('=== Detailed Snapshot Analysis ===\n');

// Check snapshot types and their counts
const allSnapshotsStmt = db.prepare(`
  SELECT snapshot_type, COUNT(*) as count
  FROM snapshots
  GROUP BY snapshot_type
  ORDER BY snapshot_type
`);

console.log('Snapshot type distribution:');
while (allSnapshotsStmt.step()) {
  const row = allSnapshotsStmt.getAsObject();
  console.log(`  ${row.snapshot_type}: ${row.count} snapshots`);
}
allSnapshotsStmt.free();

// Check epoch ranges for each snapshot type
console.log('\nEpoch ranges by snapshot type:');

const t20RangeStmt = db.prepare(`
  SELECT
    MIN(epoch) as min_epoch,
    MAX(epoch) as max_epoch,
    COUNT(*) as count
  FROM snapshots
  WHERE snapshot_type IN ('t20s', 'T_MINUS_20S')
`);
t20RangeStmt.step();
const t20Range = t20RangeStmt.getAsObject();
t20RangeStmt.free();
console.log(`  T-20s: ${t20Range.count} snapshots (epochs ${t20Range.min_epoch} to ${t20Range.max_epoch})`);

const t8RangeStmt = db.prepare(`
  SELECT
    MIN(epoch) as min_epoch,
    MAX(epoch) as max_epoch,
    COUNT(*) as count
  FROM snapshots
  WHERE snapshot_type IN ('t8s', 'T_MINUS_8S')
`);
t8RangeStmt.step();
const t8Range = t8RangeStmt.getAsObject();
t8RangeStmt.free();
console.log(`  T-8s: ${t8Range.count} snapshots (epochs ${t8Range.min_epoch || 'N/A'} to ${t8Range.max_epoch || 'N/A'})`);

const t4RangeStmt = db.prepare(`
  SELECT
    MIN(epoch) as min_epoch,
    MAX(epoch) as max_epoch,
    COUNT(*) as count
  FROM snapshots
  WHERE snapshot_type IN ('t4s', 'T_MINUS_4S')
`);
t4RangeStmt.step();
const t4Range = t4RangeStmt.getAsObject();
t4RangeStmt.free();
console.log(`  T-4s: ${t4Range.count} snapshots (epochs ${t4Range.min_epoch || 'N/A'} to ${t4Range.max_epoch || 'N/A'})`);

// Check for old "t20s" vs new "T_MINUS_20S" format
console.log('\n=== Checking for old vs new snapshot format ===\n');

const oldFormatStmt = db.prepare(`
  SELECT snapshot_type, COUNT(*) as count
  FROM snapshots
  WHERE snapshot_type IN ('t20s', 't8s', 't4s', 't25s')
  GROUP BY snapshot_type
`);

console.log('Old format (lowercase):');
let hasOldFormat = false;
while (oldFormatStmt.step()) {
  hasOldFormat = true;
  const row = oldFormatStmt.getAsObject();
  console.log(`  ${row.snapshot_type}: ${row.count}`);
}
if (!hasOldFormat) {
  console.log('  None found');
}
oldFormatStmt.free();

const newFormatStmt = db.prepare(`
  SELECT snapshot_type, COUNT(*) as count
  FROM snapshots
  WHERE snapshot_type IN ('T_MINUS_20S', 'T_MINUS_8S', 'T_MINUS_4S')
  GROUP BY snapshot_type
`);

console.log('\nNew format (T_MINUS_*):');
let hasNewFormat = false;
while (newFormatStmt.step()) {
  hasNewFormat = true;
  const row = newFormatStmt.getAsObject();
  console.log(`  ${row.snapshot_type}: ${row.count}`);
}
if (!hasNewFormat) {
  console.log('  None found');
}
newFormatStmt.free();

// Breakdown by epoch range
console.log('\n=== Snapshot Coverage by Epoch Range ===\n');

// Old data (epochs < 425621)
const oldDataStmt = db.prepare(`
  SELECT
    COUNT(DISTINCT r.epoch) as total_epochs,
    COUNT(DISTINCT CASE WHEN s.snapshot_type IN ('t20s', 'T_MINUS_20S') THEN r.epoch END) as with_t20s,
    COUNT(DISTINCT CASE WHEN s.snapshot_type IN ('t8s', 'T_MINUS_8S') THEN r.epoch END) as with_t8s,
    COUNT(DISTINCT CASE WHEN s.snapshot_type IN ('t4s', 'T_MINUS_4S') THEN r.epoch END) as with_t4s
  FROM rounds r
  LEFT JOIN snapshots s ON r.epoch = s.epoch
  WHERE r.epoch < 425621
`);
oldDataStmt.step();
const oldData = oldDataStmt.getAsObject();
oldDataStmt.free();

console.log(`Old data (epochs < 425621):`);
console.log(`  Total epochs: ${oldData.total_epochs}`);
console.log(`  With T-20s: ${oldData.with_t20s}`);
console.log(`  With T-8s: ${oldData.with_t8s}`);
console.log(`  With T-4s: ${oldData.with_t4s}`);

// New data (epochs >= 425621)
const newDataStmt = db.prepare(`
  SELECT
    COUNT(DISTINCT r.epoch) as total_epochs,
    COUNT(DISTINCT CASE WHEN s.snapshot_type IN ('t20s', 'T_MINUS_20S') THEN r.epoch END) as with_t20s,
    COUNT(DISTINCT CASE WHEN s.snapshot_type IN ('t8s', 'T_MINUS_8S') THEN r.epoch END) as with_t8s,
    COUNT(DISTINCT CASE WHEN s.snapshot_type IN ('t4s', 'T_MINUS_4S') THEN r.epoch END) as with_t4s
  FROM rounds r
  LEFT JOIN snapshots s ON r.epoch = s.epoch
  WHERE r.epoch >= 425621
`);
newDataStmt.step();
const newData = newDataStmt.getAsObject();
newDataStmt.free();

console.log(`\nNew data (epochs >= 425621):`);
console.log(`  Total epochs: ${newData.total_epochs}`);
console.log(`  With T-20s: ${newData.with_t20s}`);
console.log(`  With T-8s: ${newData.with_t8s}`);
console.log(`  With T-4s: ${newData.with_t4s}`);

// Sample of old snapshot data
console.log('\n=== Sample of old snapshot data (first 5 epochs) ===\n');
const sampleStmt = db.prepare(`
  SELECT r.epoch, s.snapshot_type
  FROM rounds r
  LEFT JOIN snapshots s ON r.epoch = s.epoch
  WHERE r.epoch < 425621
  ORDER BY r.epoch
  LIMIT 20
`);

let lastEpoch = null;
while (sampleStmt.step()) {
  const row = sampleStmt.getAsObject();
  if (row.epoch !== lastEpoch) {
    console.log(`\nEpoch ${row.epoch}:`);
    lastEpoch = row.epoch;
  }
  console.log(`  - ${row.snapshot_type || 'NO SNAPSHOTS'}`);
}
sampleStmt.free();

db.close();
