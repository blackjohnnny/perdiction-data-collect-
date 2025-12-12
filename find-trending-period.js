import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';
const db = initDatabase(DB_PATH);

// Find the 13-loss streak from Dec 1, 2025
const dec1Start = new Date('2025-12-01T00:00:00Z').getTime() / 1000;
const dec1End = new Date('2025-12-01T23:59:59Z').getTime() / 1000;

const rounds = db.prepare(`
  SELECT sample_id, epoch, lock_timestamp
  FROM rounds
  WHERE lock_timestamp >= ? AND lock_timestamp <= ?
  ORDER BY lock_timestamp
`).all(dec1Start, dec1End);

console.log(`Found ${rounds.length} rounds on Dec 1, 2025\n`);
console.log('Sample IDs for testing trending market detection:');
rounds.slice(0, 15).forEach(r => {
  console.log(`  Sample #${r.sample_id} | Epoch ${r.epoch} | ${new Date(r.lock_timestamp * 1000).toISOString()}`);
});

db.close();
