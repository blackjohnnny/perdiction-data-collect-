import initSqlJs from 'sql.js';
import fs from 'fs';

const SQL = await initSqlJs();
const dbBuffer = fs.readFileSync('prediction-data.db');
const db = new SQL.Database(dbBuffer);

console.log('Snapshot Analysis:\n');

// Count by type
const counts = db.exec(`
  SELECT snapshot_type, COUNT(*) as cnt
  FROM snapshots
  GROUP BY snapshot_type
`);

if (counts[0]) {
  console.log('Snapshot counts by type:');
  counts[0].values.forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });
} else {
  console.log('No snapshots found');
}

// Total snapshots
const total = db.exec(`SELECT COUNT(*) as total FROM snapshots`)[0].values[0][0];
console.log(`  TOTAL: ${total}\n`);

// Unique epochs
const uniqueEpochs = db.exec(`SELECT COUNT(DISTINCT epoch) as cnt FROM snapshots`)[0].values[0][0];
console.log(`Unique epochs with snapshots: ${uniqueEpochs}`);

// Rounds with both snapshots
const bothSnapshots = db.exec(`
  SELECT COUNT(*) as cnt FROM (
    SELECT epoch
    FROM snapshots
    GROUP BY epoch
    HAVING COUNT(DISTINCT snapshot_type) = 2
  )
`);

if (bothSnapshots[0]?.values[0]) {
  console.log(`Rounds with BOTH T-25s AND T-8s: ${bothSnapshots[0].values[0][0]}\n`);
}

// Show recent snapshots
const recent = db.exec(`
  SELECT epoch, snapshot_type,
         CAST(total_amount_wei AS TEXT) as total,
         CAST(bull_amount_wei AS TEXT) as bull,
         CAST(bear_amount_wei AS TEXT) as bear,
         implied_payout_up, implied_payout_down,
         timestamp
  FROM snapshots
  ORDER BY epoch DESC, snapshot_type DESC
  LIMIT 10
`);

if (recent[0]) {
  console.log('Recent snapshots:');
  console.log('Epoch\t\tType\t\t\tImplied Up\tImplied Down');
  recent[0].values.forEach(([epoch, type, total, bull, bear, impliedUp, impliedDown, ts]) => {
    console.log(`${epoch}\t\t${type}\t${impliedUp.toFixed(3)}\t\t${impliedDown.toFixed(3)}`);
  });
}

db.close();
