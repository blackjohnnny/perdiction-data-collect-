import sqlite3 from 'sql.js';
import { readFileSync, writeFileSync } from 'fs';

const SQL = await sqlite3();
const db = new SQL.Database(readFileSync('prediction-data.db'));

console.log('Migrating database schema to support T-25s and T-8s snapshots...');

try {
  // Drop the old CHECK constraint by recreating the table
  db.exec(`
    -- Create temporary table with new schema
    CREATE TABLE snapshots_new (
      epoch INTEGER NOT NULL,
      snapshot_type TEXT NOT NULL CHECK(snapshot_type IN ('T_MINUS_25S', 'T_MINUS_8S')),
      taken_at INTEGER NOT NULL,
      total_amount_wei TEXT NOT NULL,
      bull_amount_wei TEXT NOT NULL,
      bear_amount_wei TEXT NOT NULL,
      implied_up_multiple REAL,
      implied_down_multiple REAL,
      PRIMARY KEY (epoch, snapshot_type)
    );

    -- Copy existing data (won't have any since old constraint was T_MINUS_20S)
    INSERT INTO snapshots_new
    SELECT * FROM snapshots WHERE 1=0;

    -- Drop old table
    DROP TABLE snapshots;

    -- Rename new table
    ALTER TABLE snapshots_new RENAME TO snapshots;

    -- Recreate index
    CREATE INDEX IF NOT EXISTS idx_snapshots_taken_at ON snapshots(taken_at);
  `);

  console.log('✅ Schema migration completed successfully');

  // Save the database
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync('prediction-data.db', buffer);
  console.log('✅ Database saved');

  // Check stats
  const stats = db.exec('SELECT COUNT(*) as count FROM snapshots');
  console.log(`\nSnapshots in database: ${stats[0].values[0][0]}`);

} catch (error) {
  console.error('❌ Migration failed:', error);
  process.exit(1);
}
