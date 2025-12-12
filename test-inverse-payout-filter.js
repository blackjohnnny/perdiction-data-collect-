import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🔄 INVERSE PAYOUT FILTER TEST - BET WITH CROWD (LOW PAYOUT)\n');
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

console.log('🎯 TESTING INVERSE LOGIC: Bet WITH crowd (low payout)\n');
console.log('  Original: Only bet when payout ≥ 1.5x (minority/underdog)');
console.log('  Inverse: Only bet when payout < X (majority/favorite)\n');
console.log('═'.repeat(80) + '\n');

// Test different payout thresholds (INVERSE - bet when payout is LESS than this)
const tests = [
  { name: 'Baseline: Pure EMA + Dynamic (No filter)', useDynamic: true, payoutFilter: null, inverse: false },
  { name: 'Original: Payout ≥ 1.5x (AGAINST crowd)', useDynamic: true, payoutFilter: 1.5, inverse: false },
  { name: 'Inverse: Payout < 1.5x (WITH crowd)', useDynamic: true, payoutFilter: 1.5, inverse: true },
  { name: 'Inverse: Payout < 1.4x (WITH crowd)', useDynamic: true, payoutFilter: 1.4, inverse: true },
  { name: 'Inverse: Payout < 1.6x (WITH crowd)', useDynamic: true, payoutFilter: 1.6, inverse: true },
  { name: 'Inverse: Payout < 1.7x (WITH crowd)', useDynamic: true, payoutFilter: 1.7, inverse: true },
  { name: 'Inverse: Payout < 1.8x (WITH crowd)', useDynamic: true, payoutFilter: 1.8, inverse: true },
  { name: 'Inverse: Payout < 2.0x (WITH crowd)', useDynamic: true, payoutFilter: 2.0, inverse: true },
  { name: 'Original: Payout ≥ 1.6x (AGAINST crowd)', useDynamic: true, payoutFilter: 1.6, inverse: false },
  { name: 'Original: Payout ≥ 1.7x (AGAINST crowd)', useDynamic: true, payoutFilter: 1.7, inverse: false },
  { name: 'Original: Payout ≥ 2.0x (AGAINST crowd)', useDynamic: true, payoutFilter: 2.0, inverse: false },
];

const results = [];

for (const test of tests) {
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
    if (test.payoutFilter !== null) {
      const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
      const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
      const total = bullWei + bearWei;

      if (total === 0) continue;

      const estimatedPayout = betSide === 'BULL' ? (total / bullWei) : (total / bearWei);

      if (test.inverse) {
        // INVERSE: Only bet when payout < threshold (betting WITH crowd/favorite)
        if (estimatedPayout >= test.payoutFilter) continue;
      } else {
        // ORIGINAL: Only bet when payout >= threshold (betting AGAINST crowd/underdog)
        if (estimatedPayout < test.payoutFilter) continue;
      }
    }

    // Calculate bet size with dynamic positioning
    let betSize;
    if (!test.useDynamic) {
      betSize = 0.01; // Fixed 1%
    } else {
      const hasMomentum = Math.abs(emaGap) > MOMENTUM_THRESHOLD;
      const lastResult = lastTwoResults[0];

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

      if (test.useDynamic && lastTwoResults[0] === 'WIN' && lastTwoResults[1] === 'WIN') {
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
    name: test.name,
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
console.log('📊 RESULTS - WITH CROWD vs AGAINST CROWD:\n');
console.log('┌────────────────────────────────────────────────┬────────┬──────────┬──────────────┬──────────────┬──────────────┐');
console.log('│ Strategy                                       │ Trades │ Win Rate │ Final Bank   │     ROI      │ Max Drawdown │');
console.log('├────────────────────────────────────────────────┼────────┼──────────┼──────────────┼──────────────┼──────────────┤');

for (const r of results) {
  const name = r.name.padEnd(46);
  const trades = r.totalTrades.toString().padStart(6);
  const winRate = r.winRate.toFixed(2).padStart(7) + '%';
  const bankroll = r.finalBankroll.toFixed(4).padStart(12);
  const roi = (r.roi >= 0 ? '+' : '') + r.roi.toFixed(2).padStart(11) + '%';
  const drawdown = (r.maxDrawdown * 100).toFixed(2).padStart(11) + '%';

  console.log(`│ ${name} │ ${trades} │ ${winRate} │ ${bankroll} │ ${roi} │ ${drawdown} │`);
}

console.log('└────────────────────────────────────────────────┴────────┴──────────┴──────────────┴──────────────┴──────────────┘');

console.log('\n' + '═'.repeat(120) + '\n');

// Separate results
const original = results.filter(r => r.name.includes('Original:') || r.name.includes('Baseline:'));
const inverse = results.filter(r => r.name.includes('Inverse:'));

console.log('🏆 BEST WITH CROWD (Inverse - Low Payout):\n');
const bestInverse = inverse.reduce((best, cur) => cur.finalBankroll > best.finalBankroll ? cur : best);
console.log(`  ${bestInverse.name}`);
console.log(`  Final: ${bestInverse.finalBankroll.toFixed(4)} BNB (${bestInverse.roi.toFixed(2)}% ROI)`);
console.log(`  Trades: ${bestInverse.totalTrades} | Win Rate: ${bestInverse.winRate.toFixed(2)}%`);
console.log(`  Max Drawdown: ${(bestInverse.maxDrawdown * 100).toFixed(2)}%\n`);

console.log('🏆 BEST AGAINST CROWD (Original - High Payout):\n');
const bestOriginal = original.filter(r => !r.name.includes('Baseline')).reduce((best, cur) => cur.finalBankroll > best.finalBankroll ? cur : best);
console.log(`  ${bestOriginal.name}`);
console.log(`  Final: ${bestOriginal.finalBankroll.toFixed(4)} BNB (${bestOriginal.roi.toFixed(2)}% ROI)`);
console.log(`  Trades: ${bestOriginal.totalTrades} | Win Rate: ${bestOriginal.winRate.toFixed(2)}%`);
console.log(`  Max Drawdown: ${(bestOriginal.maxDrawdown * 100).toFixed(2)}%\n`);

console.log('🏆 BASELINE (No Payout Filter):\n');
const baseline = results.find(r => r.name.includes('Baseline'));
console.log(`  ${baseline.name}`);
console.log(`  Final: ${baseline.finalBankroll.toFixed(4)} BNB (${baseline.roi.toFixed(2)}% ROI)`);
console.log(`  Trades: ${baseline.totalTrades} | Win Rate: ${baseline.winRate.toFixed(2)}%`);
console.log(`  Max Drawdown: ${(baseline.maxDrawdown * 100).toFixed(2)}%\n`);

console.log('═'.repeat(120) + '\n');

console.log('💡 KEY INSIGHTS:\n');

const inverseAvgROI = inverse.reduce((sum, r) => sum + r.roi, 0) / inverse.length;
const originalAvgROI = original.filter(r => !r.name.includes('Baseline')).reduce((sum, r) => sum + r.roi, 0) / (original.length - 1);

console.log(`  • Average ROI betting WITH crowd (inverse): ${inverseAvgROI.toFixed(2)}%`);
console.log(`  • Average ROI betting AGAINST crowd (original): ${originalAvgROI.toFixed(2)}%`);
console.log(`  • Difference: ${(originalAvgROI - inverseAvgROI).toFixed(2)}%\n`);

if (bestOriginal.finalBankroll > bestInverse.finalBankroll) {
  const improvement = ((bestOriginal.finalBankroll / bestInverse.finalBankroll - 1) * 100).toFixed(2);
  console.log(`  🎯 CONCLUSION: Betting AGAINST crowd is ${improvement}% more profitable!`);
} else {
  const improvement = ((bestInverse.finalBankroll / bestOriginal.finalBankroll - 1) * 100).toFixed(2);
  console.log(`  🎯 CONCLUSION: Betting WITH crowd is ${improvement}% more profitable!`);
}

console.log('\n═'.repeat(120) + '\n');

db.close();
