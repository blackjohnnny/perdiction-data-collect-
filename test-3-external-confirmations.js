import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🔬 TEST 3: EXTERNAL CONFIRMATIONS\n');
console.log('═'.repeat(100) + '\n');
console.log('Testing: Volume, liquidity changes, pool dynamics, T8s/T4s snapshots\n');
console.log('─'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Testing on ${rounds.length} complete rounds\n\n`);

function getPrice(r) {
  const lock = parseFloat(r.lock_price);
  return lock > 1000000 ? lock / 1e8 : lock;
}

// Calculate volume growth
function getVolumeGrowth(rounds, index) {
  if (index < 5) return { t20sGrowth: 0, t8sGrowth: 0, t4sGrowth: 0 };

  const current = rounds[index];
  const prev = rounds[index - 1];

  const t20sCurrent = parseFloat(current.t20s_total_wei) / 1e18;
  const t20sPrev = parseFloat(prev.t20s_total_wei || 0) / 1e18;
  const t20sGrowth = t20sPrev > 0 ? ((t20sCurrent - t20sPrev) / t20sPrev) * 100 : 0;

  const t8sCurrent = parseFloat(current.t8s_total_wei || 0) / 1e18;
  const t8sPrev = parseFloat(prev.t8s_total_wei || 0) / 1e18;
  const t8sGrowth = t8sPrev > 0 ? ((t8sCurrent - t8sPrev) / t8sPrev) * 100 : 0;

  const t4sCurrent = parseFloat(current.t4s_total_wei || 0) / 1e18;
  const t4sPrev = parseFloat(prev.t4s_total_wei || 0) / 1e18;
  const t4sGrowth = t4sPrev > 0 ? ((t4sCurrent - t4sPrev) / t4sPrev) * 100 : 0;

  return { t20sGrowth, t8sGrowth, t4sGrowth };
}

// Check if crowd sentiment is shifting
function crowdSentimentShift(rounds, index) {
  if (index < 1) return { shifting: false, direction: null, magnitude: 0 };

  const current = rounds[index];
  const prev = rounds[index - 1];

  const currentBullWei = parseFloat(current.t20s_bull_wei) / 1e18;
  const currentBearWei = parseFloat(current.t20s_bear_wei) / 1e18;
  const currentBullPct = (currentBullWei / (currentBullWei + currentBearWei)) * 100;

  const prevBullWei = parseFloat(prev.t20s_bull_wei || 0) / 1e18;
  const prevBearWei = parseFloat(prev.t20s_bear_wei || 0) / 1e18;
  const prevTotal = prevBullWei + prevBearWei;
  const prevBullPct = prevTotal > 0 ? (prevBullWei / prevTotal) * 100 : 50;

  const shift = currentBullPct - prevBullPct;

  return {
    shifting: Math.abs(shift) > 5,
    direction: shift > 0 ? 'BULL' : 'BEAR',
    magnitude: Math.abs(shift)
  };
}

// Check late money (T8s vs T20s, T4s vs T8s)
function getLateMoney(round) {
  const t20sBull = parseFloat(round.t20s_bull_wei || 0) / 1e18;
  const t20sBear = parseFloat(round.t20s_bear_wei || 0) / 1e18;
  const t20sTotal = t20sBull + t20sBear;

  const lockBull = parseFloat(round.lock_bull_wei || 0) / 1e18;
  const lockBear = parseFloat(round.lock_bear_wei || 0) / 1e18;
  const lockTotal = lockBull + lockBear;

  if (t20sTotal === 0 || lockTotal === 0) return { lateBullPct: 0, lateBearPct: 0, lateDirection: null };

  const lateBull = lockBull - t20sBull;
  const lateBear = lockBear - t20sBear;
  const lateTotal = lockTotal - t20sTotal;

  if (lateTotal <= 0) return { lateBullPct: 0, lateBearPct: 0, lateDirection: null };

  const lateBullPct = (lateBull / lateTotal) * 100;
  const lateBearPct = (lateBear / lateTotal) * 100;

  let lateDirection = null;
  if (lateBullPct > 60) lateDirection = 'BULL';
  else if (lateBearPct > 60) lateDirection = 'BEAR';

  return { lateBullPct, lateBearPct, lateDirection };
}

// Check pool balance
function getPoolBalance(round) {
  const bullWei = parseFloat(round.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(round.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;

  if (total === 0) return { bullPct: 50, bearPct: 50, balanced: false };

  const bullPct = (bullWei / total) * 100;
  const bearPct = (bearWei / total) * 100;

  const balanced = Math.abs(bullPct - 50) < 10; // 40-60% range

  return { bullPct, bearPct, balanced };
}

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0
};

const strategies = [
  {
    name: 'Baseline (EMA Consensus)',
    consensus: true
  },
  {
    name: 'Filter: Skip low liquidity (<2 BNB)',
    consensus: true,
    minLiquidity: 2
  },
  {
    name: 'Filter: Skip low liquidity (<5 BNB)',
    consensus: true,
    minLiquidity: 5
  },
  {
    name: 'Filter: Require volume spike (>20% growth)',
    consensus: true,
    requireVolumeSpike: true,
    spikeThreshold: 20
  },
  {
    name: 'Filter: Require high liquidity (>10 BNB)',
    consensus: true,
    minLiquidity: 10
  },
  {
    name: 'Confirmation: Follow late money direction',
    consensus: true,
    followLateMoney: true
  },
  {
    name: 'Confirmation: Skip if late money opposes EMA',
    consensus: true,
    skipLateMoneyOpposite: true
  },
  {
    name: 'Confirmation: Skip if crowd shifting opposite',
    consensus: true,
    skipCrowdShift: true
  },
  {
    name: 'Confirmation: Only balanced pools (40-60%)',
    consensus: true,
    onlyBalanced: true
  },
  {
    name: 'Confirmation: Avoid balanced pools (extremes only)',
    consensus: true,
    avoidBalanced: true
  },
  {
    name: 'COMBO: High liquidity + Follow late money',
    consensus: true,
    minLiquidity: 5,
    followLateMoney: true
  },
  {
    name: 'COMBO: Volume spike + Balanced pools',
    consensus: true,
    requireVolumeSpike: true,
    spikeThreshold: 15,
    onlyBalanced: true
  },
  {
    name: 'COMBO: Skip low liquidity + Skip crowd shifts',
    consensus: true,
    minLiquidity: 3,
    skipCrowdShift: true
  }
];

function runStrategy(config) {
  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let wins = 0;
  let losses = 0;
  let skipped = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    let signal = null;

    // Consensus strategy
    if (config.consensus) {
      const emaSignal = r.ema_signal;
      if (!emaSignal || emaSignal === 'NEUTRAL') continue;

      if (emaSignal === 'BULL' && bullPayout < 1.45) {
        signal = 'BULL';
      } else if (emaSignal === 'BEAR' && bearPayout < 1.45) {
        signal = 'BEAR';
      }
    }

    if (!signal) {
      skipped++;
      continue;
    }

    // FILTER: Minimum liquidity
    if (config.minLiquidity && total < config.minLiquidity) {
      skipped++;
      continue;
    }

    // FILTER: Volume spike
    if (config.requireVolumeSpike) {
      const volume = getVolumeGrowth(rounds, i);
      if (volume.t20sGrowth < config.spikeThreshold) {
        skipped++;
        continue;
      }
    }

    // CONFIRMATION: Follow late money
    if (config.followLateMoney) {
      const lateMoney = getLateMoney(r);
      if (lateMoney.lateDirection && lateMoney.lateDirection !== signal) {
        signal = lateMoney.lateDirection; // Override with late money
      }
    }

    // CONFIRMATION: Skip if late money opposes
    if (config.skipLateMoneyOpposite) {
      const lateMoney = getLateMoney(r);
      if (lateMoney.lateDirection && lateMoney.lateDirection !== signal) {
        skipped++;
        continue;
      }
    }

    // CONFIRMATION: Skip crowd shift
    if (config.skipCrowdShift) {
      const shift = crowdSentimentShift(rounds, i);
      if (shift.shifting && shift.direction !== signal) {
        skipped++;
        continue;
      }
    }

    // FILTER: Only balanced pools
    if (config.onlyBalanced) {
      const balance = getPoolBalance(r);
      if (!balance.balanced) {
        skipped++;
        continue;
      }
    }

    // FILTER: Avoid balanced pools
    if (config.avoidBalanced) {
      const balance = getPoolBalance(r);
      if (balance.balanced) {
        skipped++;
        continue;
      }
    }

    // Position sizing
    let sizeMultiplier = 1.0;
    const emaGap = parseFloat(r.ema_gap) || 0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;

    if (hasStrongSignal) {
      sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    if (lastTwoResults.length === 2 && lastTwoResults.every(r => !r)) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betSize = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    if (betSize > bankroll) continue;

    const actualPayout = parseFloat(r.winner_payout_multiple);
    const won = signal.toLowerCase() === r.winner.toLowerCase();

    if (won) {
      const profit = betSize * (actualPayout - 1);
      bankroll += profit;
      wins++;
    } else {
      bankroll -= betSize;
      losses++;
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = ((bankroll - BASE_CONFIG.STARTING_BANKROLL) / BASE_CONFIG.STARTING_BANKROLL) * 100;

  return {
    trades: totalTrades,
    wins,
    losses,
    winRate,
    roi,
    bankroll,
    skipped
  };
}

console.log('Running tests...\n\n');

const results = strategies.map(strategy => ({
  ...strategy,
  ...runStrategy(strategy)
}));

// Sort by ROI
results.sort((a, b) => b.roi - a.roi);

console.log('═'.repeat(100) + '\n');
console.log('📊 EXTERNAL CONFIRMATION TEST RESULTS\n');
console.log('═'.repeat(100) + '\n\n');

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;

  console.log(`${rank} ${r.name}`);
  console.log(`   Trades: ${r.trades} | Win Rate: ${r.winRate.toFixed(1)}% | ROI: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}%`);
  console.log(`   Final Bankroll: ${r.bankroll.toFixed(3)} BNB`);
  if (r.skipped > 0) {
    console.log(`   Skipped: ${r.skipped} rounds`);
  }
  console.log();
}

console.log('═'.repeat(100) + '\n');

const baseline = results.find(r => r.name.includes('Baseline'));
const best = results[0];

console.log('📈 SUMMARY:\n');
console.log(`Baseline (EMA Consensus): ${baseline.trades} trades, ${baseline.winRate.toFixed(1)}% WR, ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(2)}% ROI\n`);

if (best.roi > baseline.roi) {
  console.log(`✅ EXTERNAL CONFIRMATION IMPROVES PERFORMANCE!`);
  console.log(`   Best: ${best.name}`);
  console.log(`   Improvement: ${(best.roi - baseline.roi).toFixed(2)}% ROI`);
  console.log(`   Win Rate: ${best.winRate.toFixed(1)}% vs ${baseline.winRate.toFixed(1)}%`);
  console.log(`   ${best.trades} trades vs ${baseline.trades} trades\n`);
} else {
  console.log(`❌ NO EXTERNAL CONFIRMATION BEATS BASELINE`);
  console.log(`   All filters reduce performance\n`);
}

console.log('═'.repeat(100));

db.close();
