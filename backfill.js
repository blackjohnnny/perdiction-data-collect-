import { ethers } from 'ethers';
import {
  initDatabase,
  insertRound,
  updateLockData,
  updateSettlement,
  getIncompleteRounds
} from './db-init.js';
import {
  PREDICTION_CONTRACT_ADDRESS,
  PREDICTION_ABI,
  parseRoundData,
  calculateWinner
} from './contract-abi.js';

// Configuration
const BSC_RPC_URL = 'https://bsc-dataseed1.binance.org';
const DB_PATH = './prediction.db';
const BATCH_SIZE = 50; // Process in batches to avoid rate limits
const DELAY_MS = 200; // Delay between requests

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Backfill historical rounds
 */
async function backfillHistoricalRounds(startEpoch, endEpoch) {
  console.log('🚀 Starting backfill process...\n');

  // Initialize database
  const db = initDatabase(DB_PATH);

  // Connect to BSC via HTTP (more stable for batch requests)
  console.log('🔌 Connecting to BSC RPC...');
  const provider = new ethers.JsonRpcProvider(BSC_RPC_URL);

  const contract = new ethers.Contract(
    PREDICTION_CONTRACT_ADDRESS,
    PREDICTION_ABI,
    provider
  );

  console.log(`✅ Connected to PancakeSwap Prediction V2\n`);

  // Get current epoch if endEpoch not specified
  if (!endEpoch) {
    const currentEpoch = await contract.currentEpoch();
    endEpoch = Number(currentEpoch);
    console.log(`📈 Current epoch: ${endEpoch}\n`);
  }

  const totalRounds = endEpoch - startEpoch + 1;
  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let errors = 0;

  console.log(`📊 Backfilling epochs ${startEpoch} to ${endEpoch} (${totalRounds} rounds)\n`);
  console.log('━'.repeat(60) + '\n');

  for (let epoch = startEpoch; epoch <= endEpoch; epoch++) {
    try {
      // Fetch round data from blockchain
      const roundData = await contract.rounds(epoch);
      const parsed = parseRoundData(roundData);

      // Skip if round hasn't started yet
      if (parsed.startTimestamp === 0) {
        continue;
      }

      // Insert round if not exists
      const wasInserted = insertRound(
        db,
        epoch,
        parsed.lockTimestamp,
        parsed.closeTimestamp
      );

      if (wasInserted) {
        inserted++;
        console.log(`✅ Inserted epoch ${epoch}`);
      }

      // Update lock data if available
      if (BigInt(parsed.bullAmount) > 0n || BigInt(parsed.bearAmount) > 0n) {
        updateLockData(
          db,
          epoch,
          parsed.bullAmount,
          parsed.bearAmount,
          parsed.lockPrice
        );
      }

      // Update settlement if round is complete
      if (parsed.oracleCalled && parsed.closePrice !== '0') {
        const { winner, payoutMultiple } = calculateWinner(
          parsed.lockPrice,
          parsed.closePrice,
          parsed.bullAmount,
          parsed.bearAmount
        );

        updateSettlement(db, epoch, parsed.closePrice, winner, payoutMultiple);
        updated++;

        const lockPrice = Number(parsed.lockPrice) / 1e8;
        const closePrice = Number(parsed.closePrice) / 1e8;
        console.log(`   ├─ Lock: $${lockPrice.toFixed(2)} | Close: $${closePrice.toFixed(2)} | Winner: ${winner.toUpperCase()}`);
      }

      processed++;

      // Progress update
      if (processed % 10 === 0) {
        const progress = ((processed / totalRounds) * 100).toFixed(1);
        console.log(`\n📈 Progress: ${progress}% (${processed}/${totalRounds})\n`);
      }

      // Rate limiting
      await sleep(DELAY_MS);

    } catch (error) {
      console.error(`❌ Error processing epoch ${epoch}:`, error.message);
      errors++;
    }
  }

  console.log('\n' + '━'.repeat(60));
  console.log('🎉 Backfill Complete!\n');
  console.log(`📊 Summary:`);
  console.log(`   Total Processed: ${processed}`);
  console.log(`   New Rounds: ${inserted}`);
  console.log(`   Completed Rounds: ${updated}`);
  console.log(`   Errors: ${errors}`);
  console.log('━'.repeat(60) + '\n');

  db.close();
  provider.destroy();
}

/**
 * Fill incomplete rounds in database
 */
async function fillIncompleteRounds() {
  console.log('🔄 Filling incomplete rounds...\n');

  const db = initDatabase(DB_PATH);
  const provider = new ethers.JsonRpcProvider(BSC_RPC_URL);
  const contract = new ethers.Contract(
    PREDICTION_CONTRACT_ADDRESS,
    PREDICTION_ABI,
    provider
  );

  const incompleteRounds = getIncompleteRounds(db, 1000);

  if (incompleteRounds.length === 0) {
    console.log('✅ No incomplete rounds found!');
    db.close();
    provider.destroy();
    return;
  }

  console.log(`📋 Found ${incompleteRounds.length} incomplete rounds\n`);

  let updated = 0;
  let errors = 0;

  for (const round of incompleteRounds) {
    try {
      const epoch = BigInt(round.epoch);
      const roundData = await contract.rounds(epoch);
      const parsed = parseRoundData(roundData);

      // Update lock data if missing
      if (!round.lock_price && parsed.lockPrice !== '0') {
        updateLockData(
          db,
          epoch,
          parsed.bullAmount,
          parsed.bearAmount,
          parsed.lockPrice
        );
      }

      // Update settlement if complete
      if (parsed.oracleCalled && parsed.closePrice !== '0') {
        const { winner, payoutMultiple } = calculateWinner(
          parsed.lockPrice,
          parsed.closePrice,
          parsed.bullAmount,
          parsed.bearAmount
        );

        updateSettlement(db, epoch, parsed.closePrice, winner, payoutMultiple);
        updated++;

        console.log(`✅ Completed epoch ${epoch} - Winner: ${winner.toUpperCase()}`);
      }

      await sleep(DELAY_MS);

    } catch (error) {
      console.error(`❌ Error processing epoch ${round.epoch}:`, error.message);
      errors++;
    }
  }

  console.log('\n' + '━'.repeat(60));
  console.log(`✅ Updated ${updated} rounds`);
  console.log(`❌ Errors: ${errors}`);
  console.log('━'.repeat(60) + '\n');

  db.close();
  provider.destroy();
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'range') {
    // Backfill specific range: node backfill.js range 50000 50500
    const startEpoch = parseInt(args[1]);
    const endEpoch = parseInt(args[2]);

    if (!startEpoch || !endEpoch) {
      console.error('❌ Usage: node backfill.js range <start_epoch> <end_epoch>');
      process.exit(1);
    }

    await backfillHistoricalRounds(startEpoch, endEpoch);

  } else if (command === 'last') {
    // Backfill last N rounds: node backfill.js last 500
    const count = parseInt(args[1]) || 500;

    const provider = new ethers.JsonRpcProvider(BSC_RPC_URL);
    const contract = new ethers.Contract(
      PREDICTION_CONTRACT_ADDRESS,
      PREDICTION_ABI,
      provider
    );

    const currentEpoch = Number(await contract.currentEpoch());
    const startEpoch = Math.max(1, currentEpoch - count + 1);

    provider.destroy();

    await backfillHistoricalRounds(startEpoch, currentEpoch);

  } else if (command === 'incomplete' || !command) {
    // Fill incomplete rounds (default)
    await fillIncompleteRounds();

  } else {
    console.error('❌ Unknown command:', command);
    console.log('\nUsage:');
    console.log('  node backfill.js                    - Fill incomplete rounds');
    console.log('  node backfill.js incomplete         - Fill incomplete rounds');
    console.log('  node backfill.js last <count>       - Backfill last N rounds');
    console.log('  node backfill.js range <start> <end> - Backfill specific range');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
