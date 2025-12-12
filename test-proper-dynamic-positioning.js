import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n📊 PROPER DYNAMIC POSITIONING TEST\n');
console.log('═'.repeat(80) + '\n');

const db = initDatabase(DB_PATH);

// Get all complete rounds with EMA data
const rounds = db.prepare(`
  SELECT
    sample_id,
    epoch,
    lock_timestamp,
    t20s_bull_wei,
    t20s_bear_wei,
    winner,
    winner_payout_multiple,
    ema_gap,
    ema_signal
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_gap IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Found ${rounds.length} complete rounds with TradingView EMA data\n`);

const STARTING_BANKROLL = 1.0;
const EMA_GAP_THRESHOLD = 0.05;
const MOMENTUM_THRESHOLD = 0.15; // Strong EMA = gap > 0.15%

// Position sizing rules
const BASE_SIZE = 0.045; // 4.5%
const MOMENTUM_SIZE = 0.085; // 8.5%
const RECOVERY_MULTIPLIER = 1.5; // After loss
const PROFIT_TAKING_SIZE = 0.045; // 4.5% (one trade only after 2 wins)

console.log('📋 DYNAMIC POSITIONING RULES:\n');
console.log(`  Base size: ${(BASE_SIZE * 100).toFixed(2)}% of bankroll`);
console.log(`  With momentum (gap > ${MOMENTUM_THRESHOLD}%): ${(MOMENTUM_SIZE * 100).toFixed(2)}% of bankroll`);
console.log(`  After loss (recovery): ${(BASE_SIZE * RECOVERY_MULTIPLIER * 100).toFixed(2)}% of bankroll`);
console.log(`  After loss + momentum: ${(MOMENTUM_SIZE * RECOVERY_MULTIPLIER * 100).toFixed(2)}% of bankroll`);
console.log(`  After 2 wins (profit taking): ${(PROFIT_TAKING_SIZE * 100).toFixed(2)}% (one trade only)\n`);
console.log('═'.repeat(80) + '\n');

// Test configurations
const tests = [
  {
    name: 'Pure EMA (Fixed 1% bet)',
    useDynamic: false,
    fixedSize: 0.01
  },
  {
    name: 'Pure EMA + Dynamic Positioning',
    useDynamic: true
  },
  {
    name: 'Payout > 1.5x + Dynamic Positioning',
    useDynamic: true,
    payoutFilter: 1.5
  },
  {
    name: 'Avoid Extreme Crowd (>90%) + Dynamic',
    useDynamic: true,
    avoidExtremeCrowd: 0.90
  },
  {
    name: 'Payout > 1.5x + Avoid Crowd >90% + Dynamic',
    useDynamic: true,
    payoutFilter: 1.5,
    avoidExtremeCrowd: 0.90
  }
];

const results = [];

for (const test of tests) {
  let bankroll = STARTING_BANKROLL;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalProfit = 0;
  let totalWagered = 0;
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

    // Apply filters
    if (test.payoutFilter || test.avoidExtremeCrowd) {
      const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
      const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
      const total = bullWei + bearWei;

      if (total === 0) continue;

      // Payout filter
      if (test.payoutFilter) {
        const payout = betSide === 'BULL' ? (total / bullWei) : (total / bearWei);
        if (payout < test.payoutFilter) continue;
      }

      // Extreme crowd filter
      if (test.avoidExtremeCrowd) {
        const bullPercent = bullWei / total;
        const bearPercent = bearWei / total;
        if (bullPercent >= test.avoidExtremeCrowd || bearPercent >= test.avoidExtremeCrowd) {
          continue;
        }
      }
    }

    // Calculate bet size
    let betSize;

    if (!test.useDynamic) {
      // Fixed bet size
      betSize = test.fixedSize;
    } else {
      // DYNAMIC POSITIONING
      const hasMomentum = Math.abs(emaGap) > MOMENTUM_THRESHOLD;
      const lastResult = lastTwoResults[0];
      const secondLastResult = lastTwoResults[1];

      if (profitTakingNext) {
        // After 2 wins: profit taking (4.5% for one trade)
        betSize = bankroll * PROFIT_TAKING_SIZE;
        profitTakingNext = false;
      } else if (lastResult === 'LOSS') {
        // After loss: recovery mode
        if (hasMomentum) {
          betSize = bankroll * MOMENTUM_SIZE * RECOVERY_MULTIPLIER; // 12.75%
        } else {
          betSize = bankroll * BASE_SIZE * RECOVERY_MULTIPLIER; // 6.75%
        }
      } else if (hasMomentum) {
        // Momentum: 8.5%
        betSize = bankroll * MOMENTUM_SIZE;
      } else {
        // Base: 4.5%
        betSize = bankroll * BASE_SIZE;
      }
    }

    // Execute trade
    totalTrades++;
    totalWagered += betSize;
    const won = betSide === r.winner.toUpperCase();
    const payout = parseFloat(r.winner_payout_multiple);

    let tradePnL;
    if (won) {
      tradePnL = betSize * (payout - 1);
      wins++;
      lastTwoResults = ['WIN', lastTwoResults[0]];

      // Check for 2 consecutive wins -> profit taking next trade
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

    // Track drawdown
    if (bankroll > maxBankroll) {
      maxBankroll = bankroll;
    }
    const currentDrawdown = (bankroll - maxBankroll) / maxBankroll;
    if (currentDrawdown < maxDrawdown) {
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
    totalProfit,
    finalBankroll: bankroll,
    roi,
    maxDrawdown,
    totalWagered
  });
}

// Display results
console.log('📊 RESULTS WITH PROPER DYNAMIC POSITIONING:\n');
console.log('┌──────────────────────────────────────────────┬────────┬──────────┬──────────────┬──────────┬──────────────┬──────────────┐');
console.log('│ Strategy                                     │ Trades │ Win Rate │ Final Bank   │   ROI    │ Max Drawdown │ Total Wagered│');
console.log('├──────────────────────────────────────────────┼────────┼──────────┼──────────────┼──────────┼──────────────┼──────────────┤');

for (const r of results) {
  const name = r.name.padEnd(44);
  const trades = r.totalTrades.toString().padStart(6);
  const winRate = r.winRate.toFixed(2).padStart(7) + '%';
  const bankroll = r.finalBankroll.toFixed(4).padStart(12);
  const roi = (r.roi >= 0 ? '+' : '') + r.roi.toFixed(2).padStart(7) + '%';
  const drawdown = (r.maxDrawdown * 100).toFixed(2).padStart(11) + '%';
  const wagered = r.totalWagered.toFixed(2).padStart(12);

  console.log(`│ ${name} │ ${trades} │ ${winRate} │ ${bankroll} │ ${roi} │ ${drawdown} │ ${wagered} │`);
}

console.log('└──────────────────────────────────────────────┴────────┴──────────┴──────────────┴──────────┴──────────────┴──────────────┘');

// Find best
const best = results.reduce((best, current) =>
  current.finalBankroll > best.finalBankroll ? current : best
, results[0]);

console.log('\n' + '═'.repeat(120) + '\n');
console.log('🏆 BEST PERFORMER:\n');
console.log(`  ${best.name}`);
console.log(`  Final Bankroll: ${best.finalBankroll.toFixed(4)} BNB (${best.roi.toFixed(2)}% ROI)`);
console.log(`  Win Rate: ${best.winRate.toFixed(2)}%`);
console.log(`  Trades: ${best.totalTrades}`);
console.log(`  Max Drawdown: ${(best.maxDrawdown * 100).toFixed(2)}%`);
console.log(`  Total Wagered: ${best.totalWagered.toFixed(2)} BNB`);

console.log('\n' + '═'.repeat(120) + '\n');

db.close();
