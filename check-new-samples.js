import Database from 'better-sqlite3';
const db = new Database('./prediction.db');

// Check latest samples with timestamps
const latest = db.prepare(`
  SELECT sample_id, epoch,
    datetime(lock_timestamp, 'unixepoch') as lock_time,
    t20s_timestamp IS NOT NULL as has_t20s,
    winner IS NOT NULL as has_winner,
    winner_payout_multiple
  FROM rounds
  ORDER BY sample_id DESC
  LIMIT 20
`).all();

console.log('📊 LAST 20 SAMPLES:\n');
latest.forEach(s => {
  const t20s = s.has_t20s ? '✅' : '❌';
  const winner = s.has_winner ? '✅' : '❌';
  const payout = s.winner_payout_multiple ? s.winner_payout_multiple.toFixed(2) + 'x' : 'N/A';
  console.log(`#${s.sample_id} | Epoch ${s.epoch} | ${s.lock_time} | T20s:${t20s} Winner:${winner} Payout:${payout}`);
});

// Check when data collection started vs now
const first = db.prepare('SELECT MIN(sample_id) as first, MAX(sample_id) as last FROM rounds').get();
const oldestNew = db.prepare(`
  SELECT sample_id, epoch, datetime(lock_timestamp, 'unixepoch') as lock_time
  FROM rounds
  WHERE sample_id > 2078
  ORDER BY sample_id ASC
  LIMIT 1
`).get();

console.log('\n📅 DATA COLLECTION TIMELINE:\n');
console.log(`Total samples in DB: ${first.first} → ${first.last}`);
if (oldestNew) {
  console.log(`First NEW sample after 2078: #${oldestNew.sample_id} at ${oldestNew.lock_time}`);
}

// Count complete vs incomplete
const stats = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN t20s_timestamp IS NOT NULL THEN 1 ELSE 0 END) as with_t20s,
    SUM(CASE WHEN winner IS NOT NULL THEN 1 ELSE 0 END) as with_winner,
    SUM(CASE WHEN t20s_timestamp IS NOT NULL AND winner IS NOT NULL THEN 1 ELSE 0 END) as complete
  FROM rounds
  WHERE sample_id > 2078
`).get();

console.log('\n✅ NEW SAMPLES COMPLETENESS (samples > 2078):\n');
console.log(`Total new samples: ${stats.total}`);
console.log(`With T-20s data: ${stats.with_t20s} (${(stats.with_t20s/stats.total*100).toFixed(1)}%)`);
console.log(`With winner data: ${stats.with_winner} (${(stats.with_winner/stats.total*100).toFixed(1)}%)`);
console.log(`Complete (T20s + winner + payout): ${stats.complete} (${(stats.complete/stats.total*100).toFixed(1)}%)`);

// Check time range of new samples
const timeRange = db.prepare(`
  SELECT
    datetime(MIN(lock_timestamp), 'unixepoch') as earliest,
    datetime(MAX(lock_timestamp), 'unixepoch') as latest
  FROM rounds
  WHERE sample_id > 2078
`).get();

console.log(`\nTime range: ${timeRange.earliest} → ${timeRange.latest}`);

db.close();
