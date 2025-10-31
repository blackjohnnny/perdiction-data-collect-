import initSqlJs from 'sql.js';
import fs from 'fs';

console.log('=== MIGRATING SNAPSHOT TYPES ===\n');

const dbPath = './prediction-data.db';

if (!fs.existsSync(dbPath)) {
  console.log('❌ Database not found!');
  process.exit(1);
}

const SQL = await initSqlJs();
const buffer = fs.readFileSync(dbPath);
const db = new SQL.Database(buffer);

console.log('Checking current schema...\n');

// Get current snapshot table schema
const schemaResult = db.exec(`
  SELECT sql FROM sqlite_master WHERE type='table' AND name='snapshots'
`);

if (schemaResult[0]) {
  console.log('Current snapshots table schema:');
  console.log(schemaResult[0].values[0][0]);
  console.log('');
}

// Count existing snapshots
const countResult = db.exec(`SELECT COUNT(*) as count FROM snapshots`);
const existingCount = countResult[0]?.values[0][0] || 0;

console.log(`Found ${existingCount} existing snapshots\n`);

// Backup existing data
console.log('Backing up existing snapshot data...');
const backupResult = db.exec(`SELECT * FROM snapshots`);
const backupData = backupResult[0]?.values || [];

console.log(`Backed up ${backupData.length} snapshots\n`);

// Drop and recreate table with new schema
console.log('Dropping old snapshots table...');
db.exec(`DROP TABLE IF EXISTS snapshots`);

console.log('Creating new snapshots table with updated schema...');
db.exec(`
  CREATE TABLE snapshots (
    epoch INTEGER NOT NULL,
    snapshot_type TEXT NOT NULL CHECK(snapshot_type IN ('T_MINUS_25S', 'T_MINUS_20S', 'T_MINUS_8S', 'T_MINUS_4S')),
    taken_at INTEGER NOT NULL,
    total_amount_wei TEXT NOT NULL,
    bull_amount_wei TEXT NOT NULL,
    bear_amount_wei TEXT NOT NULL,
    implied_up_multiple REAL,
    implied_down_multiple REAL,
    PRIMARY KEY (epoch, snapshot_type)
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_epoch ON snapshots(epoch);
  CREATE INDEX IF NOT EXISTS idx_snapshots_type ON snapshots(snapshot_type);
`);

// Restore existing data (only T_MINUS_20S)
if (backupData.length > 0) {
  console.log(`Restoring ${backupData.length} existing T_MINUS_20S snapshots...`);

  const stmt = db.prepare(`
    INSERT INTO snapshots (
      epoch, snapshot_type, taken_at, total_amount_wei, bull_amount_wei, bear_amount_wei,
      implied_up_multiple, implied_down_multiple
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of backupData) {
    stmt.run(row);
  }

  stmt.free();
  console.log('✓ Data restored\n');
}

// Verify
const verifyResult = db.exec(`SELECT COUNT(*) as count FROM snapshots`);
const newCount = verifyResult[0]?.values[0][0] || 0;

console.log(`Verification: ${newCount} snapshots in new table\n`);

if (newCount === existingCount) {
  console.log('✓ Migration successful! All data preserved.\n');
} else {
  console.log(`⚠ Warning: Count mismatch (${existingCount} before, ${newCount} after)\n`);
}

// Save database
console.log('Saving updated database...');
const data = db.export();
fs.writeFileSync(dbPath, Buffer.from(data));

console.log('✓ Database saved\n');

console.log('='.repeat(60));
console.log('\nMIGRATION COMPLETE!\n');
console.log('Schema now supports:');
console.log('  - T_MINUS_25S (25 seconds before lock)');
console.log('  - T_MINUS_20S (20 seconds before lock - old data)');
console.log('  - T_MINUS_8S  (8 seconds before lock)');
console.log('  - T_MINUS_4S  (4 seconds before lock)');
console.log('\nYou can now restart the live monitor: npm start live');

db.close();
