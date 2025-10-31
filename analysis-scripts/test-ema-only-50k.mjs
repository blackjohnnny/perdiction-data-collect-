import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('   EMA 5/13 ONLY STRATEGY - ALL 50K+ ROUNDS');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('Loading all rounds with results...');

// Get ALL rounds with results (no snapshot requirement)
const query = `
  SELECT
    epoch,
    winner,
    close_price,
    lock_price,
    total_amount_wei,
    bull_amount_wei,
    bear_amount_wei
  FROM rounds
  WHERE winner IN ('UP', 'DOWN')
    AND close_price > 0
  ORDER BY epoch ASC
`;

const stmt = db.prepare(query);
const rounds = [];
while (stmt.step()) {
  const row = stmt.getAsObject();

  const finalBull = BigInt(row.bull_amount_wei);
  const finalBear = BigInt(row.bear_amount_wei);
  const finalTotal = BigInt(row.total_amount_wei);

  // Calculate final payouts
  const finalUpMultiple = finalBull > 0n ? Number(finalTotal * 100n / finalBull) / 100 : 0;
  const finalDownMultiple = finalBear > 0n ? Number(finalTotal * 100n / finalBear) / 100 : 0;

  rounds.push({
    epoch: row.epoch,
    winner: row.winner,
    closePrice: BigInt(row.close_price),
    lockPrice: BigInt(row.lock_price),
    finalUpPayout: finalUpMultiple,
    finalDownPayout: finalDownMultiple
  });
}
stmt.free();
db.close();

console.log(`✓ Loaded ${rounds.length} rounds\n`);

// Calculate EMA
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = [];
  ema[0] = prices[0];

  for (let i = 1; i < prices.length; i++) {
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }

  return ema;
}

console.log('Calculating EMA 5/13...');
const closePrices = rounds.map(r => Number(r.closePrice) / 1e8);
const ema5 = calculateEMA(closePrices, 5);
const ema13 = calculateEMA(closePrices, 13);
console.log('✓ EMA calculated\n');

// Strategy parameters
const INITIAL_BANKROLL = 1.0;
const BET_SIZE_PERCENT = 0.02;

let bankroll = INITIAL_BANKROLL;
let totalBets = 0;
let wins = 0;
let losses = 0;

console.log('Running simulation...');
console.log('Strategy: Bet in EMA direction (UP if EMA5>EMA13, DOWN otherwise)');
console.log('Position Size: 2% of bankroll per bet\n');

// Start after EMA13 warmup
for (let i = 13; i < rounds.length; i++) {
  const round = rounds[i];

  // EMA signal - this is our ONLY signal
  const emaSignal = ema5[i] > ema13[i] ? 'UP' : 'DOWN';

  // Place bet
  const ourBet = emaSignal;
  const betSize = bankroll * BET_SIZE_PERCENT;

  bankroll -= betSize;
  totalBets++;

  const won = ourBet === round.winner;

  if (won) {
    const finalPayout = ourBet === 'UP' ? round.finalUpPayout : round.finalDownPayout;
    const totalReturn = betSize * finalPayout;
    bankroll += totalReturn;
    wins++;
  } else {
    losses++;
  }

  // Progress indicator
  if (totalBets % 5000 === 0) {
    console.log(`  Processed ${totalBets.toLocaleString()} bets...`);
  }
}

console.log(`  Completed ${totalBets.toLocaleString()} bets\n`);

// Results
console.log('═══════════════════════════════════════════════════════════════');
console.log('                     SIMULATION RESULTS');
console.log('═══════════════════════════════════════════════════════════════\n');

const winRate = (wins / totalBets) * 100;
const finalProfit = bankroll - INITIAL_BANKROLL;
const roi = ((bankroll - INITIAL_BANKROLL) / INITIAL_BANKROLL) * 100;

console.log(`Starting Bankroll:     ${INITIAL_BANKROLL.toFixed(4)} BNB`);
console.log(`Final Bankroll:        ${bankroll.toFixed(4)} BNB`);
console.log(`Net Profit/Loss:       ${finalProfit >= 0 ? '+' : ''}${finalProfit.toFixed(4)} BNB`);
console.log(`ROI:                   ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%\n`);

console.log(`Total Rounds:          ${rounds.length.toLocaleString()}`);
console.log(`Bets Placed:           ${totalBets.toLocaleString()} (after EMA warmup)`);
console.log(`Wins / Losses:         ${wins.toLocaleString()} / ${losses.toLocaleString()}`);
console.log(`Win Rate:              ${winRate.toFixed(2)}%`);
console.log(`Expected from doc:     55.8% (EMA alone)\n`);

if (roi > 0) {
  console.log('✅ EMA-only strategy is PROFITABLE!\n');
} else {
  console.log('❌ EMA-only strategy LOSES money\n');
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('COMPARISON TO STRATEGY DOC');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('From 113 T-20s snapshots:');
console.log('  EMA alone:         55.8% win rate');
console.log('  EMA + Crowd:       65.5% win rate');
console.log('  Improvement:       +9.7%\n');

console.log('From 50K+ rounds (this test):');
console.log(`  EMA alone:         ${winRate.toFixed(1)}% win rate`);
console.log(`  ROI:               ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%\n`);

if (winRate > 52) {
  console.log('✅ EMA has edge even without crowd confirmation!');
  console.log('   But adding crowd would likely improve it further.\n');
} else {
  console.log('❌ EMA alone is not enough to beat house edge consistently.\n');
}

console.log('═══════════════════════════════════════════════════════════════\n');
