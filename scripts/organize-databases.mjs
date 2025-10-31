import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'fs';

console.log('Organizing databases...\n');

const SQL = await initSqlJs();
const sourceBuffer = readFileSync('./data/live-monitor.db');
const sourceDb = new SQL.Database(sourceBuffer);

// 1. Create live.db - rounds WITH T-20s snapshot data
console.log('Creating live.db (rounds with T-20s data)...');
const liveDb = new SQL.Database();
liveDb.exec(`
  CREATE TABLE rounds (
    epoch INTEGER PRIMARY KEY,
    lock_ts INTEGER NOT NULL,
    close_ts INTEGER NOT NULL,
    lock_price TEXT NOT NULL,
    close_price TEXT NOT NULL,
    winner TEXT NOT NULL,
    winner_multiple REAL,
    t20s_bull_wei TEXT NOT NULL,
    t20s_bear_wei TEXT NOT NULL,
    t20s_total_wei TEXT NOT NULL,
    bull_amount_wei TEXT NOT NULL,
    bear_amount_wei TEXT NOT NULL,
    total_amount_wei TEXT NOT NULL
  );
`);

const liveRounds = sourceDb.exec(`
  SELECT epoch, lock_ts, close_ts, lock_price, close_price, winner, winner_multiple,
         t20s_bull_wei, t20s_bear_wei, t20s_total_wei,
         bull_amount_wei, bear_amount_wei, total_amount_wei
  FROM rounds
  WHERE t20s_total_wei IS NOT NULL AND winner != 'UNKNOWN'
  ORDER BY epoch ASC
`);

if (liveRounds.length > 0) {
  const stmt = liveDb.prepare(`
    INSERT INTO rounds VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of liveRounds[0].values) {
    stmt.run(row);
  }
  stmt.free();
}

const liveData = liveDb.export();
writeFileSync('./data/live.db', Buffer.from(liveData));
console.log(`✓ live.db created with ${liveRounds[0]?.values.length || 0} rounds\n`);

// 2. Create snapshots.db - raw snapshot data
console.log('Creating snapshots.db (raw snapshot storage)...');
const snapshotsDb = new SQL.Database();
snapshotsDb.exec(`
  CREATE TABLE snapshots (
    epoch INTEGER NOT NULL,
    snapshot_type TEXT NOT NULL,
    taken_at INTEGER NOT NULL,
    bull_wei TEXT NOT NULL,
    bear_wei TEXT NOT NULL,
    total_wei TEXT NOT NULL,
    implied_up_multiple REAL,
    implied_down_multiple REAL,
    PRIMARY KEY (epoch, snapshot_type)
  );
`);

const snapshotData = sourceDb.exec(`SELECT * FROM snapshots ORDER BY epoch, snapshot_type`);
if (snapshotData.length > 0) {
  const stmt = snapshotsDb.prepare(`
    INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of snapshotData[0].values) {
    stmt.run(row);
  }
  stmt.free();
}

const snapData = snapshotsDb.export();
writeFileSync('./data/snapshots.db', Buffer.from(snapData));
console.log(`✓ snapshots.db created with ${snapshotData[0]?.values.length || 0} snapshots\n`);

// 3. Create historic.db - rounds WITHOUT T-20s data
console.log('Creating historic.db (rounds without snapshot data)...');
const historicDb = new SQL.Database();
historicDb.exec(`
  CREATE TABLE rounds (
    epoch INTEGER PRIMARY KEY,
    lock_ts INTEGER NOT NULL,
    close_ts INTEGER NOT NULL,
    lock_price TEXT NOT NULL,
    close_price TEXT NOT NULL,
    winner TEXT NOT NULL,
    winner_multiple REAL,
    bull_amount_wei TEXT NOT NULL,
    bear_amount_wei TEXT NOT NULL,
    total_amount_wei TEXT NOT NULL
  );
`);

const historicRounds = sourceDb.exec(`
  SELECT epoch, lock_ts, close_ts, lock_price, close_price, winner, winner_multiple,
         bull_amount_wei, bear_amount_wei, total_amount_wei
  FROM rounds
  WHERE t20s_total_wei IS NULL AND winner != 'UNKNOWN'
  ORDER BY epoch ASC
`);

if (historicRounds.length > 0) {
  const stmt = historicDb.prepare(`
    INSERT INTO rounds VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of historicRounds[0].values) {
    stmt.run(row);
  }
  stmt.free();
}

const historicData = historicDb.export();
writeFileSync('./data/historic.db', Buffer.from(historicData));
console.log(`✓ historic.db created with ${historicRounds[0]?.values.length || 0} rounds\n`);

console.log('Database organization complete!\n');
console.log('Summary:');
console.log(`  live.db: ${liveRounds[0]?.values.length || 0} rounds (with T-20s + settled)`);
console.log(`  snapshots.db: ${snapshotData[0]?.values.length || 0} raw snapshots`);
console.log(`  historic.db: ${historicRounds[0]?.values.length || 0} rounds (no snapshots)`);

sourceDb.close();
liveDb.close();
snapshotsDb.close();
historicDb.close();
