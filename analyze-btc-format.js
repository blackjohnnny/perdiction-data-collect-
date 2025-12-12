import Database from 'better-sqlite3';

const db = new Database('./resolved_markets.db', { readonly: true });

console.log('\n📊 BTC DATA FORMAT ANALYSIS\n');
console.log('═'.repeat(80) + '\n');

// Check unique markets
const markets = db.prepare(`
  SELECT DISTINCT market_id, market_title
  FROM orderbook_snapshots
`).all();

console.log(`🎯 UNIQUE MARKETS: ${markets.length}\n`);
for (const m of markets) {
  console.log(`  - Market ${m.market_id}: ${m.market_title}`);
}
console.log('\n' + '─'.repeat(80) + '\n');

// Check for winning outcomes in metadata
console.log('🏆 MARKET METADATA (Winners):\n');
const metadata = db.prepare(`SELECT * FROM market_metadata`).all();

for (const m of metadata) {
  console.log(`Market ${m.market_id}:`);
  console.log(`  Title: ${m.market_title}`);
  console.log(`  Winning Outcomes: ${m.winning_outcomes}`);
  console.log(`  Duration: ${m.duration_minutes} minutes`);
  console.log(`  Snapshots: ${m.snapshot_count}`);
  console.log('');
}

console.log('─'.repeat(80) + '\n');

// Check if we can extract T-20 equivalent and final outcome
console.log('📸 SNAPSHOT TIMING ANALYSIS:\n');

for (const market of metadata) {
  const snapshots = db.prepare(`
    SELECT timestamp, mid_price, best_bid, best_ask
    FROM orderbook_snapshots
    WHERE market_id = ?
    ORDER BY timestamp ASC
  `).all(market.market_id);

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const t20_idx = Math.max(0, snapshots.length - 10); // Approximate T-20 (20s before end)
  const t20 = snapshots[t20_idx];

  console.log(`Market ${market.market_id}:`);
  console.log(`  Total snapshots: ${snapshots.length}`);
  console.log(`  First snapshot: timestamp ${first.timestamp}, mid_price ${first.mid_price}`);
  console.log(`  T-20s approx: timestamp ${t20.timestamp}, mid_price ${t20.mid_price}`);
  console.log(`  Last snapshot: timestamp ${last.timestamp}, mid_price ${last.mid_price}`);
  console.log(`  Winner: ${market.winning_outcomes}`);
  console.log('');
}

console.log('─'.repeat(80) + '\n');

// Determine data structure compatibility
console.log('✅ DATA COMPATIBILITY CHECK:\n');
console.log('  ✅ Has timestamps (can find T-20s equivalent)');
console.log('  ✅ Has market outcomes/winners');
console.log('  ✅ Has bid/ask prices (crowd sentiment via mid_price)');
console.log('  ✅ Has multiple snapshots per market (time series)');
console.log('\n  ⚠️  DIFFERENCES FROM BNB DATA:');
console.log('     - Uses mid_price (0-1) instead of bull/bear pool amounts');
console.log('     - mid_price > 0.5 = crowd thinks "Yes" (UP)');
console.log('     - mid_price < 0.5 = crowd thinks "No" (DOWN)');
console.log('     - Need to map "Yes" outcome to "UP" for BTC direction');
console.log('\n  📝 MAPPING STRATEGY:');
console.log('     - Crowd sentiment: mid_price at T-20s (>0.5 = bullish, <0.5 = bearish)');
console.log('     - Winner: Parse winning_outcomes ("Yes" = UP won, "No" = DOWN won)');
console.log('     - Payout: Calculate from best_bid/best_ask at T-20s');

console.log('\n' + '═'.repeat(80) + '\n');

db.close();
