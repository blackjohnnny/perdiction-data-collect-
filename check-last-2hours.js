import Database from 'better-sqlite3';
const db = new Database('./prediction.db');

// Get current time and 2 hours ago
const now = Math.floor(Date.now() / 1000);
const twoHoursAgo = now - (2 * 60 * 60);

const recentComplete = db.prepare(`
  SELECT
    sample_id,
    epoch,
    datetime(lock_timestamp, 'unixepoch') as lock_time,
    t20s_timestamp IS NOT NULL as has_t20s,
    winner,
    winner_payout_multiple
  FROM rounds
  WHERE lock_timestamp >= ?
    AND t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
  ORDER BY lock_timestamp DESC
`).all(twoHoursAgo);

const recentAll = db.prepare(`
  SELECT COUNT(*) as total
  FROM rounds
  WHERE lock_timestamp >= ?
`).get(twoHoursAgo);

console.log('📊 LAST 2 HOURS DATA COLLECTION:\n');
console.log(`Total samples captured: ${recentAll.total}`);
console.log(`Complete rounds (T20s + winner + payout): ${recentComplete.length}\n`);

if (recentComplete.length > 0) {
  console.log('✅ COMPLETE ROUNDS:\n');
  recentComplete.slice(0, 10).forEach(r => {
    console.log(`#${r.sample_id} | Epoch ${r.epoch} | ${r.lock_time}`);
    console.log(`  Winner: ${r.winner} | Payout: ${r.winner_payout_multiple.toFixed(2)}x\n`);
  });

  if (recentComplete.length > 10) {
    console.log(`... and ${recentComplete.length - 10} more complete rounds\n`);
  }
} else {
  console.log('❌ No complete rounds in last 2 hours\n');
}

db.close();
