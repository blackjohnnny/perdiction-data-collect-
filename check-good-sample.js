import Database from 'better-sqlite3';
const db = new Database('./prediction.db');

// Get a sample from the historical "good" data (Nov 18-19)
const goodSample = db.prepare(`
  SELECT *
  FROM rounds
  WHERE sample_id BETWEEN 2000 AND 2010
  LIMIT 5
`).all();

console.log('📊 GOOD HISTORICAL SAMPLES (Nov 18-19):\n');

goodSample.forEach(r => {
  console.log(`Sample #${r.sample_id} | Epoch ${r.epoch}`);
  console.log(`  Lock Price: ${r.lock_price}`);
  console.log(`  T20s Bull Wei: ${r.t20s_bull_wei}`);
  console.log(`  T20s Bear Wei: ${r.t20s_bear_wei}`);
  console.log(`  T20s Total Wei: ${r.t20s_total_wei}`);
  console.log(`  Winner: ${r.winner} @ ${r.winner_payout_multiple}x\n`);
});

// Get recent samples
const recentSamples = db.prepare(`
  SELECT *
  FROM rounds
  WHERE sample_id > 21300
  LIMIT 5
`).all();

console.log('\n📊 RECENT SAMPLES (Last 2 hours):\n');

recentSamples.forEach(r => {
  console.log(`Sample #${r.sample_id} | Epoch ${r.epoch}`);
  console.log(`  Lock Price: ${r.lock_price}`);
  console.log(`  T20s Bull Wei: ${r.t20s_bull_wei}`);
  console.log(`  T20s Bear Wei: ${r.t20s_bear_wei}`);
  console.log(`  T20s Total Wei: ${r.t20s_total_wei}`);
  console.log(`  Winner: ${r.winner} @ ${r.winner_payout_multiple}x\n`);
});

db.close();
