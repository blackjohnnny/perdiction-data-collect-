import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('=== Strategy Test on New Rounds (425681-425761) ===\n');

// Strategy parameters
const CROWD_THRESHOLD = 0.65; // 65%
const EMA_GAP_THRESHOLD = 0.10; // 0.10%
const POSITION_SIZE = 0.065; // 6.5%

console.log('Strategy Parameters:');
console.log(`  Crowd Threshold: ${(CROWD_THRESHOLD * 100).toFixed(0)}%`);
console.log(`  EMA Gap: ${EMA_GAP_THRESHOLD}%`);
console.log(`  Position Size: ${(POSITION_SIZE * 100).toFixed(1)}%\n`);

// Fetch rounds from the new backfilled range
const query = `
  SELECT
    r.epoch,
    r.lock_ts,
    r.winner,
    s.total_amount_wei,
    s.bull_amount_wei,
    s.bear_amount_wei
  FROM rounds r
  JOIN snapshots s ON r.epoch = s.epoch AND s.snapshot_type = 'T_MINUS_20S'
  WHERE r.epoch >= 425681 AND r.epoch <= 425761
    AND r.winner IN ('UP', 'DOWN')
  ORDER BY r.epoch
`;

const stmt = db.prepare(query);
const rounds = [];

while (stmt.step()) {
  const row = stmt.getAsObject();
  rounds.push({
    epoch: row.epoch,
    lockTimestamp: row.lock_ts,
    winner: row.winner,
    totalWei: BigInt(row.total_amount_wei),
    bullWei: BigInt(row.bull_amount_wei),
    bearWei: BigInt(row.bear_amount_wei),
  });
}
stmt.free();

console.log(`Found ${rounds.length} rounds with T-20s data and known winners\n`);

if (rounds.length === 0) {
  console.log('❌ No rounds to test (need T-20s snapshots)');
  db.close();
  process.exit(0);
}

// Helper to fetch EMA data from TradingView/Pyth
async function getEMAData(timestamp) {
  // For this test, we'll skip EMA for now since we need external API
  // Return null to indicate we should skip this round
  return null;
}

// Simulate trades
let bankroll = 1000; // Start with $1000
let totalTrades = 0;
let wins = 0;
let losses = 0;
const trades = [];

console.log('Testing strategy (with crowd filter only, EMA skipped)...\n');

for (const round of rounds) {
  const total = Number(round.totalWei) / 1e18;
  const bull = Number(round.bullWei) / 1e18;
  const bear = Number(round.bearWei) / 1e18;

  // Calculate crowd percentages
  const bullPct = bull / total;
  const bearPct = bear / total;

  // Check if crowd meets threshold
  let prediction = null;
  let crowdPct = 0;

  if (bullPct >= CROWD_THRESHOLD) {
    // Crowd is on BULL side, we go BEAR (contrarian)
    prediction = 'BEAR';
    crowdPct = bullPct;
  } else if (bearPct >= CROWD_THRESHOLD) {
    // Crowd is on BEAR side, we go BULL (contrarian)
    prediction = 'BULL';
    crowdPct = bearPct;
  }

  if (!prediction) continue; // Skip if crowd not strong enough

  // Calculate position size
  const positionSize = bankroll * POSITION_SIZE;

  // Determine actual outcome
  const actualOutcome = round.winner; // 'UP' or 'DOWN'
  const won = (prediction === 'BULL' && actualOutcome === 'UP') ||
              (prediction === 'BEAR' && actualOutcome === 'DOWN');

  // Calculate payout (simplified, using implied odds from T-20s)
  let payout = 0;
  if (won) {
    if (prediction === 'BULL') {
      payout = positionSize * (total / bull); // UP payout
    } else {
      payout = positionSize * (total / bear); // DOWN payout
    }
  }

  const netProfit = won ? (payout - positionSize) : -positionSize;
  bankroll += netProfit;

  totalTrades++;
  if (won) wins++;
  else losses++;

  trades.push({
    epoch: round.epoch,
    prediction,
    actual: actualOutcome,
    crowdPct: (crowdPct * 100).toFixed(1),
    position: positionSize.toFixed(2),
    profit: netProfit.toFixed(2),
    bankroll: bankroll.toFixed(2),
    won,
  });
}

console.log('=== Results ===\n');
console.log(`Total Qualifying Trades: ${totalTrades}`);
console.log(`Wins: ${wins}`);
console.log(`Losses: ${losses}`);
console.log(`Win Rate: ${((wins / totalTrades) * 100).toFixed(2)}%\n`);

const roi = ((bankroll - 1000) / 1000) * 100;
console.log(`Starting Bankroll: $1000.00`);
console.log(`Ending Bankroll: $${bankroll.toFixed(2)}`);
console.log(`Net Profit: $${(bankroll - 1000).toFixed(2)}`);
console.log(`ROI: ${roi.toFixed(2)}%\n`);

// Show sample trades
console.log('=== Sample Trades (first 10) ===\n');
trades.slice(0, 10).forEach((t, i) => {
  const result = t.won ? '✅ WIN' : '❌ LOSS';
  console.log(`${i + 1}. Epoch ${t.epoch}: ${t.prediction} (crowd: ${t.crowdPct}%) → ${t.actual} ${result}`);
  console.log(`   Profit: $${t.profit} | Bankroll: $${t.bankroll}`);
});

if (trades.length > 10) {
  console.log(`\n... and ${trades.length - 10} more trades`);
}

console.log('\n⚠️  Note: This test uses CROWD THRESHOLD ONLY (no EMA filter)');
console.log('For full strategy test with EMA, use test-t20-strategy-final.mjs\n');

db.close();
