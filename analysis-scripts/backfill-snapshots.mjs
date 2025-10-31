import initSqlJs from 'sql.js';
import fs from 'fs';
import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';

const PREDICTION_CONTRACT = process.env.PREDICTION_CONTRACT || '0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA';
const RPC_URL = process.env.RPC_URL || 'https://bsc-dataseed1.binance.org';

const client = createPublicClient({
  chain: bsc,
  transport: http(RPC_URL, {
    batch: {
      wait: 100,
    },
    retryCount: 5,
    retryDelay: 1000,
  }),
});

const ABI = [
  {
    inputs: [{ internalType: 'uint256', name: 'epoch', type: 'uint256' }],
    name: 'rounds',
    outputs: [
      { internalType: 'uint256', name: 'epoch', type: 'uint256' },
      { internalType: 'uint256', name: 'startTimestamp', type: 'uint256' },
      { internalType: 'uint256', name: 'lockTimestamp', type: 'uint256' },
      { internalType: 'uint256', name: 'closeTimestamp', type: 'uint256' },
      { internalType: 'int256', name: 'lockPrice', type: 'int256' },
      { internalType: 'int256', name: 'closePrice', type: 'int256' },
      { internalType: 'uint256', name: 'lockOracleId', type: 'uint256' },
      { internalType: 'uint256', name: 'closeOracleId', type: 'uint256' },
      { internalType: 'uint256', name: 'totalAmount', type: 'uint256' },
      { internalType: 'uint256', name: 'bullAmount', type: 'uint256' },
      { internalType: 'uint256', name: 'bearAmount', type: 'uint256' },
      { internalType: 'uint256', name: 'rewardBaseCalAmount', type: 'uint256' },
      { internalType: 'uint256', name: 'rewardAmount', type: 'uint256' },
      { internalType: 'bool', name: 'oracleCalled', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

async function getRound(epoch) {
  const result = await client.readContract({
    address: PREDICTION_CONTRACT,
    abi: ABI,
    functionName: 'rounds',
    args: [epoch],
  });

  return {
    epoch: result[0],
    startTimestamp: result[1],
    lockTimestamp: result[2],
    closeTimestamp: result[3],
    lockPrice: result[4],
    closePrice: result[5],
    lockOracleId: result[6],
    closeOracleId: result[7],
    totalAmount: result[8],
    bullAmount: result[9],
    bearAmount: result[10],
    rewardBaseCalAmount: result[11],
    rewardAmount: result[12],
    oracleCalled: result[13],
  };
}

console.log('Loading database...');
const SQL = await initSqlJs();
const dbBuffer = fs.readFileSync('prediction-data.db');
const db = new SQL.Database(dbBuffer);

// Get all unique epochs from snapshots
const snapshotEpochs = db.exec('SELECT DISTINCT epoch FROM snapshots ORDER BY epoch');
const epochs = snapshotEpochs[0].values.map(([epoch]) => Number(epoch));

console.log(`Found ${epochs.length} unique epochs with snapshots`);
console.log(`Range: ${epochs[0]} to ${epochs[epochs.length - 1]}`);

// Check which ones already have round data with winners (not UNKNOWN)
const existingRounds = db.exec(`
  SELECT epoch
  FROM rounds
  WHERE epoch IN (${epochs.join(',')})
  AND winner != 'UNKNOWN'
`);

const existingEpochs = new Set(
  (existingRounds[0]?.values || []).map(([epoch]) => Number(epoch))
);

const epochsToBackfill = epochs.filter(epoch => !existingEpochs.has(epoch));

console.log(`Already have ${existingEpochs.size} rounds with winners`);
console.log(`Need to backfill ${epochsToBackfill.length} rounds`);

if (epochsToBackfill.length === 0) {
  console.log('All snapshots already have winner data!');
  db.close();
  process.exit(0);
}

console.log(`\nBackfilling ${epochsToBackfill.length} rounds...`);

let processed = 0;
let failed = 0;

for (const epoch of epochsToBackfill) {
  try {
    const round = await getRound(BigInt(epoch));

    // Determine winner
    let winner = 'UNKNOWN';
    if (round.closePrice > round.lockPrice) {
      winner = 'UP';
    } else if (round.closePrice < round.lockPrice) {
      winner = 'DOWN';
    } else if (round.closePrice === round.lockPrice) {
      winner = 'DRAW';
    }

    // Calculate winner multiple
    let winnerMultiple = null;
    if (winner === 'UP' && round.bullAmount > 0n) {
      // House takes 3%, so 97% of total pool goes to winners
      const rewardPool = (round.totalAmount * 97n) / 100n;
      winnerMultiple = Number((rewardPool * 1000n) / round.bullAmount) / 1000;
    } else if (winner === 'DOWN' && round.bearAmount > 0n) {
      const rewardPool = (round.totalAmount * 97n) / 100n;
      winnerMultiple = Number((rewardPool * 1000n) / round.bearAmount) / 1000;
    }

    const now = Math.floor(Date.now() / 1000);

    // Insert or update round
    db.run(
      `INSERT OR REPLACE INTO rounds (
        epoch, start_ts, lock_ts, close_ts, lock_price, close_price,
        total_amount_wei, bull_amount_wei, bear_amount_wei,
        oracle_called, reward_base_cal_wei, reward_amount_wei,
        winner, winner_multiple, inserted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(round.epoch),
        Number(round.startTimestamp),
        Number(round.lockTimestamp),
        Number(round.closeTimestamp),
        round.lockPrice.toString(),
        round.closePrice.toString(),
        round.totalAmount.toString(),
        round.bullAmount.toString(),
        round.bearAmount.toString(),
        round.oracleCalled ? 1 : 0,
        round.rewardBaseCalAmount.toString(),
        round.rewardAmount.toString(),
        winner,
        winnerMultiple,
        now,
        now,
      ]
    );

    processed++;

    if (processed % 10 === 0 || processed === epochsToBackfill.length) {
      console.log(`Progress: ${processed}/${epochsToBackfill.length} (${((processed / epochsToBackfill.length) * 100).toFixed(1)}%)`);

      // Save periodically
      fs.writeFileSync('prediction-data.db', Buffer.from(db.export()));
    }
  } catch (error) {
    console.error(`Failed to backfill epoch ${epoch}:`, error.message);
    failed++;
  }
}

// Final save
console.log('\nSaving database...');
fs.writeFileSync('prediction-data.db', Buffer.from(db.export()));
db.close();

console.log(`\n✓ Backfill complete!`);
console.log(`  Processed: ${processed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Success rate: ${((processed / epochsToBackfill.length) * 100).toFixed(1)}%`);
