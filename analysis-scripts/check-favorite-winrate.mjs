import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('   DOES THE FAVORITE (LOWER PAYOUT) WIN MORE?');
console.log('═══════════════════════════════════════════════════════════════\n');

// Get all rounds with results
const query = `
  SELECT
    epoch,
    winner,
    bull_amount_wei,
    bear_amount_wei,
    total_amount_wei
  FROM rounds
  WHERE winner IN ('UP', 'DOWN')
    AND total_amount_wei > 0
  ORDER BY epoch
`;

const stmt = db.prepare(query);
const rounds = [];
while (stmt.step()) {
  const row = stmt.getAsObject();
  rounds.push({
    epoch: row.epoch,
    winner: row.winner,
    bullAmount: BigInt(row.bull_amount_wei),
    bearAmount: BigInt(row.bear_amount_wei),
    totalAmount: BigInt(row.total_amount_wei)
  });
}
stmt.free();
db.close();

console.log(`Total rounds analyzed: ${rounds.length}\n`);

let favoriteWins = 0;
let underdogWins = 0;

for (const round of rounds) {
  const bullPct = Number(round.bullAmount * 10000n / round.totalAmount) / 100;
  const bearPct = Number(round.bearAmount * 10000n / round.totalAmount) / 100;

  // Calculate implied payouts (simplified, ignoring house edge)
  const impliedUpMultiple = 100 / bullPct;
  const impliedDownMultiple = 100 / bearPct;

  // Favorite is the side with MORE money (LOWER payout)
  const favorite = impliedUpMultiple < impliedDownMultiple ? 'UP' : 'DOWN';

  if (round.winner === favorite) {
    favoriteWins++;
  } else {
    underdogWins++;
  }
}

const favoriteWinRate = (favoriteWins / rounds.length) * 100;
const underdogWinRate = (underdogWins / rounds.length) * 100;

console.log('═══════════════════════════════════════════════════════════════');
console.log('                         RESULTS');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`Favorite Wins:    ${favoriteWins.toLocaleString()} (${favoriteWinRate.toFixed(2)}%)`);
console.log(`Underdog Wins:    ${underdogWins.toLocaleString()} (${underdogWinRate.toFixed(2)}%)`);
console.log(`\nTotal:            ${rounds.length.toLocaleString()} rounds\n`);

if (favoriteWinRate > 52) {
  console.log('✅ YES - The favorite (side with more money) wins MORE than 50%');
  console.log('   The crowd has predictive power!\n');
} else if (favoriteWinRate < 48) {
  console.log('✅ YES - The underdog (side with less money) wins MORE than 50%');
  console.log('   The crowd is often wrong! (Contrarian edge)\n');
} else {
  console.log('❌ NO significant edge - Favorite wins ~50% (near random)\n');
}

console.log('═══════════════════════════════════════════════════════════════\n');
