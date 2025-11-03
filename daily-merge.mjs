import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'fs';

/**
 * DAILY MERGE SCRIPT
 *
 * PURPOSE: Merge NEW rounds from live-monitor.db to live.db
 *
 * RULES:
 * 1. ONLY merge rounds that have T-20s snapshot data (t20s_total_wei != 0)
 * 2. ONLY merge rounds that have settled (winner != UNKNOWN)
 * 3. ONLY merge rounds newer than what's already in live.db
 *
 * Run this daily to keep live.db updated with clean, usable data.
 */

console.log('═══════════════════════════════════════════════════════════');
console.log('DAILY MERGE: live-monitor.db → live.db');
console.log('═══════════════════════════════════════════════════════════\n');

const SQL = await initSqlJs();

// Open both databases
const monitorBuf = readFileSync('./data/live-monitor.db');
const monitorDb = new SQL.Database(monitorBuf);

const liveBuf = readFileSync('./data/live.db');
const liveDb = new SQL.Database(liveBuf);

// Get latest epoch in live.db
const latestResult = liveDb.exec('SELECT MAX(epoch) as max FROM rounds');
const lastEpoch = latestResult[0].values[0][0];
console.log(`Latest epoch in live.db: ${lastEpoch}\n`);

// Get NEW rounds from live-monitor.db that:
// - Are newer than lastEpoch
// - Have T-20s data (NOT NULL and NOT '0')
// - Have settled (winner != 'UNKNOWN')
const newRoundsResult = monitorDb.exec(`
  SELECT
    epoch, lock_ts, close_ts, lock_price, close_price,
    winner, winner_multiple,
    t20s_bull_wei, t20s_bear_wei, t20s_total_wei,
    bull_amount_wei, bear_amount_wei, total_amount_wei
  FROM rounds
  WHERE epoch > ${lastEpoch}
    AND t20s_total_wei IS NOT NULL
    AND t20s_total_wei != '0'
    AND winner != 'UNKNOWN'
  ORDER BY epoch ASC
`);

const newRounds = newRoundsResult[0]?.values || [];

console.log(`Found ${newRounds.length} NEW rounds with T-20s data and settlement\n`);

if (newRounds.length === 0) {
  console.log('✅ No new rounds to merge. live.db is up to date.');
  monitorDb.close();
  liveDb.close();
  process.exit(0);
}

// Insert new rounds
console.log('Merging new rounds into live.db...');
let inserted = 0;

for (const row of newRounds) {
  try {
    liveDb.run(`
      INSERT OR REPLACE INTO rounds (
        epoch, lock_ts, close_ts, lock_price, close_price,
        winner, winner_multiple,
        t20s_bull_wei, t20s_bear_wei, t20s_total_wei,
        bull_amount_wei, bear_amount_wei, total_amount_wei
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, row);
    inserted++;
  } catch (err) {
    console.error(`Error inserting epoch ${row[0]}:`, err.message);
  }
}

console.log(`✅ Inserted ${inserted} new rounds\n`);

// Save updated live.db
const data = liveDb.export();
writeFileSync('./data/live.db', data);

// Final verification
const newTotal = liveDb.exec('SELECT COUNT(*) FROM rounds')[0].values[0][0];
const newLatest = liveDb.exec('SELECT MAX(epoch) FROM rounds')[0].values[0][0];
const newWithT20s = liveDb.exec('SELECT COUNT(*) FROM rounds WHERE t20s_total_wei != "0"')[0].values[0][0];

console.log('═══════════════════════════════════════════════════════════');
console.log('FINAL STATUS');
console.log('═══════════════════════════════════════════════════════════\n');
console.log(`Total rounds in live.db: ${newTotal}`);
console.log(`Latest epoch: ${newLatest}`);
console.log(`All rounds have T-20s: ${newWithT20s === newTotal ? '✅ YES' : '❌ NO'}\n`);

// Show sample
console.log('Sample of newly added rounds:');
const samples = liveDb.exec(`
  SELECT epoch, winner, t20s_bull_wei, t20s_bear_wei, t20s_total_wei
  FROM rounds
  WHERE epoch > ${lastEpoch}
  ORDER BY epoch ASC
  LIMIT 5
`);

if (samples[0]) {
  samples[0].values.forEach(s => {
    const bullPct = (BigInt(s[2]) * 100n / BigInt(s[4])).toString();
    console.log(`  Epoch ${s[0]}: Winner=${s[1]}, Bull=${bullPct}%`);
  });
}

monitorDb.close();
liveDb.close();

console.log('\n✅ Daily merge complete!');
console.log('\nREMEMBER: live.db ONLY contains rounds with T-20s data.');
console.log('Run this script daily to keep it updated.\n');
