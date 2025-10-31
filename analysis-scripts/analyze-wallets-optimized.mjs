import { createPublicClient, http, parseAbiItem } from 'viem';
import { bsc } from 'viem/chains';
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const PREDICTION_CONTRACT = process.env.PREDICTION_CONTRACT || '0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA';
const BSC_RPC = process.env.BSC_RPC || 'https://bsc-dataseed1.defibit.io';

const client = createPublicClient({
  chain: bsc,
  transport: http(BSC_RPC),
});

// Load database
const SQL = await initSqlJs();
const buffer = readFileSync('../data/live-monitor.db');
const db = new SQL.Database(buffer);

// Cache file to save progress
const CACHE_FILE = './wallet-analysis-cache.json';
let cache = { epochBlocks: {}, walletStats: {} };

if (existsSync(CACHE_FILE)) {
  console.log('Loading cached data...\n');
  cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
}

console.log('=== OPTIMIZED WALLET ANALYSIS ===\n');
console.log('Strategy: Query each epoch in its specific block range only\n');

// Get epochs from database
const stmt = db.prepare(`
  SELECT DISTINCT epoch, winner
  FROM rounds
  WHERE winner IN ('UP', 'DOWN')
  ORDER BY epoch
`);

const epochs = [];
while (stmt.step()) {
  const row = stmt.getAsObject();
  epochs.push({ epoch: row.epoch, winner: row.winner });
}
stmt.free();

console.log(`Found ${epochs.length} rounds with results\n`);

// Step 1: Find block ranges for each epoch (if not cached)
console.log('Step 1: Finding block ranges for each epoch...\n');

const DELAY_MS = 2000; // 2 second delay between requests
let processedCount = 0;

for (const { epoch } of epochs) {
  if (cache.epochBlocks[epoch]) {
    processedCount++;
    continue; // Already have this epoch's block range
  }

  try {
    console.log(`  Finding blocks for epoch ${epoch}...`);

    // Query StartRound event for this epoch to find block range
    const startEvents = await client.getLogs({
      address: PREDICTION_CONTRACT,
      event: parseAbiItem('event StartRound(uint256 indexed epoch)'),
      args: { epoch: BigInt(epoch) },
      fromBlock: BigInt(epoch) * 100n + 30000000n, // Estimate: ~block 30M + epoch*100
      toBlock: BigInt(epoch) * 100n + 40000000n,
    });

    if (startEvents.length > 0) {
      const startBlock = startEvents[0].blockNumber;
      const endBlock = startBlock + 200n; // Each round is ~5 minutes = ~100 blocks

      cache.epochBlocks[epoch] = {
        startBlock: Number(startBlock),
        endBlock: Number(endBlock),
      };

      processedCount++;
      console.log(`    ✓ Epoch ${epoch}: blocks ${startBlock} to ${endBlock}`);

      // Save cache after each success
      writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

      // Delay to avoid rate limit
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    } else {
      console.log(`    ⚠️  No StartRound event found for epoch ${epoch}`);
    }
  } catch (error) {
    console.log(`    ⚠️  Error: ${error.message}`);
    console.log(`    Processed ${processedCount}/${epochs.length} so far. Sleeping 30s...`);
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
}

console.log(`\n✓ Block ranges found for ${Object.keys(cache.epochBlocks).length} epochs\n`);

// Step 2: Query bets for each epoch in its block range
console.log('Step 2: Querying bets for each epoch...\n');

for (const { epoch, winner } of epochs) {
  const blockRange = cache.epochBlocks[epoch];

  if (!blockRange) {
    console.log(`  Skipping epoch ${epoch} (no block range found)`);
    continue;
  }

  // Check if already processed
  if (cache.walletStats[`epoch_${epoch}_processed`]) {
    continue;
  }

  try {
    console.log(`  Fetching bets for epoch ${epoch} (blocks ${blockRange.startBlock}-${blockRange.endBlock})...`);

    // Fetch BetBull events
    const bullEvents = await client.getLogs({
      address: PREDICTION_CONTRACT,
      event: parseAbiItem('event BetBull(address indexed sender, uint256 indexed epoch, uint256 amount)'),
      fromBlock: BigInt(blockRange.startBlock),
      toBlock: BigInt(blockRange.endBlock),
    });

    await new Promise(resolve => setTimeout(resolve, DELAY_MS));

    // Fetch BetBear events
    const bearEvents = await client.getLogs({
      address: PREDICTION_CONTRACT,
      event: parseAbiItem('event BetBear(address indexed sender, uint256 indexed epoch, uint256 amount)'),
      fromBlock: BigInt(blockRange.startBlock),
      toBlock: BigInt(blockRange.endBlock),
    });

    console.log(`    Found ${bullEvents.length} bull bets, ${bearEvents.length} bear bets`);

    // Process bets
    for (const event of bullEvents) {
      const wallet = event.args.sender.toLowerCase();

      if (!cache.walletStats[wallet]) {
        cache.walletStats[wallet] = { wins: 0, losses: 0, totalVolume: '0', bets: [] };
      }

      const won = winner === 'UP';
      if (won) cache.walletStats[wallet].wins++;
      else cache.walletStats[wallet].losses++;

      // Store volume as string to avoid BigInt JSON serialization issues
      const currentVolume = BigInt(cache.walletStats[wallet].totalVolume);
      cache.walletStats[wallet].totalVolume = (currentVolume + event.args.amount).toString();

      cache.walletStats[wallet].bets.push({
        epoch,
        position: 'BULL',
        amount: event.args.amount.toString(),
        won,
      });
    }

    for (const event of bearEvents) {
      const wallet = event.args.sender.toLowerCase();

      if (!cache.walletStats[wallet]) {
        cache.walletStats[wallet] = { wins: 0, losses: 0, totalVolume: '0', bets: [] };
      }

      const won = winner === 'DOWN';
      if (won) cache.walletStats[wallet].wins++;
      else cache.walletStats[wallet].losses++;

      const currentVolume = BigInt(cache.walletStats[wallet].totalVolume);
      cache.walletStats[wallet].totalVolume = (currentVolume + event.args.amount).toString();

      cache.walletStats[wallet].bets.push({
        epoch,
        position: 'BEAR',
        amount: event.args.amount.toString(),
        won,
      });
    }

    // Mark as processed
    cache.walletStats[`epoch_${epoch}_processed`] = true;

    // Save cache
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  } catch (error) {
    console.log(`    ⚠️  Error: ${error.message}`);
    console.log(`    Sleeping 30s before continuing...`);
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
}

// Step 3: Analyze results
console.log('\n=== ANALYSIS RESULTS ===\n');

const wallets = Object.entries(cache.walletStats)
  .filter(([key]) => !key.startsWith('epoch_')) // Filter out metadata
  .map(([wallet, stats]) => ({
    wallet,
    wins: stats.wins,
    losses: stats.losses,
    totalBets: stats.wins + stats.losses,
    winRate: stats.wins + stats.losses > 0 ? (stats.wins / (stats.wins + stats.losses)) * 100 : 0,
    volumeBNB: Number(BigInt(stats.totalVolume)) / 1e18,
  }))
  .filter(w => w.totalBets >= 10) // Min 10 bets
  .sort((a, b) => b.winRate - a.winRate);

console.log(`Total unique wallets: ${wallets.length}\n`);

console.log('=== TOP 20 WALLETS BY WIN RATE (min 10 bets) ===\n');

for (let i = 0; i < Math.min(20, wallets.length); i++) {
  const w = wallets[i];
  console.log(`${i + 1}. ${w.wallet}`);
  console.log(`   Win Rate: ${w.winRate.toFixed(2)}% (${w.wins}W / ${w.losses}L)`);
  console.log(`   Total Bets: ${w.totalBets} | Volume: ${w.volumeBNB.toFixed(4)} BNB`);
  console.log('');
}

// High win rate wallets (≥55%)
const profitable = wallets.filter(w => w.winRate >= 55);

console.log(`\n=== HIGH WIN RATE WALLETS (≥55%, min 10 bets) ===`);
console.log(`Found ${profitable.length} wallets\n`);

for (const w of profitable.slice(0, 20)) {
  console.log(`${w.wallet}`);
  console.log(`  ${w.winRate.toFixed(2)}% (${w.wins}W / ${w.losses}L) | ${w.totalBets} bets | ${w.volumeBNB.toFixed(4)} BNB`);
}

db.close();

console.log('\n✅ Analysis complete!');
console.log(`\nCache saved to: ${CACHE_FILE}`);
console.log('Run script again to continue if interrupted.');
