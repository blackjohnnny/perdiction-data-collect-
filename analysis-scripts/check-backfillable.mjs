import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

// Get epochs with complete snapshot sets (T-25s, T-8s, T-4s)
const snapshotQuery = `
  SELECT DISTINCT epoch
  FROM snapshots
  WHERE snapshot_type IN ('T_MINUS_25S', 'T_MINUS_8S', 'T_MINUS_4S')
  GROUP BY epoch
  HAVING COUNT(DISTINCT snapshot_type) = 3
  ORDER BY epoch
`;

const stmt1 = db.prepare(snapshotQuery);
const snapshotEpochs = [];
while (stmt1.step()) {
  snapshotEpochs.push(stmt1.getAsObject().epoch);
}
stmt1.free();

console.log(`Total epochs with T-25s + T-8s + T-4s: ${snapshotEpochs.length}`);

// Check which ones already have results
const withResults = [];
const withoutResults = [];

for (const epoch of snapshotEpochs) {
  const checkQuery = `
    SELECT epoch, winner
    FROM rounds
    WHERE epoch = ${epoch}
      AND winner IN ('UP', 'DOWN')
  `;

  const stmt = db.prepare(checkQuery);
  const hasResult = stmt.step();

  if (hasResult) {
    withResults.push(epoch);
  } else {
    withoutResults.push(epoch);
  }
  stmt.free();
}

console.log(`\nWith final results (backfilled): ${withResults.length}`);
console.log(`Without final results (pending): ${withoutResults.length}`);

if (withoutResults.length > 0) {
  console.log(`\nPending epochs: ${withoutResults.slice(0, 5).join(', ')}${withoutResults.length > 5 ? '...' : ''}`);
  console.log(`Latest pending: ${withoutResults.slice(-5).join(', ')}`);
}

db.close();
