import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('=== Checking Backfilled Rounds (425681-425761) ===\n');

// Check if rounds exist
const roundsStmt = db.prepare(`
  SELECT COUNT(*) as count, MIN(epoch) as min, MAX(epoch) as max
  FROM rounds
  WHERE epoch >= 425681 AND epoch <= 425761
`);
roundsStmt.step();
const rounds = roundsStmt.getAsObject();
roundsStmt.free();

console.log(`Rounds in range: ${rounds.count} (${rounds.min} to ${rounds.max})`);

// Check winners
const winnersStmt = db.prepare(`
  SELECT winner, COUNT(*) as count
  FROM rounds
  WHERE epoch >= 425681 AND epoch <= 425761
  GROUP BY winner
`);

console.log('\nWinner breakdown:');
while (winnersStmt.step()) {
  const row = winnersStmt.getAsObject();
  console.log(`  ${row.winner}: ${row.count}`);
}
winnersStmt.free();

// Check snapshots
const snapshotsStmt = db.prepare(`
  SELECT COUNT(*) as count
  FROM snapshots
  WHERE epoch >= 425681 AND epoch <= 425761
`);
snapshotsStmt.step();
const snapshots = snapshotsStmt.getAsObject();
snapshotsStmt.free();

console.log(`\nSnapshots in range: ${snapshots.count}`);

if (snapshots.count > 0) {
  const typeStmt = db.prepare(`
    SELECT snapshot_type, COUNT(*) as count
    FROM snapshots
    WHERE epoch >= 425681 AND epoch <= 425761
    GROUP BY snapshot_type
  `);

  console.log('Snapshot types:');
  while (typeStmt.step()) {
    const row = typeStmt.getAsObject();
    console.log(`  ${row.snapshot_type}: ${row.count}`);
  }
  typeStmt.free();
}

console.log('\n⚠️  Backfill only captures finalized round data (winners), NOT snapshots!');
console.log('Snapshots can only be captured during live monitoring (T-20s, T-8s, T-4s).');

db.close();
