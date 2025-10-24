import initSqlJs from 'sql.js';
import fs from 'fs';

const SQL = await initSqlJs();
const dbBuffer = fs.readFileSync('prediction-data.db');
const db = new SQL.Database(dbBuffer);

console.log('\n=== Database Debug ===\n');

// Check snapshots table
const snapshots = db.exec(`SELECT COUNT(*) as cnt FROM snapshots`);
console.log(`Total snapshots: ${snapshots[0].values[0][0]}`);

const snapshotsByType = db.exec(`
  SELECT snapshot_type, COUNT(*) as cnt FROM snapshots GROUP BY snapshot_type
`);
console.log('\nSnapshots by type:');
snapshotsByType[0]?.values.forEach(([type, count]) => {
  console.log(`  ${type}: ${count}`);
});

// Check rounds table
const rounds = db.exec(`SELECT COUNT(*) as cnt FROM rounds`);
console.log(`\nTotal rounds: ${rounds[0].values[0][0]}`);

const roundsByWinner = db.exec(`
  SELECT winner, COUNT(*) as cnt FROM rounds GROUP BY winner
`);
console.log('\nRounds by winner:');
roundsByWinner[0]?.values.forEach(([winner, count]) => {
  console.log(`  ${winner}: ${count}`);
});

// Check if there's any overlap
const overlap = db.exec(`
  SELECT COUNT(DISTINCT s.epoch) as cnt
  FROM snapshots s
  INNER JOIN rounds r ON s.epoch = r.epoch
`);
console.log(`\nEpochs with both snapshots AND rounds: ${overlap[0].values[0][0]}`);

const overlapWithWinners = db.exec(`
  SELECT COUNT(DISTINCT s.epoch) as cnt
  FROM snapshots s
  INNER JOIN rounds r ON s.epoch = r.epoch
  WHERE r.winner IN ('UP', 'DOWN')
`);
console.log(`Epochs with snapshots AND finished rounds: ${overlapWithWinners[0].values[0][0]}`);

// Show recent snapshot epochs
const recentSnapshots = db.exec(`
  SELECT DISTINCT epoch FROM snapshots ORDER BY epoch DESC LIMIT 10
`);
console.log('\nRecent snapshot epochs:');
recentSnapshots[0]?.values.forEach(([epoch]) => console.log(`  ${epoch}`));

// Show recent round epochs
const recentRounds = db.exec(`
  SELECT epoch, winner FROM rounds ORDER BY epoch DESC LIMIT 10
`);
console.log('\nRecent round epochs:');
recentRounds[0]?.values.forEach(([epoch, winner]) => console.log(`  ${epoch}: ${winner}`));

db.close();
