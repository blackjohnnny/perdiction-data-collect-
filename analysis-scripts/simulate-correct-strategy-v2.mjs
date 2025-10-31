import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('   EMA 5/13 + T-20s CROWD CONFIRMATION - FINAL PAYOUT');
console.log('═══════════════════════════════════════════════════════════════\n');

// Get all rounds with T-20s snapshots and final results with FINAL payouts
const query = `
  SELECT
    r.epoch,
    r.winner,
    r.close_price,
    r.lock_price,
    r.total_amount_wei as final_total,
    r.bull_amount_wei as final_bull,
    r.bear_amount_wei as final_bear,
    s.implied_up_multiple as t20_up,
    s.implied_down_multiple as t20_down,
    s.bull_amount_wei as t20_bull,
    s.bear_amount_wei as t20_bear,
    s.total_amount_wei as t20_total
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

  // Calculate FINAL payouts (what we actually get when we win)
  const finalBull = BigInt(row.final_bull);
  const finalBear = BigInt(row.final_bear);
  const finalTotal = BigInt(row.final_total);

  const finalUpMultiple = Number(finalTotal * 100n / finalBull) / 100;
  const finalDownMultiple = Number(finalTotal * 100n / finalBear) / 100;

  rounds.push({
    epoch: row.epoch,
    winner: row.winner,
    closePrice: BigInt(row.close_price),
    lockPrice: BigInt(row.lock_price),
    // T-20s data (for decision)
    t20UpPayout: row.t20_up,
    t20DownPayout: row.t20_down,
    t20BullAmount: BigInt(row.t20_bull),
    t20BearAmount: BigInt(row.t20_bear),
    t20TotalAmount: BigInt(row.t20_total),
    // FINAL data (for actual payout)
    finalUpPayout: finalUpMultiple,
    finalDownPayout: finalDownMultiple,
    finalBullAmount: finalBull,
    finalBearAmount: finalBear,
    finalTotalAmount: finalTotal
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

console.log('Strategy Rules:');
console.log('  1. DECIDE at T-20s: EMA 5/13 + Crowd ≥55% must AGREE');
console.log('  2. EXECUTE: Place bet on agreed direction');
console.log('  3. SETTLE: Get FINAL payout based on close pool state');
console.log('  4. Position Size: 2% of current bankroll per bet\n');
console.log(`${'─'.repeat(63)}\n`);

for (let i = 13; i < rounds.length; i++) {
  const round = rounds[i];

  // === DECISION PHASE (at T-20s) ===
  const emaSignal = ema5[i] > ema13[i] ? 'UP' : 'DOWN';
  const t20CrowdFavorite = round.t20BullAmount > round.t20BearAmount ? 'UP' : 'DOWN';

  const t20BullPct = Number(round.t20BullAmount * 10000n / round.t20TotalAmount) / 100;
  const t20BearPct = Number(round.t20BearAmount * 10000n / round.t20TotalAmount) / 100;
  const t20CrowdPct = Math.max(t20BullPct, t20BearPct);

  // Check if crowd meets 55% threshold
  if (t20CrowdPct < 55) {
    skippedRounds++;
    continue;
  }

  // Only bet when EMA and T-20s crowd AGREE
  if (emaSignal !== t20CrowdFavorite) {
    skippedRounds++;
    continue;
  }

  // === EXECUTION PHASE ===
  const ourBet = emaSignal; // Bet with both EMA and crowd
  const betSize = bankroll * BET_SIZE_PERCENT;

  // Remove bet from bankroll
  bankroll -= betSize;
  totalBets++;

  // === SETTLEMENT PHASE (at close) ===
  const won = ourBet === round.winner;

  if (won) {
    // Use FINAL payout, not T-20s payout
    const finalPayout = ourBet === 'UP' ? round.finalUpPayout : round.finalDownPayout;
    const totalReturn = betSize * finalPayout;
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
      t20Payout: (ourBet === 'UP' ? round.t20UpPayout : round.t20DownPayout).toFixed(2),
      finalPayout: finalPayout.toFixed(2),
      crowdPct: t20CrowdPct.toFixed(1)
    });
  } else {
    losses++;
    const finalPayout = ourBet === 'UP' ? round.finalUpPayout : round.finalDownPayout;

    history.push({
      epoch: round.epoch,
      bet: ourBet,
      result: 'LOSS',
      betSize: betSize.toFixed(4),
      profit: (-betSize).toFixed(4),
      bankroll: bankroll.toFixed(4),
      t20Payout: (ourBet === 'UP' ? round.t20UpPayout : round.t20DownPayout).toFixed(2),
      finalPayout: finalPayout.toFixed(2),
      crowdPct: t20CrowdPct.toFixed(1)
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

if (roi > 0) {
  console.log('✅ PROFITABLE STRATEGY! 🎯\n');
} else {
  console.log('❌ Strategy losing money despite win rate\n');
}

// Show sample trades
console.log('═══════════════════════════════════════════════════════════════');
console.log('                   SAMPLE TRADES (First 10)');
console.log('═══════════════════════════════════════════════════════════════\n');
console.log('Format: Epoch | Result | Bet | Crowd% | T20→Final Payout | P/L | Bankroll\n');

history.slice(0, 10).forEach((h, i) => {
  console.log(`${i + 1}. ${h.epoch}: ${h.result} (${h.bet}) Crowd:${h.crowdPct}% | ${h.t20Payout}x→${h.finalPayout}x | P/L:${h.profit} | ${h.bankroll} BNB`);
});

if (history.length > 20) {
  console.log('\n...\n');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                   SAMPLE TRADES (Last 10)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  history.slice(-10).forEach((h, i) => {
    console.log(`${history.length - 10 + i + 1}. ${h.epoch}: ${h.result} (${h.bet}) Crowd:${h.crowdPct}% | ${h.t20Payout}x→${h.finalPayout}x | P/L:${h.profit} | ${h.bankroll} BNB`);
  });
}

console.log('\n═══════════════════════════════════════════════════════════════\n');
