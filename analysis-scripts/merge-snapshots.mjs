import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'fs';

console.log('=== Merging Snapshot Data ===\n');

const SQL = await initSqlJs();

// Load source database (has the snapshot data)
console.log('Loading prediction-data.db (source)...');
const sourceBuffer = readFileSync('./data/prediction-data.db');
const sourceDb = new SQL.Database(sourceBuffer);

// Load target database (where we want to merge snapshots)
console.log('Loading live-monitor.db (target)...');
const targetBuffer = readFileSync('./data/live-monitor.db');
const targetDb = new SQL.Database(targetBuffer);

// Get all snapshots from source
console.log('\nFetching snapshots from prediction-data.db...');
const snapshotsStmt = sourceDb.prepare('SELECT * FROM snapshots ORDER BY epoch, snapshot_type');

const snapshots = [];
while (snapshotsStmt.step()) {
  snapshots.push(snapshotsStmt.getAsObject());
}
snapshotsStmt.free();

console.log(`Found ${snapshots.length} snapshots to merge\n`);

// Group by type
const byType = {};
snapshots.forEach(s => {
  if (!byType[s.snapshot_type]) byType[s.snapshot_type] = 0;
  byType[s.snapshot_type]++;
});

console.log('Snapshot breakdown:');
Object.entries(byType).forEach(([type, count]) => {
  console.log(`  ${type}: ${count}`);
});

// Check which epochs exist in target database
console.log('\nChecking which epochs exist in live-monitor.db...');
const epochCheckStmt = targetDb.prepare('SELECT epoch FROM rounds');
const existingEpochs = new Set();
while (epochCheckStmt.step()) {
  existingEpochs.add(epochCheckStmt.getAsObject().epoch);
}
epochCheckStmt.free();

console.log(`Target database has ${existingEpochs.size} epochs\n`);

// Insert snapshots that match existing epochs
console.log('Merging snapshots...\n');

const insertStmt = targetDb.prepare(`
  INSERT OR REPLACE INTO snapshots (
    epoch,
    snapshot_type,
    taken_at,
    total_amount_wei,
    bull_amount_wei,
    bear_amount_wei,
    implied_up_multiple,
    implied_down_multiple
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

let inserted = 0;
let skipped = 0;

const allowedTypes = ['T_MINUS_20S', 'T_MINUS_8S', 'T_MINUS_4S'];

snapshots.forEach(snapshot => {
  // Only merge snapshots for epochs that exist in target database
  // AND only allowed snapshot types (skip T_MINUS_25S)
  if (existingEpochs.has(snapshot.epoch) && allowedTypes.includes(snapshot.snapshot_type)) {
    insertStmt.bind([
      snapshot.epoch,
      snapshot.snapshot_type,
      snapshot.taken_at,
      snapshot.total_amount_wei,
      snapshot.bull_amount_wei,
      snapshot.bear_amount_wei,
      snapshot.implied_up_multiple,
      snapshot.implied_down_multiple,
    ]);
    insertStmt.step();
    insertStmt.reset();
    inserted++;
  } else {
    skipped++;
  }
});

insertStmt.free();

console.log(`✅ Inserted: ${inserted} snapshots`);
console.log(`⏭️  Skipped: ${skipped} snapshots (epochs not in target database)\n`);

// Save the merged database
console.log('Saving merged database...');
const mergedData = targetDb.export();
writeFileSync('./data/live-monitor.db', Buffer.from(mergedData));

console.log('✅ Saved to data/live-monitor.db\n');

// Show final statistics
console.log('=== Final Statistics ===\n');

const finalStmt = targetDb.prepare(`
  SELECT snapshot_type, COUNT(*) as count, MIN(epoch) as min_epoch, MAX(epoch) as max_epoch
  FROM snapshots
  GROUP BY snapshot_type
  ORDER BY snapshot_type
`);

console.log('Snapshots in live-monitor.db:');
while (finalStmt.step()) {
  const row = finalStmt.getAsObject();
  console.log(`  ${row.snapshot_type}: ${row.count} (epochs ${row.min_epoch} to ${row.max_epoch})`);
}
finalStmt.free();

// Count epochs with complete snapshot sets
const completeStmt = targetDb.prepare(`
  SELECT COUNT(DISTINCT r.epoch) as count
  FROM rounds r
  WHERE EXISTS (
    SELECT 1 FROM snapshots s1 WHERE s1.epoch = r.epoch AND s1.snapshot_type = 'T_MINUS_20S'
  )
  AND EXISTS (
    SELECT 1 FROM snapshots s2 WHERE s2.epoch = r.epoch AND s2.snapshot_type = 'T_MINUS_8S'
  )
  AND EXISTS (
    SELECT 1 FROM snapshots s3 WHERE s3.epoch = r.epoch AND s3.snapshot_type = 'T_MINUS_4S'
  )
`);
completeStmt.step();
const complete = completeStmt.getAsObject().count;
completeStmt.free();

console.log(`\nRounds with all 3 snapshots (T-20s, T-8s, T-4s): ${complete}`);

// Count with just T-20s
const t20OnlyStmt = targetDb.prepare(`
  SELECT COUNT(DISTINCT epoch) as count FROM snapshots WHERE snapshot_type = 'T_MINUS_20S'
`);
t20OnlyStmt.step();
const t20Only = t20OnlyStmt.getAsObject().count;
t20OnlyStmt.free();

console.log(`Rounds with T-20s snapshots: ${t20Only}`);

sourceDb.close();
targetDb.close();

console.log('\n✅ Merge complete!');
