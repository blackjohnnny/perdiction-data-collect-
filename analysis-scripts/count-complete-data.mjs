import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

// Count rounds that have BOTH snapshots AND final results
const query = `
  SELECT COUNT(DISTINCT r.epoch) as count
  FROM rounds r
  JOIN snapshots s ON r.epoch = s.epoch
  WHERE r.winner IN ('UP', 'DOWN')
`;

const stmt = db.prepare(query);
stmt.step();
const result = stmt.getAsObject();
stmt.free();

console.log(`Rounds with snapshots + complete results: ${result.count}`);

// Break down by snapshot type
const typeQuery = `
  SELECT
    s.snapshot_type,
    COUNT(DISTINCT r.epoch) as count
  FROM rounds r
  JOIN snapshots s ON r.epoch = s.epoch
  WHERE r.winner IN ('UP', 'DOWN')
  GROUP BY s.snapshot_type
  ORDER BY s.snapshot_type
`;

const stmt2 = db.prepare(typeQuery);
console.log('\nBreakdown by snapshot type:');
while (stmt2.step()) {
  const row = stmt2.getAsObject();
  console.log(`  ${row.snapshot_type}: ${row.count} rounds`);
}
stmt2.free();

// Count rounds with complete multi-timeframe data
const completeQuery = `
  SELECT COUNT(DISTINCT epoch) as count
  FROM (
    SELECT r.epoch
    FROM rounds r
    WHERE r.winner IN ('UP', 'DOWN')
    GROUP BY r.epoch
    HAVING
      SUM(CASE WHEN EXISTS(SELECT 1 FROM snapshots s WHERE s.epoch = r.epoch AND s.snapshot_type = 'T_MINUS_25S') THEN 1 ELSE 0 END) > 0
      AND SUM(CASE WHEN EXISTS(SELECT 1 FROM snapshots s WHERE s.epoch = r.epoch AND s.snapshot_type = 'T_MINUS_8S') THEN 1 ELSE 0 END) > 0
      AND SUM(CASE WHEN EXISTS(SELECT 1 FROM snapshots s WHERE s.epoch = r.epoch AND s.snapshot_type = 'T_MINUS_4S') THEN 1 ELSE 0 END) > 0
  )
`;

const stmt3 = db.prepare(completeQuery);
stmt3.step();
const complete = stmt3.getAsObject();
stmt3.free();

console.log(`\nRounds with T-25s + T-8s + T-4s + final result: ${complete.count}`);

db.close();
