import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('   EMA 5/13 + T-20s CROWD CONFIRMATION STRATEGY (CORRECT)');
console.log('═══════════════════════════════════════════════════════════════\n');

// Get all rounds with T-20s snapshots and final results
const query = `
  SELECT
    r.epoch,
    r.winner,
    r.close_price,
    r.lock_price,
    s.implied_up_multiple,
    s.implied_down_multiple,
    s.bull_amount_wei,
    s.bear_amount_wei,
    s.total_amount_wei
  FROM rounds r
  JOIN snapshots s ON r.epoch = s.epoch
  WHERE r.winner IN ('UP', 'DOWN')
    AND s.snapshot_type = 'T_MINUS_20S'
  ORDER BY r.epoch ASC
`;

const stmt = db.prepare(query);
const rounds = [];
while (stmt.step()) {
  const row = stmt.getAsObject();
  rounds.push({
    epoch: row.epoch,
    winner: row.winner,
    closePrice: BigInt(row.close_price),
    lockPrice: BigInt(row.lock_price),
    impliedUp: row.implied_up_multiple,
    impliedDown: row.implied_down_multiple,
    bullAmount: BigInt(row.bull_amount_wei),
    bearAmount: BigInt(row.bear_amount_wei),
    totalAmount: BigInt(row.total_amount_wei)
  });
}
stmt.free();
db.close();

console.log(`📊 Total rounds with T-20s + results: ${rounds.length}\n`);

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

const closePrices = rounds.map(r => Number(r.closePrice) / 1e8);
const ema5 = calculateEMA(closePrices, 5);
const ema13 = calculateEMA(closePrices, 13);

// Strategy parameters
const INITIAL_BANKROLL = 1.0; // 1 BNB
const BET_SIZE_PERCENT = 0.02; // 2% of bankroll per bet

let bankroll = INITIAL_BANKROLL;
let totalBets = 0;
let wins = 0;
let losses = 0;
let skippedRounds = 0;
const history = [];

console.log('Strategy Rules (From STRATEGY-FINDINGS.md):');
console.log('  1. EMA 5/13 signals direction (UP if EMA5>EMA13, DOWN otherwise)');
console.log('  2. T-20s crowd CONFIRMS same direction (55% OR 70% threshold)');
console.log('  3. Bet WITH both EMA and crowd when they AGREE');
console.log('  4. Position Size: 2% of current bankroll per bet\n');
console.log(`${'─'.repeat(63)}\n`);

for (let i = 13; i < rounds.length; i++) { // Start after EMA13 warmup
  const round = rounds[i];

  // EMA signal
  const emaSignal = ema5[i] > ema13[i] ? 'UP' : 'DOWN';

  // T-20s crowd position (where more money is)
  const crowdFavorite = round.bullAmount > round.bearAmount ? 'UP' : 'DOWN';

  // Calculate crowd percentage
  const bullPct = Number(round.bullAmount * 10000n / round.totalAmount) / 100;
  const bearPct = Number(round.bearAmount * 10000n / round.totalAmount) / 100;
  const crowdPct = Math.max(bullPct, bearPct);

  // Check if crowd meets threshold (55% or 70%)
  const meets55 = crowdPct >= 55;
  const meets70 = crowdPct >= 70;

  if (!meets55) {
    skippedRounds++;
    continue;
  }

  // CRITICAL: Only bet when EMA and crowd AGREE
  if (emaSignal !== crowdFavorite) {
    skippedRounds++;
    continue;
  }

  // Our bet: WITH both EMA and crowd
  const ourBet = emaSignal;
  const payout = ourBet === 'UP' ? round.impliedUp : round.impliedDown;

  // Place bet
  const betSize = bankroll * BET_SIZE_PERCENT;
  const won = ourBet === round.winner;

  totalBets++;

  // Remove bet from bankroll first
  bankroll -= betSize;

  if (won) {
    const totalReturn = betSize * payout;
    bankroll += totalReturn;
    const netProfit = totalReturn - betSize;
    wins++;
    history.push({
      epoch: round.epoch,
      bet: ourBet,
      result: 'WIN',
      betSize: betSize.toFixed(4),
      profit: netProfit.toFixed(4),
      bankroll: bankroll.toFixed(4),
      payout: payout.toFixed(2),
      crowdPct: crowdPct.toFixed(1)
    });
  } else {
    losses++;
    history.push({
      epoch: round.epoch,
      bet: ourBet,
      result: 'LOSS',
      betSize: betSize.toFixed(4),
      profit: (-betSize).toFixed(4),
      bankroll: bankroll.toFixed(4),
      payout: payout.toFixed(2),
      crowdPct: crowdPct.toFixed(1)
    });
  }
}

// Results
console.log('═══════════════════════════════════════════════════════════════');
console.log('                     SIMULATION RESULTS');
console.log('═══════════════════════════════════════════════════════════════\n');

const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;
const finalProfit = bankroll - INITIAL_BANKROLL;
const roi = ((bankroll - INITIAL_BANKROLL) / INITIAL_BANKROLL) * 100;

console.log(`Starting Bankroll:     ${INITIAL_BANKROLL.toFixed(4)} BNB`);
console.log(`Final Bankroll:        ${bankroll.toFixed(4)} BNB`);
console.log(`Net Profit/Loss:       ${finalProfit >= 0 ? '+' : ''}${finalProfit.toFixed(4)} BNB`);
console.log(`ROI:                   ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%\n`);

console.log(`Total Rounds:          ${rounds.length - 13} (after EMA warmup)`);
console.log(`Bets Placed:           ${totalBets}`);
console.log(`Rounds Skipped:        ${skippedRounds}`);
console.log(`Wins / Losses:         ${wins} / ${losses}`);
console.log(`Win Rate:              ${winRate.toFixed(2)}%`);
console.log(`Expected from doc:     65.9%\n`);

if (winRate >= 65) {
  console.log('✅ Win rate matches strategy document! 🎯\n');
} else if (roi > 0) {
  console.log('✅ PROFITABLE but win rate differs from document\n');
} else {
  console.log('❌ Strategy not profitable on this dataset\n');
}

// Show sample trades
console.log('═══════════════════════════════════════════════════════════════');
console.log('                   SAMPLE TRADES (First 10)');
console.log('═══════════════════════════════════════════════════════════════\n');

history.slice(0, 10).forEach((h, i) => {
  console.log(`${i + 1}. Epoch ${h.epoch}: ${h.result} (${h.bet}) Crowd:${h.crowdPct}% | Bet: ${h.betSize} | P/L: ${h.profit} | Bankroll: ${h.bankroll}`);
});

if (history.length > 20) {
  console.log('\n...\n');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                   SAMPLE TRADES (Last 10)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  history.slice(-10).forEach((h, i) => {
    console.log(`${history.length - 10 + i + 1}. Epoch ${h.epoch}: ${h.result} (${h.bet}) Crowd:${h.crowdPct}% | Bet: ${h.betSize} | P/L: ${h.profit} | Bankroll: ${h.bankroll}`);
  });
}

console.log('\n═══════════════════════════════════════════════════════════════\n');
