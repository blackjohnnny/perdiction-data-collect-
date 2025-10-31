const sqlite3 = require('sql.js');
const fs = require('fs');

(async () => {
  const SQL = await sqlite3();
  const db = new SQL.Database(fs.readFileSync('prediction-v2.db'));

  // Check date range
  const range = db.exec("SELECT MIN(lock_ts), MAX(lock_ts) FROM rounds WHERE lock_ts IS NOT NULL");
  const minTs = range[0].values[0][0];
  const maxTs = range[0].values[0][1];

  console.log('Database date range:');
  console.log('  Min:', new Date(minTs * 1000).toISOString());
  console.log('  Max:', new Date(maxTs * 1000).toISOString());

  // Check for Oct 20-21
  const oct20Start = Math.floor(new Date('2024-10-20T07:40:00Z').getTime() / 1000);
  const oct20End = Math.floor(new Date('2024-10-20T18:55:00Z').getTime() / 1000);
  const oct21Start = Math.floor(new Date('2024-10-21T16:50:00Z').getTime() / 1000);
  const oct21End = Math.floor(new Date('2024-10-22T01:40:00Z').getTime() / 1000);

  console.log('\nSearching for rounds:');
  console.log('  Oct 20 range:', oct20Start, '-', oct20End);
  console.log('  Oct 21 range:', oct21Start, '-', oct21End);

  const result = db.exec(`
    SELECT epoch, lock_ts, datetime(lock_ts, 'unixepoch') as lock_time
    FROM rounds
    WHERE (lock_ts >= ${oct20Start} AND lock_ts <= ${oct20End})
       OR (lock_ts >= ${oct21Start} AND lock_ts <= ${oct21End})
    ORDER BY epoch ASC
    LIMIT 5
  `);

  if (result.length > 0 && result[0].values.length > 0) {
    console.log('\nFound rounds:');
    result[0].values.forEach(r => {
      console.log(`  Epoch ${r[0]}: ${r[2]} (ts: ${r[1]})`);
    });
  } else {
    console.log('\nNo rounds found in those timeframes');
  }
})();
