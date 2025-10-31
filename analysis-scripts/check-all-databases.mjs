import initSqlJs from 'sql.js';
import { readFileSync, existsSync } from 'fs';

const SQL = await initSqlJs();

const databases = [
  './data/live-monitor.db',
  './data/prediction-data.db',
  './data/prediction-data-btc.db',
  './data/prediction-data-clean.db',
];

for (const dbPath of databases) {
  if (!existsSync(dbPath)) {
    console.log(`❌ ${dbPath} - Not found\n`);
    continue;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 ${dbPath}`);
  console.log('='.repeat(60));

  const buffer = readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  // Check if snapshots table exists
  const tablesStmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table'");
  const tables = [];
  while (tablesStmt.step()) {
    tables.push(tablesStmt.getAsObject().name);
  }
  tablesStmt.free();

  console.log(`\nTables: ${tables.join(', ')}`);

  // Rounds count
  if (tables.includes('rounds')) {
    const roundsStmt = db.prepare('SELECT COUNT(*) as count, MIN(epoch) as min, MAX(epoch) as max FROM rounds');
    roundsStmt.step();
    const rounds = roundsStmt.getAsObject();
    roundsStmt.free();
    console.log(`\nRounds: ${rounds.count} (epochs ${rounds.min} to ${rounds.max})`);

    // Winner breakdown
    const winnersStmt = db.prepare(`
      SELECT winner, COUNT(*) as count
      FROM rounds
      GROUP BY winner
    `);
    console.log('Winner breakdown:');
    while (winnersStmt.step()) {
      const row = winnersStmt.getAsObject();
      console.log(`  ${row.winner}: ${row.count}`);
    }
    winnersStmt.free();
  }

  // Snapshots count
  if (tables.includes('snapshots')) {
    const snapshotsStmt = db.prepare('SELECT COUNT(*) as count FROM snapshots');
    snapshotsStmt.step();
    const snapshots = snapshotsStmt.getAsObject();
    snapshotsStmt.free();

    console.log(`\nSnapshots: ${snapshots.count} total`);

    if (snapshots.count > 0) {
      const typesStmt = db.prepare(`
        SELECT snapshot_type, COUNT(*) as count, MIN(epoch) as min_epoch, MAX(epoch) as max_epoch
        FROM snapshots
        GROUP BY snapshot_type
      `);

      console.log('Snapshot types:');
      while (typesStmt.step()) {
        const row = typesStmt.getAsObject();
        console.log(`  ${row.snapshot_type}: ${row.count} (epochs ${row.min_epoch} to ${row.max_epoch})`);
      }
      typesStmt.free();
    }
  } else {
    console.log('\n⚠️  No snapshots table found');
  }

  db.close();
}

console.log('\n' + '='.repeat(60) + '\n');
