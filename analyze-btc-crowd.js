import Database from 'better-sqlite3';

const db = new Database('./resolved_markets.db', { readonly: true });

console.log('\n📊 ANALYZING BTC CROWD DATA ACROSS TIME\n');
console.log('═'.repeat(80) + '\n');

// Pick a few markets and see how mid_price changes over time
const testMarkets = ['677977', '678355', '679246', '685267', '685668'];

for (const marketId of testMarkets) {
  const metadata = db.prepare('SELECT * FROM market_metadata WHERE market_id = ?').get(marketId);
  if (!metadata) continue;

  console.log(`📈 Market ${marketId}: ${metadata.market_title}`);
  console.log(`   Winner: ${metadata.winning_outcomes}\n`);

  const snapshots = db.prepare(`
    SELECT timestamp, mid_price, best_bid, best_ask
    FROM orderbook_snapshots
    WHERE market_id = ? AND outcome_name = 'Yes'
    ORDER BY timestamp ASC
  `).all(marketId);

  // Show snapshots at different time points
  const indices = [
    0, // Start
    Math.floor(snapshots.length * 0.25), // 25%
    Math.floor(snapshots.length * 0.50), // 50%
    Math.floor(snapshots.length * 0.75), // 75%
    Math.floor(snapshots.length * 0.90), // 90% (T-20s equiv)
    snapshots.length - 1 // End
  ];

  console.log('   Time Points:');
  for (const idx of indices) {
    const s = snapshots[idx];
    const pct = ((idx / (snapshots.length - 1)) * 100).toFixed(0);
    const midPrice = s.mid_price !== null ? (s.mid_price * 100).toFixed(1) : 'null';
    const bestBid = s.best_bid !== null ? (s.best_bid * 100).toFixed(1) : 'null';
    const bestAsk = s.best_ask !== null ? (s.best_ask * 100).toFixed(1) : 'null';

    console.log(`     ${pct}%: mid=${midPrice}¢ | bid=${bestBid}¢ | ask=${bestAsk}¢`);
  }

  console.log('\n');
}

console.log('═'.repeat(80) + '\n');

// Check overall: how many snapshots have strong crowd (mid_price > 65 or < 35)?
console.log('📊 OVERALL CROWD STRENGTH ANALYSIS:\n');

const allSnapshots = db.prepare(`
  SELECT mid_price
  FROM orderbook_snapshots
  WHERE outcome_name = 'Yes' AND mid_price IS NOT NULL
`).all();

let strongBull = 0;  // mid_price > 65%
let strongBear = 0;  // mid_price < 35%
let neutral = 0;     // mid_price 35-65%

for (const s of allSnapshots) {
  const pct = s.mid_price * 100;
  if (pct >= 65) strongBull++;
  else if (pct <= 35) strongBear++;
  else neutral++;
}

console.log(`  Total non-null snapshots: ${allSnapshots.length}`);
console.log(`  Strong BULL (≥65%): ${strongBull} (${(strongBull/allSnapshots.length*100).toFixed(1)}%)`);
console.log(`  Strong BEAR (≤35%): ${strongBear} (${(strongBear/allSnapshots.length*100).toFixed(1)}%)`);
console.log(`  Neutral (35-65%): ${neutral} (${(neutral/allSnapshots.length*100).toFixed(1)}%)`);

console.log('\n' + '═'.repeat(80) + '\n');

db.close();
