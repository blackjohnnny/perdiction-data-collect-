import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🔬 TEST 5: REAL-TIME CONFIRMATION - DETECT BAD PERFORMANCE\n');
console.log('═'.repeat(100) + '\n');
console.log('Testing: Detect when performance deteriorates and adapt strategy in real-time\n');
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
    baseline: true
  },
  {
    name: 'After 3 losses: Reverse all trades',
    detectBadPerf: true,
    lookback: 5,
    threshold: 40, // WR below 40%
    action: 'reverse'
  },
  {
    name: 'After 5 losses: Reverse all trades',
    detectBadPerf: true,
    lookback: 10,
    threshold: 40,
    action: 'reverse'
  },
  {
    name: 'After 3 losses: Skip trades',
    detectBadPerf: true,
    lookback: 5,
    threshold: 40,
    action: 'skip',
    skipDuration: 3
  },
  {
    name: 'After 5 losses: Skip trades',
    detectBadPerf: true,
    lookback: 10,
    threshold: 40,
    action: 'skip',
    skipDuration: 5
  },
  {
    name: 'After 3 losses: Reduce position size 50%',
    detectBadPerf: true,
    lookback: 5,
    threshold: 40,
    action: 'reduce',
    reduceMultiplier: 0.5
  },
  {
    name: 'After 5 losses: Reduce position size 50%',
    detectBadPerf: true,
    lookback: 10,
    threshold: 40,
    action: 'reduce',
    reduceMultiplier: 0.5
  },
  {
    name: 'WR <40% in last 10: Reverse trades',
    detectBadPerf: true,
    lookback: 10,
    threshold: 40,
    action: 'reverse'
  },
  {
    name: 'WR <45% in last 10: Reverse trades',
    detectBadPerf: true,
    lookback: 10,
    threshold: 45,
    action: 'reverse'
  },
  {
    name: 'WR <50% in last 10: Reverse trades',
    detectBadPerf: true,
    lookback: 10,
    threshold: 50,
    action: 'reverse'
  },
  {
    name: 'Adaptive: Switch between consensus/contrarian',
    adaptive: true,
    lookback: 10,
    threshold: 45
  },
  {
    name: 'Aggressive Adaptive: Switch at WR <50%',
    adaptive: true,
    lookback: 8,
    threshold: 50
  },
  {
    name: 'Conservative Adaptive: Switch at WR <40%',
    adaptive: true,
    lookback: 15,
    threshold: 40
  }
];

function runStrategy(config) {
  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let recentTrades = []; // For performance tracking
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  let reversed = 0;
  let switched = 0;
  let skipRemaining = 0;
  let currentMode = 'consensus'; // Start with consensus

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    let signal = null;

    // Determine signal based on current mode
    if (config.adaptive) {
      if (currentMode === 'consensus') {
        // Consensus: EMA + crowd agree
        if (emaSignal === 'BULL' && bullPayout < 1.45) {
          signal = 'BULL';
        } else if (emaSignal === 'BEAR' && bearPayout < 1.45) {
          signal = 'BEAR';
        }
      } else {
        // Contrarian: EMA vs crowd
        if (emaSignal === 'BULL' && bearPayout >= 1.45) {
          signal = 'BULL';
        } else if (emaSignal === 'BEAR' && bullPayout >= 1.45) {
          signal = 'BEAR';
        }
      }
    } else {
      // Baseline consensus
      if (emaSignal === 'BULL' && bullPayout < 1.45) {
        signal = 'BULL';
      } else if (emaSignal === 'BEAR' && bearPayout < 1.45) {
        signal = 'BEAR';
      }
    }

    if (!signal) continue;

    // Check recent performance
    let badPerformance = false;
    if (config.detectBadPerf && recentTrades.length >= config.lookback) {
      const recentWins = recentTrades.slice(-config.lookback).filter(t => t).length;
      const recentWR = (recentWins / config.lookback) * 100;

      if (recentWR < config.threshold) {
        badPerformance = true;
      }
    }

    // Adaptive switching
    if (config.adaptive && recentTrades.length >= config.lookback) {
      const recentWins = recentTrades.slice(-config.lookback).filter(t => t).length;
      const recentWR = (recentWins / config.lookback) * 100;

      if (recentWR < config.threshold) {
        // Switch mode
        const newMode = currentMode === 'consensus' ? 'contrarian' : 'consensus';
        if (newMode !== currentMode) {
          currentMode = newMode;
          switched++;

          // Recalculate signal for new mode
          if (currentMode === 'consensus') {
            signal = null;
            if (emaSignal === 'BULL' && bullPayout < 1.45) {
              signal = 'BULL';
            } else if (emaSignal === 'BEAR' && bearPayout < 1.45) {
              signal = 'BEAR';
            }
          } else {
            signal = null;
            if (emaSignal === 'BULL' && bearPayout >= 1.45) {
              signal = 'BULL';
            } else if (emaSignal === 'BEAR' && bullPayout >= 1.45) {
              signal = 'BEAR';
            }
          }

          if (!signal) continue;
        }
      }
    }

    // Take action on bad performance
    if (badPerformance && config.action) {
      if (config.action === 'skip') {
        if (skipRemaining <= 0) {
          skipRemaining = config.skipDuration;
        }
      }

      if (config.action === 'reverse') {
        signal = signal === 'BULL' ? 'BEAR' : 'BULL';
        reversed++;
      }
    }

    // Handle skip duration
    if (skipRemaining > 0) {
      skipRemaining--;
      skipped++;
      continue;
    }

    // Position sizing
    let sizeMultiplier = 1.0;
    const emaGap = parseFloat(r.ema_gap) || 0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;

    if (hasStrongSignal) {
      sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    // Reduce position if bad performance
    if (badPerformance && config.action === 'reduce') {
      sizeMultiplier *= config.reduceMultiplier;
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
    if (lastTwoResults.length > 10) lastTwoResults.shift();

    recentTrades.push(won);
    if (recentTrades.length > 20) recentTrades.shift();
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
    skipped,
    reversed,
    switched
  };
}

console.log('Running tests...\n\n');

const results = strategies.map(strategy => ({
  ...strategy,
  ...runStrategy(strategy)
}));

results.sort((a, b) => b.roi - a.roi);

console.log('═'.repeat(100) + '\n');
console.log('📊 REAL-TIME CONFIRMATION TEST RESULTS\n');
console.log('═'.repeat(100) + '\n\n');

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;

  console.log(`${rank} ${r.name}`);
  console.log(`   Trades: ${r.trades} | Win Rate: ${r.winRate.toFixed(1)}% | ROI: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}%`);
  console.log(`   Final Bankroll: ${r.bankroll.toFixed(3)} BNB`);
  if (r.skipped > 0) console.log(`   Skipped: ${r.skipped} trades`);
  if (r.reversed > 0) console.log(`   Reversed: ${r.reversed} trades`);
  if (r.switched > 0) console.log(`   Mode switches: ${r.switched} times`);
  console.log();
}

console.log('═'.repeat(100) + '\n');

const baseline = results.find(r => r.baseline);
const best = results[0];

console.log('📈 SUMMARY:\n');
console.log(`Baseline: ${baseline.trades} trades, ${baseline.winRate.toFixed(1)}% WR, ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(2)}% ROI\n`);

if (best.roi > baseline.roi) {
  console.log(`✅ REAL-TIME ADAPTATION WORKS!`);
  console.log(`   Best: ${best.name}`);
  console.log(`   Improvement: ${(best.roi - baseline.roi).toFixed(2)}% ROI`);
  console.log(`   Win Rate: ${best.winRate.toFixed(1)}% vs ${baseline.winRate.toFixed(1)}%\n`);
} else {
  console.log(`❌ NO ADAPTIVE STRATEGY BEATS BASELINE\n`);
}

console.log('═'.repeat(100));

db.close();
