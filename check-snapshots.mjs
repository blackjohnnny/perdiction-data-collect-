import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/snapshots.db');
const db = new SQL.Database(buffer);

// Check schema first
const schema = db.exec('SELECT sql FROM sqlite_master WHERE type="table" LIMIT 5');
console.log('Tables in snapshots.db:');
schema[0]?.values.forEach(row => console.log(row[0], '\n'));

// Get total snapshots
const total = db.exec('SELECT COUNT(*) as count FROM snapshots')[0]?.values[0][0];
console.log('Total snapshots:', total);

// Get snapshots by type
const byType = db.exec('SELECT snapshot_type, COUNT(*) as count FROM snapshots GROUP BY snapshot_type');
console.log('\nSnapshots by type:');
byType[0]?.values.forEach(row => console.log(`  ${row[0]}: ${row[1]}`));

// Get latest snapshot
const latest = db.exec('SELECT epoch, snapshot_type, taken_at FROM snapshots ORDER BY taken_at DESC LIMIT 1')[0];
if (latest) {
  console.log('\nLatest snapshot:');
  console.log(`  Epoch: ${latest.values[0][0]}`);
  console.log(`  Type: ${latest.values[0][1]}`);
  console.log(`  Time: ${new Date(latest.values[0][2] * 1000).toISOString()}`);
}

// Check how many unique epochs have snapshots
const uniqueEpochs = db.exec('SELECT COUNT(DISTINCT epoch) as count FROM snapshots')[0]?.values[0][0];
console.log('\nUnique epochs with snapshots:', uniqueEpochs);

db.close();
