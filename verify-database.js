import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🔍 DATABASE VERIFICATION REPORT\n');
console.log('═'.repeat(80) + '\n');

const db = initDatabase(DB_PATH);

// 1. Show schema
console.log('📋 SCHEMA:\n');
const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rounds'").get();
console.log(schema.sql);
console.log('\n' + '─'.repeat(80) + '\n');

// 2. Field existence check
console.log('✅ REQUIRED FIELDS CHECK:\n');
const requiredFields = [
  'sample_id',
  't20s_bull_wei',
  't20s_bear_wei',
  't20s_timestamp',
  't8s_bull_wei',
  't8s_bear_wei',
  't8s_timestamp',
  't4s_bull_wei',
  't4s_bear_wei',
  't4s_timestamp',
  'lock_bull_wei',
  'lock_bear_wei',
  'lock_price',
  'close_price',
  'winner',
  'winner_payout_multiple'
];

const columns = db.prepare("PRAGMA table_info(rounds)").all();
const columnNames = columns.map(c => c.name);

for (const field of requiredFields) {
  const exists = columnNames.includes(field);
  console.log(`  ${exists ? '✅' : '❌'} ${field}`);
}

console.log('\n' + '─'.repeat(80) + '\n');

// 3. Data completeness
console.log('📊 DATA COMPLETENESS:\n');

const totalRounds = db.prepare('SELECT COUNT(*) as count FROM rounds').get().count;
const withT20s = db.prepare('SELECT COUNT(*) as count FROM rounds WHERE t20s_timestamp IS NOT NULL').get().count;
const withT8s = db.prepare('SELECT COUNT(*) as count FROM rounds WHERE t8s_timestamp IS NOT NULL').get().count;
const withT4s = db.prepare('SELECT COUNT(*) as count FROM rounds WHERE t4s_timestamp IS NOT NULL').get().count;
const withLock = db.prepare('SELECT COUNT(*) as count FROM rounds WHERE lock_bull_wei IS NOT NULL').get().count;
const withWinner = db.prepare('SELECT COUNT(*) as count FROM rounds WHERE winner IS NOT NULL').get().count;
const complete = db.prepare('SELECT COUNT(*) as count FROM rounds WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL').get().count;

console.log(`  Total rounds:       ${totalRounds}`);
console.log(`  With T-20s data:    ${withT20s} (${(withT20s/totalRounds*100).toFixed(1)}%)`);
console.log(`  With T-8s data:     ${withT8s} (${(withT8s/totalRounds*100).toFixed(1)}%)`);
console.log(`  With T-4s data:     ${withT4s} (${(withT4s/totalRounds*100).toFixed(1)}%)`);
console.log(`  With lock data:     ${withLock} (${(withLock/totalRounds*100).toFixed(1)}%)`);
console.log(`  With winner:        ${withWinner} (${(withWinner/totalRounds*100).toFixed(1)}%)`);
console.log(`  Complete (T20s+Win): ${complete} (${(complete/totalRounds*100).toFixed(1)}%)`);

console.log('\n' + '─'.repeat(80) + '\n');

// 4. Sample records
console.log('📝 SAMPLE RECORDS (Last 3 complete rounds):\n');

const samples = db.prepare(`
  SELECT
    sample_id,
    epoch,
    lock_timestamp,
    t20s_bull_wei,
    t20s_bear_wei,
    lock_bull_wei,
    lock_bear_wei,
    winner,
    winner_payout_multiple
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL
  ORDER BY sample_id DESC
  LIMIT 3
`).all();

for (const s of samples) {
  const t20sBull = parseFloat(s.t20s_bull_wei) / 1e18;
  const t20sBear = parseFloat(s.t20s_bear_wei) / 1e18;
  const t20sTotal = t20sBull + t20sBear;
  const t20sBullPct = t20sTotal > 0 ? (t20sBull / t20sTotal * 100).toFixed(2) : 0;

  const lockBull = parseFloat(s.lock_bull_wei) / 1e18;
  const lockBear = parseFloat(s.lock_bear_wei) / 1e18;
  const lockTotal = lockBull + lockBear;
  const lockBullPct = lockTotal > 0 ? (lockBull / lockTotal * 100).toFixed(2) : 0;

  console.log(`  Sample ${s.sample_id} (Epoch ${s.epoch}):`);
  console.log(`    T-20s: ${t20sBullPct}% Bull | ${(100-t20sBullPct).toFixed(2)}% Bear | Total: ${t20sTotal.toFixed(4)} BNB`);
  console.log(`    Lock:  ${lockBullPct}% Bull | ${(100-lockBullPct).toFixed(2)}% Bear | Total: ${lockTotal.toFixed(4)} BNB`);
  console.log(`    Winner: ${s.winner.toUpperCase()} | Payout: ${s.winner_payout_multiple}x`);
  console.log('');
}

console.log('─'.repeat(80) + '\n');

// 5. Check for duplicates or anomalies
console.log('🔎 DATA INTEGRITY CHECKS:\n');

const duplicateEpochs = db.prepare(`
  SELECT epoch, COUNT(*) as count
  FROM rounds
  GROUP BY epoch
  HAVING count > 1
`).all();

if (duplicateEpochs.length > 0) {
  console.log(`  ⚠️  Found ${duplicateEpochs.length} duplicate epochs!`);
  console.log('  First 5:', duplicateEpochs.slice(0, 5).map(d => `Epoch ${d.epoch} (${d.count}x)`).join(', '));
} else {
  console.log('  ✅ No duplicate epochs found');
}

const nullWinnerButComplete = db.prepare(`
  SELECT COUNT(*) as count
  FROM rounds
  WHERE is_complete = 1 AND winner IS NULL
`).get().count;

if (nullWinnerButComplete > 0) {
  console.log(`  ⚠️  ${nullWinnerButComplete} rounds marked complete but missing winner`);
} else {
  console.log('  ✅ No complete rounds missing winner data');
}

const invalidPayouts = db.prepare(`
  SELECT COUNT(*) as count
  FROM rounds
  WHERE winner IS NOT NULL AND (winner_payout_multiple < 1.0 OR winner_payout_multiple > 10.0)
`).get().count;

if (invalidPayouts > 0) {
  console.log(`  ⚠️  ${invalidPayouts} rounds have suspicious payout values (<1.0 or >10.0)`);
} else {
  console.log('  ✅ All payout multiples are within expected range');
}

console.log('\n' + '═'.repeat(80) + '\n');

// 6. Recent collection rate
console.log('📈 COLLECTION RATE (Last 100 rounds):\n');

const recent100 = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN t20s_timestamp IS NOT NULL THEN 1 ELSE 0 END) as with_t20s,
    SUM(CASE WHEN winner IS NOT NULL THEN 1 ELSE 0 END) as with_winner
  FROM rounds
  ORDER BY sample_id DESC
  LIMIT 100
`).get();

console.log(`  Last 100 rounds:`);
console.log(`    T-20s captured: ${recent100.with_t20s}/100 (${recent100.with_t20s}%)`);
console.log(`    Winners captured: ${recent100.with_winner}/100 (${recent100.with_winner}%)`);

if (recent100.with_t20s < 90) {
  console.log(`  ⚠️  T-20s capture rate below 90% - monitor may have timing issues`);
} else {
  console.log(`  ✅ Good T-20s capture rate`);
}

console.log('\n' + '═'.repeat(80) + '\n');

console.log('✅ VERIFICATION COMPLETE\n');

db.close();
