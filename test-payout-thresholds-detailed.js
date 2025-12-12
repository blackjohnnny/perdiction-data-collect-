import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n📊 DETAILED PAYOUT THRESHOLD OPTIMIZATION\n');
console.log('═'.repeat(80) + '\n');

const db = initDatabase(DB_PATH);

const rounds = db.prepare(`
  SELECT
    sample_id,
    epoch,
    lock_timestamp,
    t20s_bull_wei,
    t20s_bear_wei,
    winner,
    winner_payout_multiple,
    ema_gap
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_gap IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Found ${rounds.length} complete rounds\n`);

// Constants
const STARTING_BANKROLL = 1.0;
const EMA_GAP_THRESHOLD = 0.05;
const MOMENTUM_THRESHOLD = 0.15;

// Position sizing
const BASE_SIZE = 0.045; // 4.5%
const MOMENTUM_SIZE = 0.085; // 8.5%
const RECOVERY_MULTIPLIER = 1.5;
const PROFIT_TAKING_SIZE = 0.045;

console.log('🎯 TESTING PAYOUT THRESHOLDS FROM 1.3x TO 2.5x\n');
console.log('═'.repeat(80) + '\n');

// Test comprehensive range of payout thresholds
const payoutThresholds = [
  1.30, 1.35, 1.40, 1.45, 1.50, 1.55, 1.60, 1.65, 1.70, 1.75,
  1.80, 1.85, 1.90, 1.95, 2.00, 2.10, 2.20, 2.30, 2.40, 2.50
];

const results = [];

for (const threshold of payoutThresholds) {
  let bankroll = STARTING_BANKROLL;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalProfit = 0;
  let maxBankroll = STARTING_BANKROLL;
  let maxDrawdown = 0;
  let lastTwoResults = [null, null];
  let profitTakingNext = false;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    // Get EMA side
    const emaGap = parseFloat(r.ema_gap);
    let betSide = null;
    if (emaGap > EMA_GAP_THRESHOLD) betSide = 'BULL';
    else if (emaGap < -EMA_GAP_THRESHOLD) betSide = 'BEAR';

    if (!betSide) continue;

    // Apply payout filter
    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;

    if (total === 0) continue;

    const estimatedPayout = betSide === 'BULL' ? (total / bullWei) : (total / bearWei);

    // Only bet when payout >= threshold (betting against crowd)
    if (estimatedPayout < threshold) continue;

    // Calculate bet size with dynamic positioning
    const hasMomentum = Math.abs(emaGap) > MOMENTUM_THRESHOLD;
    const lastResult = lastTwoResults[0];

    let betSize;
    if (profitTakingNext) {
      betSize = bankroll * PROFIT_TAKING_SIZE;
      profitTakingNext = false;
    } else if (lastResult === 'LOSS') {
      if (hasMomentum) {
        betSize = bankroll * MOMENTUM_SIZE * RECOVERY_MULTIPLIER;
      } else {
        betSize = bankroll * BASE_SIZE * RECOVERY_MULTIPLIER;
      }
    } else if (hasMomentum) {
      betSize = bankroll * MOMENTUM_SIZE;
    } else {
      betSize = bankroll * BASE_SIZE;
    }

    // Execute trade
    totalTrades++;
    const won = betSide === r.winner.toUpperCase();
    const payout = parseFloat(r.winner_payout_multiple);

    let tradePnL;
    if (won) {
      tradePnL = betSize * (payout - 1);
      wins++;
      lastTwoResults = ['WIN', lastTwoResults[0]];

      if (lastTwoResults[0] === 'WIN' && lastTwoResults[1] === 'WIN') {
        profitTakingNext = true;
      }
    } else {
      tradePnL = -betSize;
      losses++;
      lastTwoResults = ['LOSS', lastTwoResults[0]];
    }

    totalProfit += tradePnL;
    bankroll += tradePnL;

    // Track max bankroll and drawdown
    if (bankroll > maxBankroll) {
      maxBankroll = bankroll;
    }
    const currentDrawdown = (maxBankroll - bankroll) / maxBankroll;
    if (currentDrawdown > maxDrawdown) {
      maxDrawdown = currentDrawdown;
    }
  }

  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100) : 0;
  const roi = ((bankroll - STARTING_BANKROLL) / STARTING_BANKROLL) * 100;

  results.push({
    threshold,
    totalTrades,
    wins,
    losses,
    winRate,
    finalBankroll: bankroll,
    roi,
    maxDrawdown
  });
}

// Display results
console.log('📊 PAYOUT THRESHOLD OPTIMIZATION RESULTS:\n');
console.log('┌────────────┬────────┬──────────┬──────────────┬──────────────┬──────────────┐');
console.log('│ Threshold  │ Trades │ Win Rate │ Final Bank   │     ROI      │ Max Drawdown │');
console.log('├────────────┼────────┼──────────┼──────────────┼──────────────┼──────────────┤');

for (const r of results) {
  const threshold = r.threshold.toFixed(2) + 'x';
  const thresholdPadded = threshold.padStart(10);
  const trades = r.totalTrades.toString().padStart(6);
  const winRate = r.winRate.toFixed(2).padStart(7) + '%';
  const bankroll = r.finalBankroll.toFixed(4).padStart(12);
  const roi = (r.roi >= 0 ? '+' : '') + r.roi.toFixed(2).padStart(11) + '%';
  const drawdown = (r.maxDrawdown * 100).toFixed(2).padStart(11) + '%';

  console.log(`│ ${thresholdPadded} │ ${trades} │ ${winRate} │ ${bankroll} │ ${roi} │ ${drawdown} │`);
}

console.log('└────────────┴────────┴──────────┴──────────────┴──────────────┴──────────────┘');

console.log('\n' + '═'.repeat(100) + '\n');

// Find optimal thresholds
const bestROI = results.reduce((best, cur) => cur.roi > best.roi ? cur : best);
const bestBankroll = results.reduce((best, cur) => cur.finalBankroll > best.finalBankroll ? cur : best);
const bestWinRate = results.reduce((best, cur) => cur.winRate > best.winRate ? cur : best);
const bestTradeCount = results.reduce((best, cur) => cur.totalTrades > best.totalTrades ? cur : best);

// Best risk-adjusted (ROI per unit of drawdown)
const resultsWithRiskAdjusted = results.map(r => ({
  ...r,
  riskAdjusted: r.maxDrawdown > 0 ? r.roi / (r.maxDrawdown * 100) : 0
}));
const bestRiskAdjusted = resultsWithRiskAdjusted.reduce((best, cur) =>
  cur.riskAdjusted > best.riskAdjusted ? cur : best
);

console.log('🏆 TOP PERFORMERS:\n');

console.log('💰 Highest ROI:');
console.log(`  Threshold: ${bestROI.threshold.toFixed(2)}x`);
console.log(`  ROI: ${bestROI.roi.toFixed(2)}%`);
console.log(`  Final: ${bestROI.finalBankroll.toFixed(4)} BNB`);
console.log(`  Trades: ${bestROI.totalTrades} | Win Rate: ${bestROI.winRate.toFixed(2)}%`);
console.log(`  Max DD: ${(bestROI.maxDrawdown * 100).toFixed(2)}%\n`);

console.log('💎 Highest Final Bankroll:');
console.log(`  Threshold: ${bestBankroll.threshold.toFixed(2)}x`);
console.log(`  Final: ${bestBankroll.finalBankroll.toFixed(4)} BNB`);
console.log(`  ROI: ${bestBankroll.roi.toFixed(2)}%`);
console.log(`  Trades: ${bestBankroll.totalTrades} | Win Rate: ${bestBankroll.winRate.toFixed(2)}%`);
console.log(`  Max DD: ${(bestBankroll.maxDrawdown * 100).toFixed(2)}%\n`);

console.log('🎯 Highest Win Rate:');
console.log(`  Threshold: ${bestWinRate.threshold.toFixed(2)}x`);
console.log(`  Win Rate: ${bestWinRate.winRate.toFixed(2)}%`);
console.log(`  ROI: ${bestWinRate.roi.toFixed(2)}%`);
console.log(`  Trades: ${bestWinRate.totalTrades} | Final: ${bestWinRate.finalBankroll.toFixed(4)} BNB`);
console.log(`  Max DD: ${(bestWinRate.maxDrawdown * 100).toFixed(2)}%\n`);

console.log('📊 Most Trades:');
console.log(`  Threshold: ${bestTradeCount.threshold.toFixed(2)}x`);
console.log(`  Trades: ${bestTradeCount.totalTrades}`);
console.log(`  ROI: ${bestTradeCount.roi.toFixed(2)}%`);
console.log(`  Win Rate: ${bestTradeCount.winRate.toFixed(2)}% | Final: ${bestTradeCount.finalBankroll.toFixed(4)} BNB`);
console.log(`  Max DD: ${(bestTradeCount.maxDrawdown * 100).toFixed(2)}%\n`);

console.log('⚖️ Best Risk-Adjusted (ROI per % Drawdown):');
console.log(`  Threshold: ${bestRiskAdjusted.threshold.toFixed(2)}x`);
console.log(`  Risk-Adjusted Score: ${bestRiskAdjusted.riskAdjusted.toFixed(2)}`);
console.log(`  ROI: ${bestRiskAdjusted.roi.toFixed(2)}% | Max DD: ${(bestRiskAdjusted.maxDrawdown * 100).toFixed(2)}%`);
console.log(`  Trades: ${bestRiskAdjusted.totalTrades} | Win Rate: ${bestRiskAdjusted.winRate.toFixed(2)}%`);
console.log(`  Final: ${bestRiskAdjusted.finalBankroll.toFixed(4)} BNB\n`);

console.log('═'.repeat(100) + '\n');

// Grouping analysis
console.log('📈 THRESHOLD ANALYSIS:\n');

const lowThresholds = results.filter(r => r.threshold >= 1.3 && r.threshold < 1.6);
const midThresholds = results.filter(r => r.threshold >= 1.6 && r.threshold < 2.0);
const highThresholds = results.filter(r => r.threshold >= 2.0 && r.threshold <= 2.5);

const avgLow = lowThresholds.reduce((sum, r) => sum + r.roi, 0) / lowThresholds.length;
const avgMid = midThresholds.reduce((sum, r) => sum + r.roi, 0) / midThresholds.length;
const avgHigh = highThresholds.reduce((sum, r) => sum + r.roi, 0) / highThresholds.length;

console.log(`Low thresholds (1.3x - 1.6x):`);
console.log(`  Average ROI: ${avgLow.toFixed(2)}%`);
console.log(`  Average Trades: ${(lowThresholds.reduce((sum, r) => sum + r.totalTrades, 0) / lowThresholds.length).toFixed(0)}`);
console.log(`  Average Win Rate: ${(lowThresholds.reduce((sum, r) => sum + r.winRate, 0) / lowThresholds.length).toFixed(2)}%\n`);

console.log(`Mid thresholds (1.6x - 2.0x):`);
console.log(`  Average ROI: ${avgMid.toFixed(2)}%`);
console.log(`  Average Trades: ${(midThresholds.reduce((sum, r) => sum + r.totalTrades, 0) / midThresholds.length).toFixed(0)}`);
console.log(`  Average Win Rate: ${(midThresholds.reduce((sum, r) => sum + r.winRate, 0) / midThresholds.length).toFixed(2)}%\n`);

console.log(`High thresholds (2.0x - 2.5x):`);
console.log(`  Average ROI: ${avgHigh.toFixed(2)}%`);
console.log(`  Average Trades: ${(highThresholds.reduce((sum, r) => sum + r.totalTrades, 0) / highThresholds.length).toFixed(0)}`);
console.log(`  Average Win Rate: ${(highThresholds.reduce((sum, r) => sum + r.winRate, 0) / highThresholds.length).toFixed(2)}%\n`);

console.log('═'.repeat(100) + '\n');

console.log('💡 RECOMMENDATION:\n');

if (bestBankroll.threshold === bestROI.threshold) {
  console.log(`  🎯 Optimal threshold: ${bestBankroll.threshold.toFixed(2)}x`);
  console.log(`     (Best for both ROI and final bankroll)`);
} else {
  console.log(`  🎯 For maximum profit: ${bestBankroll.threshold.toFixed(2)}x (${bestBankroll.finalBankroll.toFixed(2)} BNB)`);
  console.log(`  🎯 For maximum ROI: ${bestROI.threshold.toFixed(2)}x (${bestROI.roi.toFixed(2)}%)`);
  console.log(`  🎯 For risk-adjusted: ${bestRiskAdjusted.threshold.toFixed(2)}x (score: ${bestRiskAdjusted.riskAdjusted.toFixed(2)})`);
}

console.log('\n═'.repeat(100) + '\n');

db.close();
