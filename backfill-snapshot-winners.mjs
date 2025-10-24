import initSqlJs from 'sql.js';
import fs from 'fs';
import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';

const predictionAbi = JSON.parse(fs.readFileSync('./src/abi/prediction.json', 'utf-8'));

const PREDICTION_CONTRACT = '0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA';

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-dataseed1.binance.org'),
});

const SQL = await initSqlJs();
const dbBuffer = fs.readFileSync('prediction-data.db');
const db = new SQL.Database(dbBuffer);

// Get epochs from snapshots that don't have winners yet
const snapshotEpochs = db.exec(`
  SELECT DISTINCT s.epoch
  FROM snapshots s
  LEFT JOIN rounds r ON s.epoch = r.epoch
  WHERE r.winner IS NULL OR r.winner = 'PENDING'
  ORDER BY s.epoch ASC
`);

if (!snapshotEpochs[0] || snapshotEpochs[0].values.length === 0) {
  console.log('All snapshot epochs already have winners!');
  db.close();
  process.exit(0);
}

const epochs = snapshotEpochs[0].values.map(([epoch]) => Number(epoch));
console.log(`Found ${epochs.length} epochs needing winners: ${epochs[0]} to ${epochs[epochs.length - 1]}`);

let updated = 0;
let failed = 0;

for (const epoch of epochs) {
  try {
    const round = await client.readContract({
      address: PREDICTION_CONTRACT,
      abi: predictionAbi,
      functionName: 'rounds',
      args: [BigInt(epoch)],
    });

    const lockPrice = round.lockPrice;
    const closePrice = round.closePrice;

    if (closePrice === 0n) {
      console.log(`Epoch ${epoch}: Not finished yet (closePrice = 0)`);
      continue;
    }

    const winner = closePrice > lockPrice ? 'UP' : closePrice < lockPrice ? 'DOWN' : 'DRAW';

    // Update or insert the round
    db.run(`
      INSERT INTO rounds (epoch, total_amount_wei, bull_amount_wei, bear_amount_wei, winner, lock_timestamp, close_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(epoch) DO UPDATE SET winner = excluded.winner
    `, [
      epoch,
      round.totalAmount.toString(),
      round.bullAmount.toString(),
      round.bearAmount.toString(),
      winner,
      Number(round.lockTimestamp),
      Number(round.closeTimestamp),
    ]);

    updated++;
    console.log(`✓ Epoch ${epoch}: ${winner}`);

  } catch (error) {
    console.error(`✗ Epoch ${epoch}: ${error.message}`);
    failed++;
  }
}

// Save database
fs.writeFileSync('prediction-data.db', Buffer.from(db.export()));
db.close();

console.log(`\n✅ Updated ${updated} rounds, ${failed} failed`);
