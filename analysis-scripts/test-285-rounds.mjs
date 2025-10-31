import initSqlJs from 'sql.js';
import fs from 'fs';

const sqlJs = await initSqlJs();
const buf = fs.readFileSync('../data/prediction-data.db');
const db = new sqlJs.Database(buf);

// Get all rounds with T-25s snapshots (treating as T-20s) AND results
const query = `
  SELECT
    r.epoch,
    r.winner,
    s.bull_amount_wei,
    s.bear_amount_wei,
    s.implied_up_multiple,
    s.implied_down_multiple,
    r.bull_amount_wei as final_bull_wei,
    r.bear_amount_wei as final_bear_wei,
    r.winner_multiple
  FROM snapshots s
  JOIN rounds r ON s.epoch = r.epoch
  WHERE s.snapshot_type = 'T_MINUS_25S'
    AND r.winner != 'UNKNOWN'
  ORDER BY r.epoch
`;

const result = db.exec(query);

if (result.length === 0) {
  console.log('No data found');
  process.exit(0);
}

const rows = result[0].values;
console.log(`Found ${rows.length} rounds with T-25s snapshots and results\n`);

// Strategy simulation
let bankroll = 1.0; // Start with 1 BNB
let wins = 0;
let losses = 0;
let totalBets = 0;
let totalWagered = 0;
let totalReturned = 0;

const BET_PERCENTAGE = 0.02; // 2% of bankroll per bet
const CROWD_THRESHOLD = 0.55; // 55% dominance
const MAX_BANKROLL = 1000000; // Cap to prevent overflow

rows.forEach(row => {
  const [epoch, winner, bullWei, bearWei, upPayout, downPayout, finalBullWei, finalBearWei, winnerMultiple] = row;

  const bullAmount = parseFloat(bullWei) / 1e18;
  const bearAmount = parseFloat(bearWei) / 1e18;
  const totalPool = bullAmount + bearAmount;

  const bullPct = bullAmount / totalPool;
  const bearPct = bearAmount / totalPool;

  // Calculate final payouts
  const finalBull = parseFloat(finalBullWei) / 1e18;
  const finalBear = parseFloat(finalBearWei) / 1e18;
  const finalTotal = finalBull + finalBear;
  const finalUpPayout = (finalTotal * 0.97) / finalBull;
  const finalDownPayout = (finalTotal * 0.97) / finalBear;

  // Determine T-25s crowd (≥55% threshold)
  let t25sCrowd = null;
  if (bullPct >= CROWD_THRESHOLD) t25sCrowd = 'UP';
  else if (bearPct >= CROWD_THRESHOLD) t25sCrowd = 'DOWN';

  if (!t25sCrowd) return; // Skip if no clear crowd

  // EMA signal (we need to check this separately - for now assume we have it)
  // For this test, we'll use a placeholder - you'll need to integrate actual EMA data
  // Let's just test crowd alone for now to see the baseline

  // Bet on the crowd side
  const ourBet = t25sCrowd;
  const won = (ourBet === winner);

  const betSize = Math.min(bankroll * BET_PERCENTAGE, bankroll);
  totalWagered += betSize;
  totalBets++;

  bankroll -= betSize; // Remove bet

  if (won) {
    const payout = ourBet === 'UP' ? finalUpPayout : finalDownPayout;
    const totalReturn = betSize * payout;
    bankroll += totalReturn;
    totalReturned += totalReturn;
    wins++;
  } else {
    losses++;
  }

  // Cap bankroll to prevent overflow
  if (bankroll > MAX_BANKROLL) bankroll = MAX_BANKROLL;
});

const winRate = (wins / totalBets * 100).toFixed(2);
const avgReturn = totalBets > 0 ? (totalReturned / totalWagered).toFixed(4) : 0;
const edge = totalBets > 0 ? ((totalReturned / totalWagered - 1) * 100).toFixed(2) : 0;
const roi = ((bankroll - 1) * 100).toFixed(2);

console.log('=== T-25s Crowd Strategy (≥55% threshold) ===');
console.log(`Total Bets:            ${totalBets}`);
console.log(`Wins / Losses:         ${wins} / ${losses}`);
console.log(`Win Rate:              ${winRate}%`);
console.log(`Total Wagered:         ${totalWagered.toFixed(4)} BNB`);
console.log(`Total Returned:        ${totalReturned.toFixed(4)} BNB`);
console.log(`Avg Return per BNB:    ${avgReturn} BNB`);
console.log(`Edge per bet:          ${edge}%`);
console.log(`\nStarting Bankroll:     1.00 BNB`);
console.log(`Ending Bankroll:       ${bankroll.toFixed(4)} BNB`);
console.log(`ROI:                   ${roi}%`);

db.close();
