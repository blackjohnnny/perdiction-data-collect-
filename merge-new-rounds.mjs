import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'fs';

console.log('═══════════════════════════════════════════════════════════');
console.log('MERGING NEW ROUNDS FROM live-monitor.db TO live.db');
console.log('═══════════════════════════════════════════════════════════\n');

const SQL = await initSqlJs();

// Open both databases
const monitorBuf = readFileSync('./data/live-monitor.db');
const monitorDb = new SQL.Database(monitorBuf);

const liveBuf = readFileSync('./data/live.db');
const liveDb = new SQL.Database(liveBuf);

// Get the latest epoch in live.db
const latestResult = liveDb.exec('SELECT MAX(epoch) as max FROM rounds');
const lastEpoch = latestResult[0].values[0][0];
console.log(`Latest epoch in live.db: ${lastEpoch}`);

// Get new rounds from live-monitor.db
const newRoundsResult = monitorDb.exec(`
  SELECT
    epoch, start_ts, lock_ts, close_ts, lock_price, close_price,
    total_amount_wei, bull_amount_wei, bear_amount_wei,
    oracle_called, reward_base_cal_wei, reward_amount_wei,
    winner, winner_multiple,
    t20s_total_wei, t20s_bull_wei, t20s_bear_wei,
    t20s_implied_up_multiple, t20s_implied_down_multiple, t20s_taken_at,
    t8s_total_wei, t8s_bull_wei, t8s_bear_wei,
    t8s_implied_up_multiple, t8s_implied_down_multiple, t8s_taken_at,
    t4s_total_wei, t4s_bull_wei, t4s_bear_wei,
    t4s_implied_up_multiple, t4s_implied_down_multiple, t4s_taken_at
  FROM rounds
  WHERE epoch > ${lastEpoch}
  ORDER BY epoch ASC
`);

const newRounds = newRoundsResult[0]?.values || [];
console.log(`Found ${newRounds.length} new rounds to merge (epoch ${lastEpoch + 1} and above)\n`);

if (newRounds.length === 0) {
  console.log('No new rounds to merge. Exiting.');
  monitorDb.close();
  liveDb.close();
  process.exit(0);
}

// Filter for rounds that have valid data
const validRounds = newRounds.filter(row => {
  const winner = row[12]; // winner column
  const totalWei = row[6]; // total_amount_wei column
  return winner !== 'UNKNOWN' && totalWei !== '0';
});

console.log(`Valid settled rounds with pool data: ${validRounds.length}`);

// Count rounds with T-20s data
const withT20s = validRounds.filter(row => {
  const t20sTotal = row[14]; // t20s_total_wei column
  return t20sTotal && t20sTotal !== '0' && t20sTotal !== null;
}).length;

console.log(`Rounds with T-20s snapshots: ${withT20s}\n`);

// Insert rounds one by one
console.log('Merging valid rounds into live.db...');
let inserted = 0;

for (const row of validRounds) {
  try {
    liveDb.run(`
      INSERT OR REPLACE INTO rounds (
        epoch, lock_ts, close_ts, lock_price, close_price,
        winner, winner_multiple,
        t20s_bull_wei, t20s_bear_wei, t20s_total_wei,
        bull_amount_wei, bear_amount_wei, total_amount_wei
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row[0],  // epoch
      row[2],  // lock_ts
      row[3],  // close_ts
      row[4],  // lock_price
      row[5],  // close_price
      row[12], // winner
      row[13], // winner_multiple
      row[15] || '0', // t20s_bull_wei
      row[16] || '0', // t20s_bear_wei
      row[14] || '0', // t20s_total_wei
      row[7],  // bull_amount_wei
      row[8],  // bear_amount_wei
      row[6]   // total_amount_wei
    ]);
    inserted++;
  } catch (err) {
    console.error(`Error inserting epoch ${row[0]}:`, err.message);
  }
}

console.log(`\n✅ Successfully inserted ${inserted} new rounds into live.db\n`);

// Save the updated live.db
const data = liveDb.export();
writeFileSync('./data/live.db', data);

// Verify the merge
const newTotalResult = liveDb.exec('SELECT COUNT(*) as count FROM rounds');
const newTotal = newTotalResult[0].values[0][0];

const newLatestResult = liveDb.exec('SELECT MAX(epoch) as max FROM rounds');
const newLatest = newLatestResult[0].values[0][0];

const newWithT20sResult = liveDb.exec('SELECT COUNT(*) as count FROM rounds WHERE t20s_total_wei != "0"');
const newWithT20sCount = newWithT20sResult[0].values[0][0];

console.log('═══════════════════════════════════════════════════════════');
console.log('VERIFICATION');
console.log('═══════════════════════════════════════════════════════════\n');
console.log(`Total rounds in live.db: ${newTotal} (was 820)`);
console.log(`Latest epoch: ${newLatest} (was ${lastEpoch})`);
console.log(`Rounds with T-20s: ${newWithT20sCount} (was 820)`);
console.log(`New rounds added: ${newTotal - 820}`);
console.log(`New T-20s snapshots: ${newWithT20sCount - 820}\n`);

// Show sample of new rounds
console.log('Sample of new rounds:');
const samplesResult = liveDb.exec(`
  SELECT epoch, winner, t20s_bull_wei, t20s_bear_wei, t20s_total_wei
  FROM rounds
  WHERE epoch > ${lastEpoch}
  ORDER BY epoch ASC
  LIMIT 5
`);

if (samplesResult[0]) {
  samplesResult[0].values.forEach(s => {
    const hasT20s = s[4] !== '0';
    const bullPct = hasT20s ? (BigInt(s[2]) * 100n / BigInt(s[4])).toString() : 'N/A';
    console.log(`  Epoch ${s[0]}: Winner=${s[1]}, T-20s Bull=${bullPct}%, Has Snapshot=${hasT20s}`);
  });
}

monitorDb.close();
liveDb.close();

console.log('\n✅ Merge complete!');
