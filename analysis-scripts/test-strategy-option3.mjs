import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('   OPTION 3: TIME-BASED FILTERING STRATEGY');
console.log('═══════════════════════════════════════════════════════════════\n');

// Get all rounds with T-20s snapshots and final results
const query = `
  SELECT
    r.epoch,
    r.winner,
    r.close_price,
    r.lock_price,
    r.lock_ts,
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

  // Calculate FINAL payouts
  const finalBull = BigInt(row.final_bull);
  const finalBear = BigInt(row.final_bear);
  const finalTotal = BigInt(row.final_total);

  const finalUpMultiple = Number(finalTotal * 100n / finalBull) / 100;
  const finalDownMultiple = Number(finalTotal * 100n / finalBear) / 100;

  // Get hour from lock timestamp
  const lockDate = new Date(row.lock_ts * 1000);
  const hour = lockDate.getUTCHours();

  rounds.push({
    epoch: row.epoch,
    winner: row.winner,
    hour: hour,
    closePrice: BigInt(row.close_price),
    lockPrice: BigInt(row.lock_price),
    t20BullAmount: BigInt(row.t20_bull),
    t20BearAmount: BigInt(row.t20_bear),
    t20TotalAmount: BigInt(row.t20_total),
    finalUpPayout: finalUpMultiple,
    finalDownPayout: finalDownMultiple,
    finalTotalBNB: Number(finalTotal) / 1e18
  });
}
stmt.free();
db.close();

console.log(`📊 Total rounds analyzed: ${rounds.length}\n`);

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

// Best hours from strategy doc: 20, 21, 23, 0 UTC
const BEST_HOURS = [20, 21, 23, 0];

function runStrategy(name, hourFilter, rounds, ema5, ema13) {
  const INITIAL_BANKROLL = 1.0;
  const BET_SIZE_PERCENT = 0.02;

  let bankroll = INITIAL_BANKROLL;
  let totalBets = 0;
  let wins = 0;
  let losses = 0;
  let skippedRounds = 0;

  for (let i = 13; i < rounds.length; i++) {
    const round = rounds[i];

    // Time filter
    if (hourFilter && !hourFilter.includes(round.hour)) {
      skippedRounds++;
      continue;
    }

    // EMA signal
    const emaSignal = ema5[i] > ema13[i] ? 'UP' : 'DOWN';

    // T-20s crowd
    const t20CrowdFavorite = round.t20BullAmount > round.t20BearAmount ? 'UP' : 'DOWN';

    // Crowd percentage
    const t20BullPct = Number(round.t20BullAmount * 10000n / round.t20TotalAmount) / 100;
    const t20BearPct = Number(round.t20BearAmount * 10000n / round.t20TotalAmount) / 100;
    const t20CrowdPct = Math.max(t20BullPct, t20BearPct);

    // Check 55% threshold
    if (t20CrowdPct < 55) {
      skippedRounds++;
      continue;
    }

    // EMA and crowd must AGREE
    if (emaSignal !== t20CrowdFavorite) {
      skippedRounds++;
      continue;
    }

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
  }

  const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;
  const finalProfit = bankroll - INITIAL_BANKROLL;
  const roi = ((bankroll - INITIAL_BANKROLL) / INITIAL_BANKROLL) * 100;

  return {
    name,
    bankroll,
    finalProfit,
    roi,
    totalBets,
    wins,
    losses,
    winRate,
    skippedRounds
  };
}

// Test different strategies
console.log('═══════════════════════════════════════════════════════════════');
console.log('TESTING DIFFERENT TIME FILTERS');
console.log('═══════════════════════════════════════════════════════════════\n');

const strategies = [
  { name: 'Original (All Hours)', filter: null },
  { name: 'Best Hours Only (20,21,23,0 UTC)', filter: BEST_HOURS },
  { name: 'Evening Only (20-23 UTC)', filter: [20, 21, 22, 23] },
  { name: 'Midnight Only (0 UTC)', filter: [0] },
  { name: 'Peak Hours (12-16 UTC)', filter: [12, 13, 14, 15, 16] }
];

const results = [];

for (const strat of strategies) {
  const result = runStrategy(strat.name, strat.filter, rounds, ema5, ema13);
  results.push(result);
}

// Display results
for (const result of results) {
  console.log(`\n${result.name}`);
  console.log('─'.repeat(63));
  console.log(`Bets Placed:       ${result.totalBets}`);
  console.log(`Wins / Losses:     ${result.wins} / ${result.losses}`);
  console.log(`Win Rate:          ${result.winRate.toFixed(2)}%`);
  console.log(`Final Bankroll:    ${result.bankroll.toFixed(4)} BNB`);
  console.log(`Net Profit:        ${result.finalProfit >= 0 ? '+' : ''}${result.finalProfit.toFixed(4)} BNB`);
  console.log(`ROI:               ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(2)}%`);

  if (result.roi > results[0].roi) {
    console.log(`✅ +${(result.roi - results[0].roi).toFixed(2)}% better than original!`);
  }
}

// Find best strategy
const bestStrategy = results.reduce((best, curr) =>
  curr.roi > best.roi ? curr : best
);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('CONCLUSION');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`🏆 Best Strategy: ${bestStrategy.name}`);
console.log(`   Win Rate: ${bestStrategy.winRate.toFixed(2)}%`);
console.log(`   ROI: ${bestStrategy.roi >= 0 ? '+' : ''}${bestStrategy.roi.toFixed(2)}%`);
console.log(`   Bets: ${bestStrategy.totalBets}\n`);

if (bestStrategy.name !== 'Original (All Hours)') {
  console.log(`✅ Time filtering IMPROVES the strategy!`);
  console.log(`   Improvement: +${(bestStrategy.roi - results[0].roi).toFixed(2)}% ROI`);
} else {
  console.log(`❌ Time filtering doesn't improve the strategy`);
  console.log(`   Stick with original (bet all qualifying hours)`);
}

console.log('\n═══════════════════════════════════════════════════════════════\n');
