import Database from 'better-sqlite3';

const db = new Database('./resolved_markets.db', { readonly: true });

console.log('\n🔍 EXPLAINING CROWD CONFIRMATION LOGIC\n');
console.log('═'.repeat(80) + '\n');

// Test a few markets to show the logic
const testMarkets = ['685668', '685252', '679014'];

for (const marketId of testMarkets) {
  const metadata = db.prepare('SELECT * FROM market_metadata WHERE market_id = ?').get(marketId);

  console.log(`📊 Market ${marketId}: ${metadata.market_title}\n`);

  // Get snapshots
  const snapshots = db.prepare(`
    SELECT timestamp, mid_price, best_bid, best_ask
    FROM orderbook_snapshots
    WHERE market_id = ? AND outcome_name = 'Yes'
    ORDER BY timestamp ASC
  `).all(marketId);

  // Find entry point (5min before close)
  const marketDuration = metadata.duration_minutes;
  const timeBeforeClose = 5 + (20 / 60);
  const targetPoint = 1 - (timeBeforeClose / marketDuration);
  const targetIndex = Math.floor(snapshots.length * targetPoint);

  let entrySnapshot = null;
  const searchRange = Math.floor(snapshots.length * 0.05);

  for (let i = targetIndex; i >= Math.max(0, targetIndex - searchRange); i--) {
    if (snapshots[i].mid_price !== null && snapshots[i].best_ask !== null && snapshots[i].best_bid !== null) {
      entrySnapshot = snapshots[i];
      break;
    }
  }

  if (!entrySnapshot) {
    console.log('  ❌ No valid entry snapshot\n');
    continue;
  }

  console.log(`  📸 Entry Snapshot Data:`);
  console.log(`     mid_price: ${entrySnapshot.mid_price}`);
  console.log(`     best_bid: ${entrySnapshot.best_bid}`);
  console.log(`     best_ask: ${entrySnapshot.best_ask}`);
  console.log('');

  // MY CURRENT LOGIC:
  console.log(`  🧮 MY CURRENT LOGIC:`);

  const crowdYesPercent = entrySnapshot.mid_price * 100;
  const crowdNoPercent = 100 - crowdYesPercent;

  console.log(`     mid_price × 100 = ${crowdYesPercent.toFixed(2)}% (crowd betting YES/BULL)`);
  console.log(`     100 - ${crowdYesPercent.toFixed(2)} = ${crowdNoPercent.toFixed(2)}% (crowd betting NO/BEAR)`);
  console.log('');

  let crowdSide = null;
  let crowdPercent = 0;
  let entryPrice = 0;

  if (crowdYesPercent >= 65) {
    crowdSide = 'BULL';
    crowdPercent = crowdYesPercent;
    entryPrice = entrySnapshot.best_ask;
    console.log(`     ✅ Crowd ≥65% YES → Crowd side: BULL`);
    console.log(`     ✅ Entry price: best_ask = ${entryPrice}¢`);
  } else if (crowdNoPercent >= 65) {
    crowdSide = 'BEAR';
    crowdPercent = crowdNoPercent;
    entryPrice = 1.0 - entrySnapshot.best_bid;
    console.log(`     ✅ Crowd ≥65% NO → Crowd side: BEAR`);
    console.log(`     ✅ Entry price: 1.0 - best_bid = ${entryPrice}¢`);
  } else {
    console.log(`     ⚠️  No strong crowd (both sides <65%)`);
  }

  console.log('');
  console.log(`  📋 SUMMARY:`);
  console.log(`     Crowd side: ${crowdSide || 'NEUTRAL'}`);
  console.log(`     Crowd strength: ${crowdPercent.toFixed(2)}%`);
  console.log(`     Entry price: ${entryPrice.toFixed(3)}¢`);
  console.log('');

  // Parse actual winner
  const winningOutcomes = JSON.parse(metadata.winning_outcomes);
  const yesWon = winningOutcomes.some(w => w.outcome === 'Yes');
  const actualWinner = yesWon ? 'BULL (Yes won)' : 'BEAR (No won)';
  console.log(`  🏆 Actual winner: ${actualWinner}`);

  console.log('\n' + '─'.repeat(80) + '\n');
}

console.log('\n❓ YOUR QUESTION:\n');
console.log('How should we ACTUALLY determine crowd confirmation?\n');
console.log('Options:');
console.log('  1. Use mid_price as I currently do (price equilibrium point)');
console.log('  2. Use orderbook volume (bid_size_total vs ask_size_total)');
console.log('  3. Use best_ask vs best_bid spread');
console.log('  4. Something else?\n');

console.log('Mid-price explanation:');
console.log('  - mid_price = 0.80 means market thinks YES has 80% chance');
console.log('  - If mid_price ≥ 0.65, then crowd is ≥65% confident in YES (BULL)');
console.log('  - If mid_price ≤ 0.35, then crowd is ≥65% confident in NO (BEAR)\n');

console.log('═'.repeat(80) + '\n');

db.close();
