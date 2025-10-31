import { createPublicClient, http, parseAbiItem } from 'viem';
import { bsc } from 'viem/chains';
import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const PREDICTION_CONTRACT = process.env.PREDICTION_CONTRACT || '0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA';
const BSC_RPC = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';

const client = createPublicClient({
  chain: bsc,
  transport: http(BSC_RPC),
});

// Load database to get round results
const SQL = await initSqlJs();
const buffer = readFileSync('../data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('Scanning blockchain for whale bettors...\n');
console.log('This will take a few minutes as we query event logs...\n');

// Get latest block
const latestBlock = await client.getBlockNumber();
console.log(`Latest block: ${latestBlock}\n`);

// Query last ~1 day of activity (assuming 3 second blocks = ~28.8k blocks per day)
// Using smaller range to avoid RPC rate limits
const blockRange = 25000n;
const fromBlock = latestBlock - blockRange;
const toBlock = latestBlock;

console.log(`Scanning blocks ${fromBlock} to ${toBlock} (~1 day)...\n`);

// Fetch BetBull events in chunks to avoid rate limits
console.log('Fetching BetBull events...');
const chunkSize = 5000n;
const bullEvents = [];

for (let start = fromBlock; start < toBlock; start += chunkSize) {
  const end = start + chunkSize > toBlock ? toBlock : start + chunkSize;
  console.log(`  Blocks ${start} to ${end}...`);

  const events = await client.getLogs({
    address: PREDICTION_CONTRACT,
    event: parseAbiItem('event BetBull(address indexed sender, uint256 indexed epoch, uint256 amount)'),
    fromBlock: start,
    toBlock: end,
  });

  bullEvents.push(...events);

  // Small delay to avoid rate limiting
  await new Promise(resolve => setTimeout(resolve, 500));
}
console.log(`Found ${bullEvents.length} BetBull events\n`);

// Fetch BetBear events in chunks
console.log('Fetching BetBear events...');
const bearEvents = [];

for (let start = fromBlock; start < toBlock; start += chunkSize) {
  const end = start + chunkSize > toBlock ? toBlock : start + chunkSize;
  console.log(`  Blocks ${start} to ${end}...`);

  const events = await client.getLogs({
    address: PREDICTION_CONTRACT,
    event: parseAbiItem('event BetBear(address indexed sender, uint256 indexed epoch, uint256 amount)'),
    fromBlock: start,
    toBlock: end,
  });

  bearEvents.push(...events);

  await new Promise(resolve => setTimeout(resolve, 500));
}
console.log(`Found ${bearEvents.length} BetBear events\n`);

// Combine all bets
const allBets = [];

for (const event of bullEvents) {
  allBets.push({
    wallet: event.args.sender,
    epoch: Number(event.args.epoch),
    amount: event.args.amount,
    position: 'BULL',
    blockNumber: event.blockNumber,
  });
}

for (const event of bearEvents) {
  allBets.push({
    wallet: event.args.sender,
    epoch: Number(event.args.epoch),
    amount: event.args.amount,
    position: 'BEAR',
    blockNumber: event.blockNumber,
  });
}

console.log(`Total bets found: ${allBets.length}\n`);

// Group by wallet
const walletStats = {};

for (const bet of allBets) {
  if (!walletStats[bet.wallet]) {
    walletStats[bet.wallet] = {
      totalBets: 0,
      totalVolume: 0n,
      wins: 0,
      losses: 0,
      pending: 0,
      bets: [],
    };
  }

  walletStats[bet.wallet].totalBets++;
  walletStats[bet.wallet].totalVolume += bet.amount;
  walletStats[bet.wallet].bets.push(bet);
}

console.log(`Unique wallets found: ${Object.keys(walletStats).length}\n`);

// Check results from our database
console.log('Checking bet outcomes from database...\n');

for (const wallet in walletStats) {
  for (const bet of walletStats[wallet].bets) {
    // Query our database for this round
    const query = `
      SELECT winner FROM rounds WHERE epoch = ${bet.epoch}
    `;

    const stmt = db.prepare(query);
    if (stmt.step()) {
      const result = stmt.getAsObject();
      const winner = result.winner;

      if (winner === 'UP' || winner === 'DOWN') {
        // Check if bet won
        if ((bet.position === 'BULL' && winner === 'UP') ||
            (bet.position === 'BEAR' && winner === 'DOWN')) {
          walletStats[wallet].wins++;
        } else {
          walletStats[wallet].losses++;
        }
      } else {
        walletStats[wallet].pending++;
      }
    } else {
      walletStats[wallet].pending++;
    }
    stmt.free();
  }
}

// Sort wallets by total volume
const sortedWallets = Object.entries(walletStats)
  .map(([wallet, stats]) => ({
    wallet,
    ...stats,
    volumeBNB: Number(stats.totalVolume) / 1e18,
    winRate: stats.wins + stats.losses > 0 ? (stats.wins / (stats.wins + stats.losses)) * 100 : 0,
    completedBets: stats.wins + stats.losses,
  }))
  .filter(w => w.completedBets >= 5) // Only wallets with at least 5 completed bets in our data
  .sort((a, b) => b.winRate - a.winRate);

console.log('=== TOP WALLETS BY WIN RATE ===\n');
console.log('(Filtered: min 5 completed bets in our database)\n');

for (let i = 0; i < Math.min(20, sortedWallets.length); i++) {
  const w = sortedWallets[i];
  console.log(`${i + 1}. ${w.wallet}`);
  console.log(`   Win Rate: ${w.winRate.toFixed(2)}% (${w.wins}W / ${w.losses}L)`);
  console.log(`   Total Bets: ${w.totalBets} | Completed: ${w.completedBets} | Pending: ${w.pending}`);
  console.log(`   Volume: ${w.volumeBNB.toFixed(4)} BNB`);
  console.log('');
}

// Also show top by volume
const sortedByVolume = [...sortedWallets].sort((a, b) => b.volumeBNB - a.volumeBNB);

console.log('\n=== TOP WALLETS BY VOLUME ===\n');

for (let i = 0; i < Math.min(10, sortedByVolume.length); i++) {
  const w = sortedByVolume[i];
  console.log(`${i + 1}. ${w.wallet}`);
  console.log(`   Volume: ${w.volumeBNB.toFixed(4)} BNB`);
  console.log(`   Win Rate: ${w.winRate.toFixed(2)}% (${w.wins}W / ${w.losses}L)`);
  console.log(`   Total Bets: ${w.totalBets} | Completed: ${w.completedBets}`);
  console.log('');
}

// Find wallets with >60% win rate
const profitableWallets = sortedWallets.filter(w => w.winRate >= 60 && w.completedBets >= 10);

console.log(`\n=== HIGH WIN RATE WALLETS (≥60%, min 10 bets) ===\n`);
console.log(`Found ${profitableWallets.length} wallets\n`);

for (const w of profitableWallets) {
  console.log(`${w.wallet}`);
  console.log(`  Win Rate: ${w.winRate.toFixed(2)}% (${w.wins}W / ${w.losses}L)`);
  console.log(`  Total Bets: ${w.totalBets} | Volume: ${w.volumeBNB.toFixed(4)} BNB`);
  console.log('');
}

db.close();

console.log('\n✅ Analysis complete!');
console.log('\nNote: This analysis is limited to rounds in your live-monitor.db database.');
console.log('To track these wallets in real-time, monitor BetBull/BetBear events for these addresses.');
