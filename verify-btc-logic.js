import Database from 'better-sqlite3';

const db = new Database('./resolved_markets.db', { readonly: true });

console.log('\n🔍 VERIFYING BTC LOGIC - NO CHEATING CHECK\n');
console.log('═'.repeat(80) + '\n');

// Test specific markets manually
const testMarkets = [
  '678355', // Market 2: Crowd 3% BEAR, Winner BEAR, Won with 20x
  '679246', // Market 4: Crowd 98.5% BULL, Winner BULL, Should win
  '685252', // Crowd 98.5% BULL, Winner BULL
];

for (const marketId of testMarkets) {
  console.log(`\n📊 MARKET ${marketId}:\n`);

  // Get metadata
  const metadata = db.prepare('SELECT * FROM market_metadata WHERE market_id = ?').get(marketId);
  console.log(`  Title: ${metadata.market_title}`);
  console.log(`  Winning outcomes: ${metadata.winning_outcomes}`);

  // Parse winner
  const winningOutcomes = JSON.parse(metadata.winning_outcomes);
  console.log(`  Parsed outcomes:`);
  for (const w of winningOutcomes) {
    console.log(`    - ${w.outcome} @ ${w.price}`);
  }

  const yesWon = winningOutcomes.some(w => w.outcome === 'Yes');
  const actualWinner = yesWon ? 'BULL (Yes won)' : 'BEAR (No won)';
  console.log(`  Actual winner: ${actualWinner}`);

  // Get T-20s snapshot
  const snapshots = db.prepare(`
    SELECT timestamp, mid_price, best_bid, best_ask
    FROM orderbook_snapshots
    WHERE market_id = ? AND outcome_name = 'Yes'
    ORDER BY timestamp ASC
  `).all(marketId);

  const start70pct = Math.floor(snapshots.length * 0.70);
  let t20sSnapshot = null;

  for (let i = snapshots.length - 1; i >= start70pct; i--) {
    if (snapshots[i].mid_price !== null && snapshots[i].best_ask !== null) {
      t20sSnapshot = snapshots[i];
      break;
    }
  }

  if (t20sSnapshot) {
    const crowdPercent = (t20sSnapshot.mid_price * 100).toFixed(2);
    const crowdSide = t20sSnapshot.mid_price > 0.5 ? 'BULL (betting Yes)' : 'BEAR (betting No)';
    const payout = (1.0 / t20sSnapshot.best_ask).toFixed(2);

    console.log(`  T-20s crowd: ${crowdPercent}% = ${crowdSide}`);
    console.log(`  T-20s price: ${t20sSnapshot.best_ask}`);
    console.log(`  T-20s payout if win: ${payout}x`);

    // Check if we bet correctly
    const crowdIsBull = t20sSnapshot.mid_price > 0.5;
    const betSide = crowdIsBull ? 'BULL' : 'BEAR';
    console.log(`  Strategy bets: ${betSide} (WITH crowd)`);

    // Did we win?
    const weWon = (betSide === 'BULL' && yesWon) || (betSide === 'BEAR' && !yesWon);
    console.log(`  Result: ${weWon ? '✅ WIN' : '❌ LOSS'}`);

    if (weWon) {
      console.log(`  Profit: +${(parseFloat(payout) - 1).toFixed(2)} units`);
    } else {
      console.log(`  Loss: -1.00 units`);
    }
  }

  console.log('\n' + '─'.repeat(80));
}

console.log('\n');

// Check SUSPICIOUS pattern: Are winners always matching crowd?
console.log('🚨 CHECKING FOR SUSPICIOUS PATTERNS:\n');

const allMarkets = db.prepare('SELECT * FROM market_metadata').all();
let crowdWins = 0;
let crowdLosses = 0;

for (const market of allMarkets) {
  const snapshots = db.prepare(`
    SELECT mid_price, best_ask
    FROM orderbook_snapshots
    WHERE market_id = ? AND outcome_name = 'Yes'
    ORDER BY timestamp ASC
  `).all(market.market_id);

  if (snapshots.length === 0) continue;

  const start70pct = Math.floor(snapshots.length * 0.70);
  let t20s = null;

  for (let i = snapshots.length - 1; i >= start70pct; i--) {
    if (snapshots[i].mid_price !== null && snapshots[i].best_ask !== null) {
      t20s = snapshots[i];
      break;
    }
  }

  if (!t20s) continue;

  const crowdPercent = t20s.mid_price * 100;
  if (crowdPercent >= 35 && crowdPercent <= 65) continue; // Skip neutral

  const winningOutcomes = JSON.parse(market.winning_outcomes);
  const yesWon = winningOutcomes.some(w => w.outcome === 'Yes');

  const crowdBetYes = t20s.mid_price > 0.5;

  if ((crowdBetYes && yesWon) || (!crowdBetYes && !yesWon)) {
    crowdWins++;
  } else {
    crowdLosses++;
  }
}

console.log(`  Markets with strong crowd (≥65% or ≤35%):`);
console.log(`    Crowd was RIGHT: ${crowdWins}`);
console.log(`    Crowd was WRONG: ${crowdLosses}`);
console.log(`    Crowd accuracy: ${((crowdWins / (crowdWins + crowdLosses)) * 100).toFixed(2)}%`);

console.log('\n' + '═'.repeat(80) + '\n');

db.close();
