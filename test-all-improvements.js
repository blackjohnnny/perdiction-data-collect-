import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';

console.log('\n🚀 TESTING ALL PROFITABILITY IMPROVEMENTS\n');
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

console.log(`📊 Found ${rounds.length} complete rounds\n`);

const EMA_GAP_BASE = 0.05;
const STARTING_BANKROLL = 1.0;
const BASE_BET_SIZE = 0.01;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getEMASide(emaGap, threshold = EMA_GAP_BASE) {
  if (emaGap > threshold) return 'BULL';
  if (emaGap < -threshold) return 'BEAR';
  return null;
}

function getCrowdSide(bullWei, bearWei, threshold = 0.65) {
  const total = bullWei + bearWei;
  if (total === 0) return null;
  const bullPercent = bullWei / total;
  const bearPercent = bearWei / total;
  if (bullPercent >= threshold) return { side: 'BULL', percent: bullPercent };
  if (bearPercent >= threshold) return { side: 'BEAR', percent: bearPercent };
  return null;
}

function getPayoutForSide(side, bullWei, bearWei) {
  const total = bullWei + bearWei;
  if (total === 0) return 1.0;
  if (side === 'BULL') return total / bullWei;
  if (side === 'BEAR') return total / bearWei;
  return 1.0;
}

function getHourOfDay(timestamp) {
  return new Date(timestamp * 1000).getUTCHours();
}

function calculateKellyFraction(winRate, avgPayout) {
  const p = winRate;
  const b = avgPayout - 1;
  const q = 1 - p;
  const kelly = (p * b - q) / b;
  return Math.max(0, Math.min(kelly, 0.25)); // Cap at 25% of bankroll
}

// ============================================================================
// TEST CONFIGURATIONS
// ============================================================================

const tests = [
  {
    name: 'BASELINE (Pure EMA 0.05%)',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap);
      return side ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },

  // Test 1: Payout Multiplier Filtering
  {
    name: 'Payout > 1.5x only',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap);
      if (!side) return null;
      const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
      const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
      const payout = getPayoutForSide(side, bullWei, bearWei);
      return payout >= 1.5 ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },
  {
    name: 'Payout > 1.6x only',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap);
      if (!side) return null;
      const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
      const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
      const payout = getPayoutForSide(side, bullWei, bearWei);
      return payout >= 1.6 ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },
  {
    name: 'Payout > 1.7x only',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap);
      if (!side) return null;
      const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
      const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
      const payout = getPayoutForSide(side, bullWei, bearWei);
      return payout >= 1.7 ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },

  // Test 2: EMA Strength Filtering
  {
    name: 'EMA gap > 0.10% (stronger signals)',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap, 0.10);
      return side ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },
  {
    name: 'EMA gap > 0.15% (strongest signals)',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap, 0.15);
      return side ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },

  // Test 3: Consecutive Signals
  {
    name: 'Consecutive EMA (2 rounds same direction)',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap);
      if (!side || i === 0) return null;
      const prevSide = getEMASide(rounds[i - 1].ema_gap);
      return (side === prevSide) ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },
  {
    name: 'Consecutive EMA (3 rounds same direction)',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap);
      if (!side || i < 2) return null;
      const prev1Side = getEMASide(rounds[i - 1].ema_gap);
      const prev2Side = getEMASide(rounds[i - 2].ema_gap);
      return (side === prev1Side && side === prev2Side) ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },

  // Test 4: Pool Size Filtering
  {
    name: 'Pool size > 2 BNB',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap);
      if (!side) return null;
      const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
      const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
      const total = bullWei + bearWei;
      return total >= 2.0 ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },
  {
    name: 'Pool size > 3 BNB',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap);
      if (!side) return null;
      const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
      const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
      const total = bullWei + bearWei;
      return total >= 3.0 ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },

  // Test 5: Time of Day Filtering
  {
    name: 'Trade 0-8 UTC only (Asia hours)',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap);
      if (!side) return null;
      const hour = getHourOfDay(r.lock_timestamp);
      return (hour >= 0 && hour < 8) ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },
  {
    name: 'Trade 12-20 UTC only (US hours)',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap);
      if (!side) return null;
      const hour = getHourOfDay(r.lock_timestamp);
      return (hour >= 12 && hour < 20) ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },

  // Test 6: Anti-Overtrading
  {
    name: 'Skip 1 round after loss',
    state: { lastResult: null, skipNext: false },
    filter: (r, i, rounds, state) => {
      const side = getEMASide(r.ema_gap);
      if (!side) return null;

      if (state.skipNext) {
        state.skipNext = false;
        return null;
      }

      return { side, betSize: BASE_BET_SIZE, state };
    },
    afterTrade: (won, state) => {
      state.lastResult = won ? 'WIN' : 'LOSS';
      if (!won) state.skipNext = true;
    }
  },
  {
    name: 'Skip 2 rounds after 2 consecutive losses',
    state: { lastTwo: [null, null], skipCount: 0 },
    filter: (r, i, rounds, state) => {
      const side = getEMASide(r.ema_gap);
      if (!side) return null;

      if (state.skipCount > 0) {
        state.skipCount--;
        return null;
      }

      return { side, betSize: BASE_BET_SIZE, state };
    },
    afterTrade: (won, state) => {
      state.lastTwo = [won ? 'WIN' : 'LOSS', state.lastTwo[0]];
      if (state.lastTwo[0] === 'LOSS' && state.lastTwo[1] === 'LOSS') {
        state.skipCount = 2;
      }
    }
  },

  // Test 7: Extreme Crowd Avoidance
  {
    name: 'Avoid extreme crowd (>85%)',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap);
      if (!side) return null;
      const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
      const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
      const crowd = getCrowdSide(bullWei, bearWei, 0.85);
      return !crowd ? { side, betSize: BASE_BET_SIZE } : null; // Skip if extreme crowd exists
    }
  },
  {
    name: 'Avoid extreme crowd (>90%)',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap);
      if (!side) return null;
      const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
      const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
      const crowd = getCrowdSide(bullWei, bearWei, 0.90);
      return !crowd ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },

  // Test 8: Dynamic Position Sizing (EMA gap strength)
  {
    name: 'Scale bet size by EMA gap (0.5x-2x)',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap);
      if (!side) return null;
      const absGap = Math.abs(r.ema_gap);
      // Scale: 0.05% = 1x, 0.10% = 1.5x, 0.20% = 2x
      const multiplier = Math.min(2.0, 0.5 + (absGap / 0.05) * 0.5);
      return { side, betSize: BASE_BET_SIZE * multiplier };
    }
  },

  // Test 9: Combine Best Filters
  {
    name: 'COMBO: Payout>1.6x + Gap>0.10%',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap, 0.10);
      if (!side) return null;
      const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
      const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
      const payout = getPayoutForSide(side, bullWei, bearWei);
      return payout >= 1.6 ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },
  {
    name: 'COMBO: Consecutive(2) + Payout>1.5x',
    filter: (r, i, rounds) => {
      const side = getEMASide(r.ema_gap);
      if (!side || i === 0) return null;
      const prevSide = getEMASide(rounds[i - 1].ema_gap);
      if (side !== prevSide) return null;
      const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
      const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
      const payout = getPayoutForSide(side, bullWei, bearWei);
      return payout >= 1.5 ? { side, betSize: BASE_BET_SIZE } : null;
    }
  },
];

// ============================================================================
// RUN ALL TESTS
// ============================================================================

console.log('🧪 Running tests...\n');

const results = [];

for (const test of tests) {
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalProfit = 0;
  let totalWagered = 0;

  const state = test.state || {};

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    const decision = test.filter(r, i, rounds, state);
    if (!decision) continue;

    const { side, betSize } = decision;

    // Execute trade
    totalTrades++;
    totalWagered += betSize;
    const won = side === r.winner.toUpperCase();
    const payout = parseFloat(r.winner_payout_multiple);

    if (won) {
      wins++;
      totalProfit += betSize * (payout - 1);
    } else {
      losses++;
      totalProfit -= betSize;
    }

    // After trade callback
    if (test.afterTrade) {
      test.afterTrade(won, state);
    }
  }

  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100) : 0;
  const roi = totalWagered > 0 ? ((totalProfit / totalWagered) * 100) : 0;
  const finalBankroll = STARTING_BANKROLL + totalProfit;

  results.push({
    name: test.name,
    totalTrades,
    wins,
    losses,
    winRate,
    totalProfit,
    roi,
    finalBankroll,
    totalWagered
  });
}

// ============================================================================
// DISPLAY RESULTS
// ============================================================================

console.log('═'.repeat(120) + '\n');
console.log('📊 ALL IMPROVEMENT TESTS RESULTS:\n');
console.log('┌─────────────────────────────────────────┬────────┬──────────┬─────────────┬──────────┬─────────────┐');
console.log('│ Strategy                                │ Trades │ Win Rate │   Profit    │   ROI    │ Final Bank  │');
console.log('├─────────────────────────────────────────┼────────┼──────────┼─────────────┼──────────┼─────────────┤');

for (const r of results) {
  const name = r.name.padEnd(39);
  const trades = r.totalTrades.toString().padStart(6);
  const winRate = r.winRate.toFixed(2).padStart(7) + '%';
  const profit = (r.totalProfit >= 0 ? '+' : '') + r.totalProfit.toFixed(4).padStart(10);
  const roi = (r.roi >= 0 ? '+' : '') + r.roi.toFixed(2).padStart(7) + '%';
  const bankroll = r.finalBankroll.toFixed(4).padStart(11);

  console.log(`│ ${name} │ ${trades} │ ${winRate} │ ${profit} │ ${roi} │ ${bankroll} │`);
}

console.log('└─────────────────────────────────────────┴────────┴──────────┴─────────────┴──────────┴─────────────┘');

// Find top performers
const sortedByROI = [...results].sort((a, b) => b.roi - a.roi);
const sortedByProfit = [...results].sort((a, b) => b.totalProfit - a.totalProfit);
const sortedByWinRate = [...results].sort((a, b) => b.winRate - a.winRate);

console.log('\n' + '═'.repeat(120) + '\n');
console.log('🏆 TOP 5 BY ROI:\n');
for (let i = 0; i < Math.min(5, sortedByROI.length); i++) {
  const r = sortedByROI[i];
  console.log(`  ${i + 1}. ${r.name}`);
  console.log(`     ROI: ${r.roi.toFixed(2)}% | Profit: +${r.totalProfit.toFixed(4)} | Trades: ${r.totalTrades} | Win Rate: ${r.winRate.toFixed(2)}%\n`);
}

console.log('🏆 TOP 5 BY TOTAL PROFIT:\n');
for (let i = 0; i < Math.min(5, sortedByProfit.length); i++) {
  const r = sortedByProfit[i];
  console.log(`  ${i + 1}. ${r.name}`);
  console.log(`     Profit: +${r.totalProfit.toFixed(4)} | ROI: ${r.roi.toFixed(2)}% | Trades: ${r.totalTrades} | Win Rate: ${r.winRate.toFixed(2)}%\n`);
}

console.log('🏆 TOP 5 BY WIN RATE:\n');
for (let i = 0; i < Math.min(5, sortedByWinRate.length); i++) {
  const r = sortedByWinRate[i];
  console.log(`  ${i + 1}. ${r.name}`);
  console.log(`     Win Rate: ${r.winRate.toFixed(2)}% | ROI: ${r.roi.toFixed(2)}% | Profit: +${r.totalProfit.toFixed(4)} | Trades: ${r.totalTrades}\n`);
}

console.log('═'.repeat(120) + '\n');

db.close();
