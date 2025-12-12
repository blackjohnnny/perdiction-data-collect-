import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('\n📊 PROFITABILITY: Bet FAVORITE vs Bet UNDERDOG\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL
  AND winner IS NOT NULL
  ORDER BY sample_id ASC
`).all();

console.log('Total rounds:', rounds.length, '\n');

// Strategy 1: Always bet on FAVORITE (lower payout at lock)
let favBalance = 1.0;
let favTrades = 0;
let favWins = 0;
let favLosses = 0;

// Strategy 2: Always bet on UNDERDOG (higher payout at lock)
let undBalance = 1.0;
let undTrades = 0;
let undWins = 0;
let undLosses = 0;

for (const r of rounds) {
  const lockBull = parseFloat(r.lock_bull_wei) / 1e18;
  const lockBear = parseFloat(r.lock_bear_wei) / 1e18;
  const total = lockBull + lockBear;

  if (total === 0) continue;

  const netPool = total * 0.97;
  const bullPayout = netPool / lockBull;
  const bearPayout = netPool / lockBear;

  // Determine favorite and underdog
  let favoriteSide, underdogSide, favoritePayout, underdogPayout;
  if (bullPayout < bearPayout) {
    // Bull is favorite (lower payout)
    favoriteSide = 'bull';
    underdogSide = 'bear';
    favoritePayout = bullPayout;
    underdogPayout = bearPayout;
  } else {
    // Bear is favorite (lower payout)
    favoriteSide = 'bear';
    underdogSide = 'bull';
    favoritePayout = bearPayout;
    underdogPayout = bullPayout;
  }

  // Bet on FAVORITE
  const betSize = 0.01; // 1% of starting bankroll each time (fixed for comparison)
  favTrades++;
  if (favoriteSide === r.winner) {
    favBalance += betSize * (favoritePayout - 1);
    favWins++;
  } else {
    favBalance -= betSize;
    favLosses++;
  }

  // Bet on UNDERDOG
  undTrades++;
  if (underdogSide === r.winner) {
    undBalance += betSize * (underdogPayout - 1);
    undWins++;
  } else {
    undBalance -= betSize;
    undLosses++;
  }
}

const favWinRate = (favWins / favTrades * 100);
const favROI = ((favBalance - 1.0) * 100);

const undWinRate = (undWins / undTrades * 100);
const undROI = ((undBalance - 1.0) * 100);

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

console.log('💰 FAVORITE (Lower Payout) Strategy:\n');
console.log('  Trades:', favTrades);
console.log('  Wins:', favWins, '| Losses:', favLosses);
console.log('  Win Rate:', favWinRate.toFixed(2) + '%');
console.log('  Final Balance:', favBalance.toFixed(4), 'BNB');
console.log('  ROI:', (favROI >= 0 ? '+' : '') + favROI.toFixed(2) + '%');
console.log('  Status:', favROI > 0 ? '✅ PROFITABLE' : '❌ LOSING');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

console.log('🎲 UNDERDOG (Higher Payout) Strategy:\n');
console.log('  Trades:', undTrades);
console.log('  Wins:', undWins, '| Losses:', undLosses);
console.log('  Win Rate:', undWinRate.toFixed(2) + '%');
console.log('  Final Balance:', undBalance.toFixed(4), 'BNB');
console.log('  ROI:', (undROI >= 0 ? '+' : '') + undROI.toFixed(2) + '%');
console.log('  Status:', undROI > 0 ? '✅ PROFITABLE' : '❌ LOSING');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

console.log('💡 COMPARISON:\n');
const diff = favROI - undROI;
if (Math.abs(diff) < 1) {
  console.log('  ⚖️  Both strategies have similar profitability');
} else if (favROI > undROI) {
  console.log('  ✅ FAVORITE is more profitable by', diff.toFixed(2) + '%');
  console.log('  → Bet on the side with LOWER payout (majority/favorite)');
} else {
  console.log('  ✅ UNDERDOG is more profitable by', Math.abs(diff).toFixed(2) + '%');
  console.log('  → Bet on the side with HIGHER payout (minority/underdog)');
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

console.log('⚠️  NOTE: This uses LOCK settlement payout, not T-20s payout.');
console.log('Real trading happens at T-20s with different odds!\n');

db.close();
