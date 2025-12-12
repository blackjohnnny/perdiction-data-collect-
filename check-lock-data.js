import { initDatabase } from './db-init.js';

const db = initDatabase();

const total = db.prepare(`
  SELECT COUNT(*) as c
  FROM rounds
  WHERE lock_bull_wei IS NOT NULL
    AND lock_bear_wei IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
    AND close_price IS NOT NULL
`).get();

console.log('Rounds with ALL required fields:', total.c);

const sample = db.prepare(`
  SELECT epoch, lock_bull_wei, lock_bear_wei, t20s_bull_wei, t20s_bear_wei
  FROM rounds
  WHERE lock_bull_wei IS NOT NULL
  LIMIT 10
`).all();

console.log('\nSample lock vs t20s amounts:\n');
sample.forEach(r => {
  console.log(`Epoch ${r.epoch}:`);
  console.log(`  lock_bull: ${r.lock_bull_wei}`);
  console.log(`  lock_bear: ${r.lock_bear_wei}`);
  console.log(`  t20s_bull: ${r.t20s_bull_wei}`);
  console.log(`  t20s_bear: ${r.t20s_bear_wei}`);
  console.log();
});
