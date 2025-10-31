import initSqlJs from 'sql.js';
import fs from 'fs';

const sqlJs = await initSqlJs();

// Load old database
console.log('Loading existing database...');
const oldBuf = fs.readFileSync('./prediction-data.db');
const oldDb = new sqlJs.Database(oldBuf);

// Create new database with clean schema
console.log('Creating new organized database...');
const newDb = new sqlJs.Database();

// Create new schema with snapshots as columns
newDb.run(`
  CREATE TABLE rounds (
    epoch INTEGER PRIMARY KEY,
    start_ts INTEGER NOT NULL,
    lock_ts INTEGER NOT NULL,
    close_ts INTEGER NOT NULL,
    lock_price TEXT NOT NULL,
    close_price TEXT NOT NULL,
    total_amount_wei TEXT NOT NULL,
    bull_amount_wei TEXT NOT NULL,
    bear_amount_wei TEXT NOT NULL,
    oracle_called INTEGER NOT NULL,
    reward_base_cal_wei TEXT NOT NULL,
    reward_amount_wei TEXT NOT NULL,
    winner TEXT NOT NULL CHECK(winner IN ('UP','DOWN','DRAW','UNKNOWN')),
    winner_multiple REAL,

    -- T-20s snapshot data
    t20s_total_wei TEXT,
    t20s_bull_wei TEXT,
    t20s_bear_wei TEXT,
    t20s_implied_up_multiple REAL,
    t20s_implied_down_multiple REAL,
    t20s_taken_at INTEGER,

    -- T-25s snapshot data
    t25s_total_wei TEXT,
    t25s_bull_wei TEXT,
    t25s_bear_wei TEXT,
    t25s_implied_up_multiple REAL,
    t25s_implied_down_multiple REAL,
    t25s_taken_at INTEGER,

    -- T-8s snapshot data
    t8s_total_wei TEXT,
    t8s_bull_wei TEXT,
    t8s_bear_wei TEXT,
    t8s_implied_up_multiple REAL,
    t8s_implied_down_multiple REAL,
    t8s_taken_at INTEGER,

    -- T-4s snapshot data
    t4s_total_wei TEXT,
    t4s_bull_wei TEXT,
    t4s_bear_wei TEXT,
    t4s_implied_up_multiple REAL,
    t4s_implied_down_multiple REAL,
    t4s_taken_at INTEGER,

    inserted_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

console.log('New schema created\n');

// Get all rounds
const roundsResult = oldDb.exec('SELECT * FROM rounds ORDER BY epoch');
const rounds = roundsResult[0];
const roundColumns = rounds.columns;
const roundRows = rounds.values;

console.log(`Found ${roundRows.length} rounds to migrate`);

// Get all snapshots grouped by epoch
const snapshotsResult = oldDb.exec(`
  SELECT
    epoch,
    snapshot_type,
    total_amount_wei,
    bull_amount_wei,
    bear_amount_wei,
    implied_up_multiple,
    implied_down_multiple,
    taken_at
  FROM snapshots
  ORDER BY epoch, snapshot_type
`);

// Build a map of epoch -> snapshot data
const snapshotMap = new Map();
if (snapshotsResult.length > 0) {
  snapshotsResult[0].values.forEach(row => {
    const [epoch, type, total, bull, bear, impliedUp, impliedDown, takenAt] = row;

    if (!snapshotMap.has(epoch)) {
      snapshotMap.set(epoch, {});
    }

    snapshotMap.get(epoch)[type] = {
      total, bull, bear, impliedUp, impliedDown, takenAt
    };
  });
}

console.log(`Found ${snapshotMap.size} epochs with snapshot data`);

// Insert rounds with snapshot columns
let inserted = 0;
let withT20s = 0;
let withT25s = 0;
let withT8s = 0;
let withT4s = 0;

const insertStmt = newDb.prepare(`
  INSERT INTO rounds VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?
  )
`);

roundRows.forEach(row => {
  const epoch = row[0];
  const snapshots = snapshotMap.get(epoch) || {};

  const t20 = snapshots['T_MINUS_20S'];
  const t25 = snapshots['T_MINUS_25S'];
  const t8 = snapshots['T_MINUS_8S'];
  const t4 = snapshots['T_MINUS_4S'];

  if (t20) withT20s++;
  if (t25) withT25s++;
  if (t8) withT8s++;
  if (t4) withT4s++;

  insertStmt.run([
    ...row.slice(0, 14), // All original round columns
    // T-20s
    t20?.total || null, t20?.bull || null, t20?.bear || null,
    t20?.impliedUp || null, t20?.impliedDown || null, t20?.takenAt || null,
    // T-25s
    t25?.total || null, t25?.bull || null, t25?.bear || null,
    t25?.impliedUp || null, t25?.impliedDown || null, t25?.takenAt || null,
    // T-8s
    t8?.total || null, t8?.bull || null, t8?.bear || null,
    t8?.impliedUp || null, t8?.impliedDown || null, t8?.takenAt || null,
    // T-4s
    t4?.total || null, t4?.bull || null, t4?.bear || null,
    t4?.impliedUp || null, t4?.impliedDown || null, t4?.takenAt || null,
    row[14], row[15] // inserted_at, updated_at
  ]);

  inserted++;
  if (inserted % 1000 === 0) {
    console.log(`Migrated ${inserted}/${roundRows.length} rounds...`);
  }
});

insertStmt.free();

console.log(`\n=== Migration Complete ===`);
console.log(`Total rounds migrated: ${inserted}`);
console.log(`Rounds with T-20s data: ${withT20s}`);
console.log(`Rounds with T-25s data: ${withT25s}`);
console.log(`Rounds with T-8s data: ${withT8s}`);
console.log(`Rounds with T-4s data: ${withT4s}`);

// Save new database
const data = newDb.export();
const buffer = Buffer.from(data);
fs.writeFileSync('./prediction-data-clean.db', buffer);

console.log('\n✅ New database saved as: prediction-data-clean.db');

// Show sample data
const sample = newDb.exec(`
  SELECT
    epoch,
    winner,
    CASE WHEN t20s_total_wei IS NOT NULL THEN 'Yes' ELSE '-' END as t20s,
    CASE WHEN t25s_total_wei IS NOT NULL THEN 'Yes' ELSE '-' END as t25s,
    CASE WHEN t8s_total_wei IS NOT NULL THEN 'Yes' ELSE '-' END as t8s,
    CASE WHEN t4s_total_wei IS NOT NULL THEN 'Yes' ELSE '-' END as t4s
  FROM rounds
  WHERE t20s_total_wei IS NOT NULL OR t25s_total_wei IS NOT NULL OR t8s_total_wei IS NOT NULL OR t4s_total_wei IS NOT NULL
  ORDER BY epoch DESC
  LIMIT 10
`);

console.log('\n=== Sample of rounds with snapshot data (latest 10) ===');
console.log('Epoch    | Winner | T-20s | T-25s | T-8s | T-4s');
console.log('---------|--------|-------|-------|------|------');
sample[0].values.forEach(row => {
  console.log(`${row[0]} | ${row[1].padEnd(6)} | ${row[2].padEnd(5)} | ${row[3].padEnd(5)} | ${row[4].padEnd(4)} | ${row[5]}`);
});

oldDb.close();
newDb.close();
