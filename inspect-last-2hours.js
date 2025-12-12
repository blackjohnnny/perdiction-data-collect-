import Database from 'better-sqlite3';
const db = new Database('./prediction.db');

const now = Math.floor(Date.now() / 1000);
const twoHoursAgo = now - (2 * 60 * 60);

const rounds = db.prepare(`
  SELECT
    sample_id,
    epoch,
    datetime(lock_timestamp, 'unixepoch') as lock_time,
    lock_price,
    t20s_bull_payout_estimate,
    t20s_bear_payout_estimate,
    winner,
    winner_payout_multiple
  FROM rounds
  WHERE lock_timestamp >= ?
    AND t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
  ORDER BY lock_timestamp DESC
  LIMIT 10
`).all(twoHoursAgo);

console.log('📊 LAST 10 ROUNDS - PAYOUT DATA:\n');

rounds.forEach(r => {
  const bullPayout = r.t20s_bull_payout_estimate;
  const bearPayout = r.t20s_bear_payout_estimate;
  const winner = r.winner;
  const actualPayout = r.winner_payout_multiple;

  console.log(`Epoch ${r.epoch} | ${r.lock_time}`);
  console.log(`  Lock Price: $${r.lock_price}`);
  console.log(`  T-20s Estimates: Bull ${bullPayout ? bullPayout.toFixed(2) + 'x' : 'NULL'} | Bear ${bearPayout ? bearPayout.toFixed(2) + 'x' : 'NULL'}`);
  console.log(`  Winner: ${winner} @ ${actualPayout.toFixed(2)}x\n`);
});

db.close();
