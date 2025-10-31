// Quick script to backfill BTC/USD prediction data (last 30 days)
import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';
import sqlite3 from 'sql.js';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { readFileSync as readJsonFile } from 'fs';
const predictionAbi = JSON.parse(readJsonFile('./dist/abi/prediction.json', 'utf8'));

const BTC_CONTRACT = '0x48781a7d35f6137a9135Bbb984AF65fd6AB25618';
const DB_PATH = './prediction-data-btc.db';
const START_EPOCH = 4238; // ~30 days ago
const END_EPOCH = 12878; // Current

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc.publicnode.com', { timeout: 30000, retryCount: 3 }),
});

console.log('🚀 Backfilling BTC/USD Prediction Data');
console.log(`   Epochs: ${START_EPOCH} → ${END_EPOCH} (${END_EPOCH - START_EPOCH} rounds)`);
console.log(`   Database: ${DB_PATH}\n`);

const SQL = await sqlite3();
let db;

if (existsSync(DB_PATH)) {
  db = new SQL.Database(readFileSync(DB_PATH));
} else {
  db = new SQL.Database();
  // Create schema
  db.exec(`
    CREATE TABLE rounds (
      epoch INTEGER PRIMARY KEY,
      start_ts INTEGER NOT NULL,
      lock_ts INTEGER NOT NULL,
      close_ts INTEGER NOT NULL,
      lock_price TEXT NOT NULL,
      close_price TEXT NOT NULL,
      total_amount_wei TEXT NOT NULL,
      bull_amount_wei TEXT NOT NULL,
      bear_amount_wei TEXT NOT NULL,
      oracle_called INTEGER NOT NULL,
      reward_base_cal_wei TEXT NOT NULL,
      reward_amount_wei TEXT NOT NULL,
      winner TEXT NOT NULL CHECK(winner IN ('UP','DOWN','DRAW','UNKNOWN')),
      winner_multiple REAL,
      inserted_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_rounds_winner ON rounds(winner);
    CREATE INDEX idx_rounds_lock_ts ON rounds(lock_ts);
  `);
}

let completed = 0;
const batchSize = 10;

for (let epoch = START_EPOCH; epoch <= END_EPOCH; epoch += batchSize) {
  const batch = [];
  for (let i = 0; i < batchSize && epoch + i <= END_EPOCH; i++) {
    batch.push(epoch + i);
  }

  const promises = batch.map(async (e) => {
    const round = await client.readContract({
      address: BTC_CONTRACT,
      abi: predictionAbi,
      functionName: 'rounds',
      args: [BigInt(e)],
    });

    const lockPrice = BigInt(round[4] || 0);
    const closePrice = BigInt(round[5] || 0);
    let winner = 'UNKNOWN';
    let winnerMultiple = null;

    if (round[9]) {  // oracleCalled
      if (closePrice > lockPrice) {
        winner = 'UP';
        winnerMultiple = round[8] > 0 ? Number(round[8]) / Number(round[10]) : null;
      } else if (closePrice < lockPrice) {
        winner = 'DOWN';
        winnerMultiple = round[8] > 0 ? Number(round[8]) / Number(round[9]) : null;
      } else {
        winner = 'DRAW';
      }
    }

    const now = Math.floor(Date.now() / 1000);
    db.run(`
      INSERT OR REPLACE INTO rounds VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      e,
      Number(round[0]), Number(round[1]), Number(round[2]),
      round[4].toString(), round[5].toString(),
      round[8].toString(), round[9].toString(), round[10].toString(),
      round[12] ? 1 : 0,
      round[11].toString(), round[12].toString(),
      winner, winnerMultiple,
      now, now
    ]);

    return e;
  });

  await Promise.all(promises);
  completed += batch.length;

  if (completed % 100 === 0) {
    console.log(`Progress: ${completed}/${END_EPOCH - START_EPOCH + 1} (${((completed / (END_EPOCH - START_EPOCH + 1)) * 100).toFixed(1)}%)`);
    // Save periodically
    const data = db.export();
    writeFileSync(DB_PATH, Buffer.from(data));
  }
}

// Final save
const data = db.export();
writeFileSync(DB_PATH, Buffer.from(data));

console.log(`\n✅ BTC/USD backfill complete! ${completed} rounds saved to ${DB_PATH}`);
