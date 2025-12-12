import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('\n📊 PROFITABILITY: Favorite vs Underdog (Simple)\n');

const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE winner IS NOT NULL
  AND winner_payout_multiple IS NOT NULL
  AND winner_payout_multiple > 0
  ORDER BY sample_id ASC
`).all();

console.log('Total rounds:', rounds.length, '\n');

// Simple approach:
// Winner payout is known
// Loser payout = (total_pool * 0.97) / loser_amount

let favProfit = 0;
let undProfit = 0;
let favWins = 0;
let undWins = 0;

for (const r of rounds) {
  const winnerPayout = r.winner_payout_multiple;

  // Calculate what loser payout would have been
  // If winner got X payout from net pool, loser would get Y
  // winnerAmount * winnerPayout = netPool
  // loserPayout = netPool / loserAmount
  // We know: winnerAmount + loserAmount = totalPool
  // And: netPool = totalPool * 0.97

  // Simpler: just compare winner payout to average (1.94x if 50/50)
  const avgPayout = 1.94; // 0.97 / 0.5

  const isWinnerFavorite = winnerPayout < avgPayout;

  // Bet on favorite (lower payout)
  if (isWinnerFavorite) {
    favProfit += (winnerPayout - 1); // We win
    favWins++;
    undProfit -= 1; // Underdog loses
  } else {
    favProfit -= 1; // Favorite loses
    undProfit += (winnerPayout - 1); // We win betting underdog
    undWins++;
  }
}

const favROI = (favProfit / rounds.length) * 100;
const undROI = (undProfit / rounds.length) * 100;

console.log('FAVORITE (bet on lower payout side):');
console.log('  Wins:', favWins, '| Losses:', (rounds.length - favWins));
console.log('  Win rate:', (favWins/rounds.length*100).toFixed(2) + '%');
console.log('  Total profit:', favProfit.toFixed(2), 'units');
console.log('  ROI:', favROI.toFixed(2) + '%');

console.log('\nUNDERDOG (bet on higher payout side):');
console.log('  Wins:', undWins, '| Losses:', (rounds.length - undWins));
console.log('  Win rate:', (undWins/rounds.length*100).toFixed(2) + '%');
console.log('  Total profit:', undProfit.toFixed(2), 'units');
console.log('  ROI:', undROI.toFixed(2) + '%');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('✅ ANSWER:', favProfit > undProfit ?
  'FAVORITE is more profitable (+' + (favROI - undROI).toFixed(2) + '%)' :
  'UNDERDOG is more profitable (+' + (undROI - favROI).toFixed(2) + '%)');
console.log();

db.close();
