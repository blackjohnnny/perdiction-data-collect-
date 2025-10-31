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

console.log('Analyzing wallet performance from existing database...\n');

// Get all epochs with results from our database
const epochQuery = `
  SELECT DISTINCT epoch, winner
  FROM rounds
  WHERE winner IN ('UP', 'DOWN')
  ORDER BY epoch
`;

const stmt = db.prepare(epochQuery);
const epochs = [];
while (stmt.step()) {
  const row = stmt.getAsObject();
  epochs.push({ epoch: row.epoch, winner: row.winner });
}
stmt.free();

console.log(`Found ${epochs.length} rounds with results in database\n`);

if (epochs.length === 0) {
  console.log('No data to analyze!');
  db.close();
  process.exit(0);
}

// For each epoch, we need to fetch BetBull and BetBear events from blockchain
// But we'll do it VERY carefully to avoid rate limits
console.log('Fetching bet events from blockchain (this will take a while)...\n');

const walletStats = {};
const chunkSize = 20; // Process 20 epochs at a time

for (let i = 0; i < epochs.length; i += chunkSize) {
  const chunk = epochs.slice(i, i + chunkSize);
  console.log(`Processing epochs ${i + 1} to ${Math.min(i + chunkSize, epochs.length)} of ${epochs.length}...`);

  for (const { epoch, winner } of chunk) {
    try {
      // Fetch BetBull events for this epoch
      const bullEvents = await client.getLogs({
        address: PREDICTION_CONTRACT,
        event: parseAbiItem('event BetBull(address indexed sender, uint256 indexed epoch, uint256 amount)'),
        args: { epoch: BigInt(epoch) },
        fromBlock: 0n,
        toBlock: 'latest',
      });

      // Fetch BetBear events for this epoch
      const bearEvents = await client.getLogs({
        address: PREDICTION_CONTRACT,
        event: parseAbiItem('event BetBear(address indexed sender, uint256 indexed epoch, uint256 amount)'),
        args: { epoch: BigInt(epoch) },
        fromBlock: 0n,
        toBlock: 'latest',
      });

      // Process bull bets
      for (const event of bullEvents) {
        const wallet = event.args.sender;
        if (!walletStats[wallet]) {
          walletStats[wallet] = { wins: 0, losses: 0, totalVolume: 0n, bets: [] };
        }

        const won = winner === 'UP';
        if (won) {
          walletStats[wallet].wins++;
        } else {
          walletStats[wallet].losses++;
        }

        walletStats[wallet].totalVolume += event.args.amount;
        walletStats[wallet].bets.push({ epoch, position: 'BULL', amount: event.args.amount, won });
      }

      // Process bear bets
      for (const event of bearEvents) {
        const wallet = event.args.sender;
        if (!walletStats[wallet]) {
          walletStats[wallet] = { wins: 0, losses: 0, totalVolume: 0n, bets: [] };
        }

        const won = winner === 'DOWN';
        if (won) {
          walletStats[wallet].wins++;
        } else {
          walletStats[wallet].losses++;
        }

        walletStats[wallet].totalVolume += event.args.amount;
        walletStats[wallet].bets.push({ epoch, position: 'BEAR', amount: event.args.amount, won });
      }

      // Delay between requests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      console.log(`  ⚠️  Error fetching epoch ${epoch}: ${error.message}`);
      // Continue with next epoch
    }
  }

  console.log(`  Processed chunk. Found ${Object.keys(walletStats).length} unique wallets so far.\n`);
}

console.log('\n=== Analysis Complete ===\n');
console.log(`Total unique wallets: ${Object.keys(walletStats).length}\n`);

// Calculate win rates
const wallets = Object.entries(walletStats)
  .map(([wallet, stats]) => ({
    wallet,
    ...stats,
    totalBets: stats.wins + stats.losses,
    winRate: stats.wins + stats.losses > 0 ? (stats.wins / (stats.wins + stats.losses)) * 100 : 0,
    volumeBNB: Number(stats.totalVolume) / 1e18,
  }))
  .filter(w => w.totalBets >= 10) // Only wallets with 10+ bets
  .sort((a, b) => b.winRate - a.winRate);

console.log('=== TOP WALLETS BY WIN RATE (min 10 bets) ===\n');

for (let i = 0; i < Math.min(20, wallets.length); i++) {
  const w = wallets[i];
  console.log(`${i + 1}. ${w.wallet}`);
  console.log(`   Win Rate: ${w.winRate.toFixed(2)}% (${w.wins}W / ${w.losses}L)`);
  console.log(`   Total Bets: ${w.totalBets} | Volume: ${w.volumeBNB.toFixed(4)} BNB`);
  console.log('');
}

// Find profitable wallets (>55% win rate)
const profitable = wallets.filter(w => w.winRate >= 55);

console.log(`\n=== HIGH WIN RATE WALLETS (≥55%, min 10 bets) ===\n`);
console.log(`Found ${profitable.length} wallets\n`);

for (const w of profitable.slice(0, 20)) {
  console.log(`${w.wallet}`);
  console.log(`  Win Rate: ${w.winRate.toFixed(2)}% (${w.wins}W / ${w.losses}L)`);
  console.log(`  Total Bets: ${w.totalBets} | Volume: ${w.volumeBNB.toFixed(4)} BNB`);
  console.log('');
}

// Top by volume
const byVolume = [...wallets].sort((a, b) => b.volumeBNB - a.volumeBNB);

console.log('\n=== TOP WALLETS BY VOLUME (min 10 bets) ===\n');

for (let i = 0; i < Math.min(10, byVolume.length); i++) {
  const w = byVolume[i];
  console.log(`${i + 1}. ${w.wallet}`);
  console.log(`   Volume: ${w.volumeBNB.toFixed(4)} BNB`);
  console.log(`   Win Rate: ${w.winRate.toFixed(2)}% (${w.wins}W / ${w.losses}L)`);
  console.log(`   Total Bets: ${w.totalBets}`);
  console.log('');
}

db.close();

console.log('\n✅ Analysis complete!');
console.log(`\nNote: This analysis covers ${epochs.length} rounds from your live-monitor.db database.`);
console.log('To track specific wallets in real-time, monitor BetBull/BetBear events for these addresses.');
