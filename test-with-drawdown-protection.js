import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🛡️ STRATEGY TEST WITH DRAWDOWN PROTECTION\n');
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

// Drawdown protection
const DRAWDOWN_LIMITS = [null, 0.10, 0.15, 0.20, 0.25]; // null = no limit

console.log('🛡️ TESTING WITH DIFFERENT DRAWDOWN LIMITS:\n');
console.log('  • No limit: Trade continuously');
console.log('  • 10% limit: Stop if down 10% from peak');
console.log('  • 15% limit: Stop if down 15% from peak');
console.log('  • 20% limit: Stop if down 20% from peak');
console.log('  • 25% limit: Stop if down 25% from peak\n');

console.log('═'.repeat(80) + '\n');

const tests = [
  { name: 'Pure EMA (Fixed 1%)', useDynamic: false, fixedSize: 0.01, drawdownLimit: null },
  { name: 'Pure EMA + Dynamic', useDynamic: true, drawdownLimit: null },
  { name: 'Pure EMA + Dynamic + 10% DD', useDynamic: true, drawdownLimit: 0.10 },
  { name: 'Pure EMA + Dynamic + 15% DD', useDynamic: true, drawdownLimit: 0.15 },
  { name: 'Pure EMA + Dynamic + 20% DD', useDynamic: true, drawdownLimit: 0.20 },
  { name: 'Payout >1.5x + Dynamic (No DD)', useDynamic: true, payoutFilter: 1.5, drawdownLimit: null },
  { name: 'Payout >1.5x + Dynamic + 10% DD', useDynamic: true, payoutFilter: 1.5, drawdownLimit: 0.10 },
  { name: 'Payout >1.5x + Dynamic + 15% DD', useDynamic: true, payoutFilter: 1.5, drawdownLimit: 0.15 },
  { name: 'Payout >1.5x + Dynamic + 20% DD', useDynamic: true, payoutFilter: 1.5, drawdownLimit: 0.20 },
  { name: 'Payout >1.5x + Crowd <90% + Dyn (No DD)', useDynamic: true, payoutFilter: 1.5, avoidExtremeCrowd: 0.90, drawdownLimit: null },
  { name: 'Payout >1.5x + Crowd <90% + Dyn + 10% DD', useDynamic: true, payoutFilter: 1.5, avoidExtremeCrowd: 0.90, drawdownLimit: 0.10 },
  { name: 'Payout >1.5x + Crowd <90% + Dyn + 15% DD', useDynamic: true, payoutFilter: 1.5, avoidExtremeCrowd: 0.90, drawdownLimit: 0.15 },
  { name: 'Payout >1.5x + Crowd <90% + Dyn + 20% DD', useDynamic: true, payoutFilter: 1.5, avoidExtremeCrowd: 0.90, drawdownLimit: 0.20 },
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
  let stoppedByDrawdown = false;
  let stopEpoch = null;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    // Check drawdown limit
    if (test.drawdownLimit && !stoppedByDrawdown) {
      const currentDrawdown = (maxBankroll - bankroll) / maxBankroll;
      if (currentDrawdown >= test.drawdownLimit) {
        stoppedByDrawdown = true;
        stopEpoch = r.epoch;
        // Stop trading for rest of backtest
        continue;
      }
    }

    // If already stopped by drawdown, skip all remaining trades
    if (stoppedByDrawdown) continue;

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
      betSize = test.fixedSize;
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
    maxDrawdown,
    stoppedByDrawdown,
    stopEpoch
  });
}

// Display results
console.log('📊 RESULTS WITH DRAWDOWN PROTECTION:\n');
console.log('┌───────────────────────────────────────────┬────────┬──────────┬──────────────┬──────────┬──────────────┬─────────────┐');
console.log('│ Strategy                                  │ Trades │ Win Rate │ Final Bank   │   ROI    │ Max Drawdown │ Stopped?    │');
console.log('├───────────────────────────────────────────┼────────┼──────────┼──────────────┼──────────┼──────────────┼─────────────┤');

for (const r of results) {
  const name = r.name.padEnd(41);
  const trades = r.totalTrades.toString().padStart(6);
  const winRate = r.winRate.toFixed(2).padStart(7) + '%';
  const bankroll = r.finalBankroll.toFixed(4).padStart(12);
  const roi = (r.roi >= 0 ? '+' : '') + r.roi.toFixed(2).padStart(7) + '%';
  const drawdown = (r.maxDrawdown * 100).toFixed(2).padStart(11) + '%';
  const stopped = r.stoppedByDrawdown ? `Yes @${r.stopEpoch}` : 'No';
  const stoppedPadded = stopped.padEnd(11);

  console.log(`│ ${name} │ ${trades} │ ${winRate} │ ${bankroll} │ ${roi} │ ${drawdown} │ ${stoppedPadded} │`);
}

console.log('└───────────────────────────────────────────┴────────┴──────────┴──────────────┴──────────┴──────────────┴─────────────┘');

// Group by strategy type
const noDD = results.filter(r => r.name.includes('(No DD)') || !r.name.includes('DD'));
const withDD = results.filter(r => r.name.includes('DD') && !r.name.includes('(No DD)'));

console.log('\n' + '═'.repeat(120) + '\n');
console.log('📈 BEST PERFORMERS BY CATEGORY:\n');

const pureEMABest = results.filter(r => r.name.includes('Pure EMA')).reduce((best, cur) =>
  cur.finalBankroll > best.finalBankroll ? cur : best
);

const payoutBest = results.filter(r => r.name.includes('Payout >1.5x') && !r.name.includes('Crowd')).reduce((best, cur) =>
  cur.finalBankroll > best.finalBankroll ? cur : best
);

const comboBest = results.filter(r => r.name.includes('Crowd <90%')).reduce((best, cur) =>
  cur.finalBankroll > best.finalBankroll ? cur : best
);

console.log('🥇 Best Pure EMA:');
console.log(`  ${pureEMABest.name}`);
console.log(`  Final: ${pureEMABest.finalBankroll.toFixed(4)} BNB (${pureEMABest.roi.toFixed(2)}% ROI)`);
console.log(`  Trades: ${pureEMABest.totalTrades} | Win Rate: ${pureEMABest.winRate.toFixed(2)}%`);
console.log(`  Max DD: ${(pureEMABest.maxDrawdown * 100).toFixed(2)}% | Stopped: ${pureEMABest.stoppedByDrawdown ? 'Yes' : 'No'}\n`);

console.log('🥈 Best Payout Filter:');
console.log(`  ${payoutBest.name}`);
console.log(`  Final: ${payoutBest.finalBankroll.toFixed(4)} BNB (${payoutBest.roi.toFixed(2)}% ROI)`);
console.log(`  Trades: ${payoutBest.totalTrades} | Win Rate: ${payoutBest.winRate.toFixed(2)}%`);
console.log(`  Max DD: ${(payoutBest.maxDrawdown * 100).toFixed(2)}% | Stopped: ${payoutBest.stoppedByDrawdown ? 'Yes' : 'No'}\n`);

console.log('🥉 Best Combo (Payout + Crowd):');
console.log(`  ${comboBest.name}`);
console.log(`  Final: ${comboBest.finalBankroll.toFixed(4)} BNB (${comboBest.roi.toFixed(2)}% ROI)`);
console.log(`  Trades: ${comboBest.totalTrades} | Win Rate: ${comboBest.winRate.toFixed(2)}%`);
console.log(`  Max DD: ${(comboBest.maxDrawdown * 100).toFixed(2)}% | Stopped: ${comboBest.stoppedByDrawdown ? 'Yes' : 'No'}\n`);

console.log('═'.repeat(120) + '\n');

console.log('🎯 KEY FINDINGS:\n');
console.log('  1. Drawdown protection LIMITS gains but prevents blowups');
console.log('  2. Without DD limits: Higher returns but higher risk');
console.log('  3. With 10-15% DD limits: More conservative, stops early');
console.log('  4. Payout filter = betting AGAINST crowd (confirmed)');
console.log(`  5. Total rounds in backtest: ${rounds.length}`);

console.log('\n═'.repeat(120) + '\n');

db.close();
