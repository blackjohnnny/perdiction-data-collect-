import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('   EMA GAP THRESHOLD TEST - 113 T-20s SNAPSHOTS');
console.log('═══════════════════════════════════════════════════════════════\n');

// Get all rounds with T-20s snapshots and final results
const query = `
  SELECT
    r.epoch,
    r.winner,
    r.close_price,
    r.lock_price,
    r.total_amount_wei as final_total,
    r.bull_amount_wei as final_bull,
    r.bear_amount_wei as final_bear,
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
    t20BullAmount: BigInt(row.t20_bull),
    t20BearAmount: BigInt(row.t20_bear),
    t20TotalAmount: BigInt(row.t20_total),
    finalUpPayout: finalUpMultiple,
    finalDownPayout: finalDownMultiple
  });
}
stmt.free();
db.close();

console.log(`📊 Total rounds: ${rounds.length}\n`);

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

// Test different gap thresholds
const gapThresholds = [0, 0.25, 0.5, 1.0, 2.0];

console.log('═══════════════════════════════════════════════════════════════');
console.log('TESTING EMA GAP THRESHOLDS');
console.log('═══════════════════════════════════════════════════════════════\n');

const results = [];

for (const gapThreshold of gapThresholds) {
  const INITIAL_BANKROLL = 1.0;
  const BET_SIZE_PERCENT = 0.02;

  let bankroll = INITIAL_BANKROLL;
  let totalBets = 0;
  let wins = 0;
  let losses = 0;
  let skippedByGap = 0;
  let skippedByCrowd = 0;

  for (let i = 13; i < rounds.length; i++) {
    const round = rounds[i];

    // Calculate EMA gap
    const emaGap = Math.abs(ema5[i] - ema13[i]);
    const emaSignal = ema5[i] > ema13[i] ? 'UP' : 'DOWN';

    // Check gap threshold
    if (emaGap < gapThreshold) {
      skippedByGap++;
      continue;
    }

    // T-20s crowd
    const t20CrowdFavorite = round.t20BullAmount > round.t20BearAmount ? 'UP' : 'DOWN';
    const t20BullPct = Number(round.t20BullAmount * 10000n / round.t20TotalAmount) / 100;
    const t20BearPct = Number(round.t20BearAmount * 10000n / round.t20TotalAmount) / 100;
    const t20CrowdPct = Math.max(t20BullPct, t20BearPct);

    // Check 55% threshold
    if (t20CrowdPct < 55) {
      skippedByCrowd++;
      continue;
    }

    // EMA and crowd must AGREE
    if (emaSignal !== t20CrowdFavorite) {
      skippedByCrowd++;
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

  results.push({
    gapThreshold,
    totalBets,
    wins,
    losses,
    winRate,
    bankroll,
    roi,
    skippedByGap,
    skippedByCrowd
  });
}

// Display results
for (const result of results) {
  console.log(`\nGap Threshold: ≥${result.gapThreshold.toFixed(2)}`);
  console.log('─'.repeat(63));
  console.log(`Bets Placed:       ${result.totalBets}`);
  console.log(`Wins / Losses:     ${result.wins} / ${result.losses}`);
  console.log(`Win Rate:          ${result.winRate.toFixed(2)}%`);
  console.log(`Skipped by gap:    ${result.skippedByGap}`);
  console.log(`Skipped by crowd:  ${result.skippedByCrowd}`);
  console.log(`Final Bankroll:    ${result.bankroll.toFixed(4)} BNB`);
  console.log(`Net Profit:        ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(2)}%`);

  if (result.gapThreshold > 0) {
    const baseline = results[0];
    const winRateDiff = result.winRate - baseline.winRate;
    const roiDiff = result.roi - baseline.roi;

    if (roiDiff > 0) {
      console.log(`✅ Better: Win rate ${winRateDiff >= 0 ? '+' : ''}${winRateDiff.toFixed(2)}%, ROI ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}%`);
    } else {
      console.log(`❌ Worse: Win rate ${winRateDiff >= 0 ? '+' : ''}${winRateDiff.toFixed(2)}%, ROI ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}%`);
    }
  }
}

// Find best
const bestByROI = results.reduce((best, curr) =>
  curr.roi > best.roi ? curr : best
);

const bestByWinRate = results.reduce((best, curr) =>
  curr.winRate > best.winRate ? curr : best
);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('CONCLUSION');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`🏆 Best ROI: Gap ≥${bestByROI.gapThreshold.toFixed(2)}`);
console.log(`   ${bestByROI.totalBets} bets, ${bestByROI.winRate.toFixed(2)}% win rate, ${bestByROI.roi >= 0 ? '+' : ''}${bestByROI.roi.toFixed(2)}% ROI\n`);

console.log(`🎯 Best Win Rate: Gap ≥${bestByWinRate.gapThreshold.toFixed(2)}`);
console.log(`   ${bestByWinRate.totalBets} bets, ${bestByWinRate.winRate.toFixed(2)}% win rate, ${bestByWinRate.roi >= 0 ? '+' : ''}${bestByWinRate.roi.toFixed(2)}% ROI\n`);

if (bestByROI.gapThreshold === 0) {
  console.log('❌ Gap threshold doesn\'t improve performance on 113 snapshots');
  console.log('   Stick with original strategy (no gap filter)\n');
} else {
  console.log(`✅ Gap threshold ≥${bestByROI.gapThreshold.toFixed(2)} improves performance!`);
  console.log(`   Recommended for live trading\n`);
}

console.log('═══════════════════════════════════════════════════════════════\n');
