import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('   EMA 5/13 ONLY STRATEGY - ALL 50K+ ROUNDS');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('Loading all rounds with results...');

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

const INITIAL_BANKROLL = 1.0;
const BET_SIZE_PERCENT = 0.02;
const MAX_BANKROLL = 1000000; // Cap bankroll to prevent infinity

let bankroll = INITIAL_BANKROLL;
let totalBets = 0;
let wins = 0;
let losses = 0;
let totalWagered = 0;
let totalReturned = 0;

const snapshots = [];

console.log('Running simulation with bankroll cap of 1M BNB...');
console.log('Strategy: Bet in EMA direction (UP if EMA5>EMA13, DOWN otherwise)');
console.log('Position Size: 2% of bankroll per bet\n');

for (let i = 13; i < rounds.length; i++) {
  const round = rounds[i];

  const emaSignal = ema5[i] > ema13[i] ? 'UP' : 'DOWN';
  const ourBet = emaSignal;

  // Cap bankroll to prevent infinity
  if (bankroll > MAX_BANKROLL) {
    bankroll = MAX_BANKROLL;
  }

  const betSize = bankroll * BET_SIZE_PERCENT;
  totalWagered += betSize;

  bankroll -= betSize;
  totalBets++;

  const won = ourBet === round.winner;

  if (won) {
    const finalPayout = ourBet === 'UP' ? round.finalUpPayout : round.finalDownPayout;
    const totalReturn = betSize * finalPayout;
    bankroll += totalReturn;
    totalReturned += totalReturn;
    wins++;
  } else {
    losses++;
  }

  // Take snapshots every 5000 bets
  if (totalBets % 5000 === 0) {
    snapshots.push({
      bets: totalBets,
      bankroll: bankroll,
      wins: wins,
      losses: losses,
      winRate: (wins / totalBets) * 100
    });
    console.log(`  ${totalBets.toLocaleString()} bets: ${bankroll.toFixed(2)} BNB, Win Rate: ${((wins/totalBets)*100).toFixed(2)}%`);
  }
}

console.log(`  Completed ${totalBets.toLocaleString()} bets\n`);

// Results
console.log('═══════════════════════════════════════════════════════════════');
console.log('                     SIMULATION RESULTS');
console.log('═══════════════════════════════════════════════════════════════\n');

const winRate = (wins / totalBets) * 100;
const finalProfit = bankroll - INITIAL_BANKROLL;
const avgReturn = totalReturned / totalWagered;

console.log(`Starting Bankroll:     ${INITIAL_BANKROLL.toFixed(4)} BNB`);
console.log(`Final Bankroll:        ${bankroll >= MAX_BANKROLL ? `${MAX_BANKROLL.toFixed(0)}+ (capped)` : bankroll.toFixed(4)} BNB`);
console.log(`Net Profit/Loss:       ${finalProfit >= 0 ? '+' : ''}${finalProfit.toFixed(2)} BNB\n`);

console.log(`Total Bets:            ${totalBets.toLocaleString()}`);
console.log(`Wins / Losses:         ${wins.toLocaleString()} / ${losses.toLocaleString()}`);
console.log(`Win Rate:              ${winRate.toFixed(2)}%`);
console.log(`Expected from doc:     55.8% (EMA alone)\n`);

console.log(`Total Wagered:         ${totalWagered.toFixed(2)} BNB`);
console.log(`Total Returned:        ${totalReturned.toFixed(2)} BNB`);
console.log(`Avg Return per BNB:    ${avgReturn.toFixed(4)} BNB`);
console.log(`Edge per bet:          ${((avgReturn - 1) * 100).toFixed(2)}%\n`);

if (avgReturn > 1) {
  console.log(`✅ EMA-only strategy has POSITIVE EDGE!`);
  console.log(`   Every 1 BNB wagered returns ${avgReturn.toFixed(4)} BNB\n`);
} else {
  console.log(`❌ EMA-only strategy has NEGATIVE EDGE\n`);
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('BANKROLL GROWTH PROGRESSION');
console.log('═══════════════════════════════════════════════════════════════\n');

snapshots.forEach(snap => {
  console.log(`${snap.bets.toLocaleString().padStart(6)} bets: ${snap.bankroll.toFixed(2).padStart(12)} BNB (${snap.winRate.toFixed(2)}% win rate)`);
});

console.log('\n═══════════════════════════════════════════════════════════════\n');
