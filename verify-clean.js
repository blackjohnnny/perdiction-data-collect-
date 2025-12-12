import { initDatabase } from './db-init.js';

const db = initDatabase('./prediction.db');

console.log('\n🔍 FINAL DATABASE VERIFICATION\n');
console.log('═'.repeat(60) + '\n');

// Total count
const total = db.prepare('SELECT COUNT(*) as count FROM rounds').get();

// Complete rounds
const complete = db.prepare(`
  SELECT COUNT(*) as count
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL
`).get();

// Incomplete rounds (should be 0)
const incomplete = db.prepare(`
  SELECT COUNT(*) as count
  FROM rounds
  WHERE t20s_timestamp IS NULL OR winner IS NULL
`).get();

console.log(`📊 DATABASE STATUS:`);
console.log(`  Total rounds: ${total.count}`);
console.log(`  Complete rounds (T-20s + Winner): ${complete.count}`);
console.log(`  Incomplete rounds: ${incomplete.count}`);
console.log('');

if (incomplete.count === 0 && total.count === complete.count) {
  console.log('✅ PERFECT! Database contains ONLY complete rounds.\n');
} else {
  console.log('⚠️  WARNING: Database still has incomplete rounds!\n');
}

console.log('─'.repeat(60) + '\n');

// Sample verification
const samples = db.prepare(`
  SELECT
    sample_id,
    epoch,
    t20s_timestamp,
    lock_bull_wei,
    lock_bear_wei,
    winner,
    winner_payout_multiple
  FROM rounds
  ORDER BY sample_id DESC
  LIMIT 3
`).all();

console.log('📝 SAMPLE RECORDS (Last 3):\n');
for (const s of samples) {
  const hasT20s = s.t20s_timestamp ? '✅' : '❌';
  const hasLock = s.lock_bull_wei ? '✅' : '❌';
  const hasWinner = s.winner ? '✅' : '❌';

  console.log(`  Sample ${s.sample_id} | Epoch ${s.epoch}`);
  console.log(`    ${hasT20s} T-20s data | ${hasLock} Lock data | ${hasWinner} Winner: ${s.winner?.toUpperCase() || 'N/A'}`);
  console.log('');
}

console.log('═'.repeat(60) + '\n');

db.close();
