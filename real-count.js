import { initDatabase } from './db-init.js';

const db = initDatabase('./prediction.db');

console.log('\n📊 REAL DATA COUNT (Only T-20s + Winner)\n');
console.log('═'.repeat(60) + '\n');

// Only count rounds with BOTH t20s_timestamp AND winner
const completeRounds = db.prepare(`
  SELECT COUNT(*) as count
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
`).get();

console.log(`Complete rounds (T-20s + Winner): ${completeRounds.count}`);
console.log(`\nThese are the ONLY rounds we can use for analysis.`);
console.log(`Need ${1000 - completeRounds.count} more to reach 1,000 target.\n`);

console.log('═'.repeat(60) + '\n');

// Show a few sample IDs to verify
const samples = db.prepare(`
  SELECT sample_id, epoch, winner, winner_payout_multiple
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
  ORDER BY sample_id DESC
  LIMIT 5
`).all();

console.log('Last 5 complete rounds:\n');
for (const s of samples) {
  console.log(`  Sample ${s.sample_id} | Epoch ${s.epoch} | Winner: ${s.winner.toUpperCase()} | Payout: ${s.winner_payout_multiple}x`);
}

console.log('\n' + '═'.repeat(60) + '\n');

db.close();
