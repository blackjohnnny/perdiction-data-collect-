import { ethers } from 'ethers';
import {
  initDatabase,
  insertRound,
  updateSnapshot,
  updateLockData,
  updateSettlement,
  getSampleCount
} from './db-init.js';
import {
  PREDICTION_CONTRACT_ADDRESS,
  PREDICTION_ABI,
  parseRoundData,
  calculateWinner
} from './contract-abi.js';

// Configuration
const BSC_RPC_URLS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc.publicnode.com',
  'https://binance.llamarpc.com'
];
const DB_PATH = './prediction.db';
const POLL_INTERVAL = 5000; // Poll every 5 seconds (reduced to avoid rate limits)
const SNAPSHOT_TIMES = [20, 8, 4]; // seconds before lock
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds between retries

// Global state
let db;
let provider;
let contract;
let trackedRounds = new Map(); // epoch -> { lockTime, closeTime, snapshots taken }
let lastCheckedEpoch = 0;
let currentRpcIndex = 0;
let failedRpcCount = 0;

/**
 * Switch to next RPC provider
 */
function switchRpcProvider() {
  currentRpcIndex = (currentRpcIndex + 1) % BSC_RPC_URLS.length;
  const newUrl = BSC_RPC_URLS[currentRpcIndex];
  console.log(`🔄 Switching to RPC: ${newUrl}`);

  if (provider) {
    provider.destroy();
  }

  provider = new ethers.JsonRpcProvider(newUrl, null, {
    staticNetwork: true,
    batchMaxCount: 1 // Disable batching to avoid rate limits
  });

  contract = new ethers.Contract(
    PREDICTION_CONTRACT_ADDRESS,
    PREDICTION_ABI,
    provider
  );

  failedRpcCount = 0;
}

/**
 * Retry with exponential backoff
 */
async function retryWithBackoff(fn, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      failedRpcCount++;

      // Switch RPC if too many failures
      if (failedRpcCount >= 5) {
        switchRpcProvider();
      }

      if (i === retries - 1) throw error;

      const delay = RETRY_DELAY * Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Initialize connections
 */
async function initialize() {
  console.log('🚀 Initializing AGGRESSIVE PancakeSwap Monitor...\n');

  // Initialize database
  db = initDatabase(DB_PATH);
  const count = getSampleCount(db);
  console.log(`📊 Current database samples: ${count}\n`);

  // Connect to BSC via HTTP with multiple endpoints
  console.log('🔌 Connecting to BSC RPC...');
  switchRpcProvider();

  console.log(`✅ Connected to PancakeSwap Prediction V2\n`);

  // Get current epoch with retry
  const currentEpoch = await retryWithBackoff(() => contract.currentEpoch());
  lastCheckedEpoch = Number(currentEpoch);
  console.log(`📈 Starting from epoch: ${currentEpoch}\n`);

  return { provider, contract };
}

/**
 * Check if we should capture snapshot based on time remaining
 */
function shouldCaptureSnapshot(lockTime, snapshotSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const timeUntilLock = lockTime - now;

  // Capture if we're within 2 seconds of target time (allows for polling delay)
  return Math.abs(timeUntilLock - snapshotSeconds) <= 2;
}

/**
 * Aggressive polling loop - checks every 5 seconds
 */
async function pollRounds() {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Get current epoch with retry
    const currentEpoch = Number(await retryWithBackoff(() => contract.currentEpoch()));

    // New epoch detected
    if (currentEpoch > lastCheckedEpoch) {
      for (let epoch = lastCheckedEpoch + 1; epoch <= currentEpoch; epoch++) {
        await handleNewRound(epoch);
      }
      lastCheckedEpoch = currentEpoch;
    }

    // Check all tracked rounds for snapshots and completion
    for (const [epoch, roundInfo] of trackedRounds.entries()) {
      const timeUntilLock = roundInfo.lockTime - now;
      const timeUntilClose = roundInfo.closeTime - now;

      // Capture snapshots
      for (const seconds of SNAPSHOT_TIMES) {
        const snapshotKey = `t${seconds}s`;
        if (!roundInfo.snapshots[snapshotKey] && shouldCaptureSnapshot(roundInfo.lockTime, seconds)) {
          await captureSnapshot(epoch, snapshotKey, roundInfo);
          roundInfo.snapshots[snapshotKey] = true;
        }
      }

      // Capture lock data (at lock time)
      if (!roundInfo.locked && timeUntilLock <= 0 && now < roundInfo.closeTime) {
        await captureLockData(epoch, roundInfo);
        roundInfo.locked = true;
      }

      // Capture settlement (after close time)
      if (!roundInfo.settled && timeUntilClose <= 0) {
        await captureSettlement(epoch, roundInfo);
        roundInfo.settled = true;
        trackedRounds.delete(epoch); // Remove completed round
      }
    }

    // Reset failure counter on successful poll
    failedRpcCount = Math.max(0, failedRpcCount - 1);

  } catch (error) {
    console.error('❌ Poll error:', error.message);
  }
}

/**
 * Handle new round discovery
 */
async function handleNewRound(epoch) {
  try {
    console.log(`\n🟢 NEW ROUND DETECTED - Epoch ${epoch}`);

    const roundData = await retryWithBackoff(() => contract.rounds(epoch));
    const parsed = parseRoundData(roundData);

    const lockTimestamp = parsed.lockTimestamp;
    const closeTimestamp = parsed.closeTimestamp;

    // Skip if invalid
    if (lockTimestamp === 0) return;

    // Insert into database
    const inserted = insertRound(db, epoch, lockTimestamp, closeTimestamp);

    if (inserted) {
      const count = getSampleCount(db);
      const lockDate = new Date(lockTimestamp * 1000).toISOString();
      const closeDate = new Date(closeTimestamp * 1000).toISOString();

      console.log(`✅ Sample #${count} - Epoch ${epoch}`);
      console.log(`   Lock:  ${lockDate}`);
      console.log(`   Close: ${closeDate}`);

      // Track this round
      trackedRounds.set(epoch.toString(), {
        lockTime: lockTimestamp,
        closeTime: closeTimestamp,
        snapshots: {},
        locked: false,
        settled: false
      });
    }
  } catch (error) {
    console.error(`❌ Error handling new round ${epoch}:`, error.message);
  }
}

/**
 * Capture snapshot
 */
async function captureSnapshot(epoch, snapshotType, roundInfo) {
  try {
    const roundData = await retryWithBackoff(() => contract.rounds(epoch));
    const parsed = parseRoundData(roundData);

    const timestamp = Math.floor(Date.now() / 1000);
    const bullWei = parsed.bullAmount;
    const bearWei = parsed.bearAmount;

    updateSnapshot(db, epoch, snapshotType, bullWei, bearWei, timestamp);

    const total = BigInt(bullWei) + BigInt(bearWei);
    const bullPct = total > 0n ? Number((BigInt(bullWei) * 10000n) / total) / 100 : 0;
    const bearPct = total > 0n ? Number((BigInt(bearWei) * 10000n) / total) / 100 : 0;

    console.log(`📸 ${snapshotType.toUpperCase()} Epoch ${epoch}: Bull ${bullPct.toFixed(2)}% | Bear ${bearPct.toFixed(2)}% | Total ${ethers.formatEther(total)} BNB`);
  } catch (error) {
    console.error(`❌ Error capturing ${snapshotType} for epoch ${epoch}:`, error.message);
  }
}

/**
 * Capture lock data
 */
async function captureLockData(epoch, roundInfo) {
  try {
    console.log(`\n🔒 LOCK - Epoch ${epoch}`);

    const roundData = await retryWithBackoff(() => contract.rounds(epoch));
    const parsed = parseRoundData(roundData);

    const bullWei = parsed.bullAmount;
    const bearWei = parsed.bearAmount;
    const lockPrice = parsed.lockPrice;

    updateLockData(db, epoch, bullWei, bearWei, lockPrice);

    const total = BigInt(bullWei) + BigInt(bearWei);
    const bullPct = total > 0n ? Number((BigInt(bullWei) * 10000n) / total) / 100 : 0;
    const bearPct = total > 0n ? Number((BigInt(bearWei) * 10000n) / total) / 100 : 0;

    console.log(`   Lock Price: $${(Number(lockPrice) / 1e8).toFixed(2)}`);
    console.log(`   Final Pool: Bull ${bullPct.toFixed(2)}% | Bear ${bearPct.toFixed(2)}% | Total ${ethers.formatEther(total)} BNB`);
  } catch (error) {
    console.error(`❌ Error capturing lock for epoch ${epoch}:`, error.message);
  }
}

/**
 * Capture settlement - determine winner immediately
 */
async function captureSettlement(epoch, roundInfo) {
  try {
    console.log(`\n🏁 SETTLEMENT - Epoch ${epoch}`);

    const roundData = await retryWithBackoff(() => contract.rounds(epoch));
    const parsed = parseRoundData(roundData);

    let closePrice = parsed.closePrice;

    // If oracle hasn't called yet, wait a bit and retry
    if (closePrice === '0') {
      console.log('   ⏳ Waiting for oracle...');
      await new Promise(resolve => setTimeout(resolve, 10000));
      const retryData = await retryWithBackoff(() => contract.rounds(epoch));
      const retryParsed = parseRoundData(retryData);
      closePrice = retryParsed.closePrice;
    }

    const lockPrice = parsed.lockPrice;
    const bullAmount = parsed.bullAmount;
    const bearAmount = parsed.bearAmount;

    // Calculate winner
    const { winner, payoutMultiple } = calculateWinner(
      lockPrice,
      closePrice,
      bullAmount,
      bearAmount
    );

    // Update database
    updateSettlement(db, epoch, closePrice, winner, payoutMultiple);

    console.log(`   Lock: $${(Number(lockPrice) / 1e8).toFixed(2)} | Close: $${(Number(closePrice) / 1e8).toFixed(2)}`);
    console.log(`   Winner: ${winner.toUpperCase()} 🎉 | Payout: ${payoutMultiple.toFixed(4)}x`);
  } catch (error) {
    console.error(`❌ Error capturing settlement for epoch ${epoch}:`, error.message);
  }
}

/**
 * Main execution
 */
async function main() {
  try {
    await initialize();

    console.log('━'.repeat(60));
    console.log('🎯 MONITORING ACTIVE (polling every 5s, multi-RPC, auto-retry)');
    console.log('━'.repeat(60) + '\n');

    // Start aggressive polling
    setInterval(pollRounds, POLL_INTERVAL);

    // Also run immediately
    pollRounds();

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down...');
  if (db) db.close();
  if (provider) provider.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n🛑 Shutting down...');
  if (db) db.close();
  if (provider) provider.destroy();
  process.exit(0);
});

// Start monitoring
main();
