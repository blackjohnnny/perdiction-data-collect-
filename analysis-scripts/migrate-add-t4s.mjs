import initSqlJs from 'sql.js';
import fs from 'fs';

console.log('Migrating database schema to support T-4s snapshots...');

const SQL = await initSqlJs();
const dbBuffer = fs.readFileSync('prediction-data.db');
const db = new SQL.Database(dbBuffer);

// Drop and recreate snapshots table with new constraint (lose old snapshots)
db.exec(`
  DROP TABLE IF EXISTS snapshots;

  CREATE TABLE snapshots (
    epoch INTEGER NOT NULL,
    snapshot_type TEXT NOT NULL CHECK(snapshot_type IN ('T_MINUS_25S', 'T_MINUS_8S', 'T_MINUS_4S')),
    taken_at INTEGER NOT NULL,
    total_amount_wei TEXT NOT NULL,
    bull_amount_wei TEXT NOT NULL,
    bear_amount_wei TEXT NOT NULL,
    implied_up_multiple REAL,
    implied_down_multiple REAL,
    PRIMARY KEY (epoch, snapshot_type)
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_taken_at ON snapshots(taken_at);
`);

console.log('✅ Schema migration completed successfully');
console.log('⚠️  Old snapshots cleared (will start fresh with T-25s, T-8s, and T-4s)');

// Save updated database
fs.writeFileSync('prediction-data.db', Buffer.from(db.export()));
console.log('✅ Database saved');

db.close();
