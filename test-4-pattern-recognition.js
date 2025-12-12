import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🔬 TEST 4: PATTERN RECOGNITION - PREDICT BAD MARKETS\n');
console.log('═'.repeat(100) + '\n');
console.log('Testing: Predict when bad performance will happen based on historical patterns\n');
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

// Pattern analysis: Does win streak predict loss streak?
function analyzeWinLossPatterns(tradeLog) {
  const patterns = {
    afterWinStreak3: { wins: 0, losses: 0 },
    afterWinStreak5: { wins: 0, losses: 0 },
    afterWinStreak7: { wins: 0, losses: 0 },
    afterLossStreak2: { wins: 0, losses: 0 },
    afterLossStreak3: { wins: 0, losses: 0 },
    afterMixedRun: { wins: 0, losses: 0 }
  };

  for (let i = 7; i < tradeLog.length; i++) {
    const last3 = tradeLog.slice(i - 3, i);
    const last5 = tradeLog.slice(i - 5, i);
    const last7 = tradeLog.slice(i - 7, i);
    const current = tradeLog[i];

    const all3Win = last3.every(t => t.won);
    const all5Win = last5.every(t => t.won);
    const all7Win = last7.every(t => t.won);
    const last2Loss = last3.slice(-2).every(t => !t.won);
    const last3Loss = last3.every(t => !t.won);

    if (all3Win) {
      if (current.won) patterns.afterWinStreak3.wins++;
      else patterns.afterWinStreak3.losses++;
    }

    if (all5Win) {
      if (current.won) patterns.afterWinStreak5.wins++;
      else patterns.afterWinStreak5.losses++;
    }

    if (all7Win) {
      if (current.won) patterns.afterWinStreak7.wins++;
      else patterns.afterWinStreak7.losses++;
    }

    if (last2Loss) {
      if (current.won) patterns.afterLossStreak2.wins++;
      else patterns.afterLossStreak2.losses++;
    }

    if (last3Loss) {
      if (current.won) patterns.afterLossStreak3.wins++;
      else patterns.afterLossStreak3.losses++;
    }
  }

  return patterns;
}

// Run baseline strategy and collect trade log
function runBaseline() {
  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  const tradeLog = [];

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
    // Consensus
    if (emaSignal === 'BULL' && bullPayout < 1.45) {
      signal = 'BULL';
    } else if (emaSignal === 'BEAR' && bearPayout < 1.45) {
      signal = 'BEAR';
    }

    if (!signal) continue;

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
    } else {
      bankroll -= betSize;
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    tradeLog.push({
      index: i,
      epoch: r.epoch,
      signal,
      won,
      betSize,
      bankroll
    });
  }

  return tradeLog;
}

// Run strategy with pattern-based predictions
function runWithPatternPrediction(config) {
  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  let reversed = 0;

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
    // Consensus
    if (emaSignal === 'BULL' && bullPayout < 1.45) {
      signal = 'BULL';
    } else if (emaSignal === 'BEAR' && bearPayout < 1.45) {
      signal = 'BEAR';
    }

    if (!signal) continue;

    // Check pattern
    const recentTrades = wins + losses;
    if (recentTrades >= config.lookback) {
      const checkStart = Math.max(0, recentTrades - config.lookback);
      const recentWins = lastTwoResults.filter(r => r === true).length;
      const winRate = recentWins / lastTwoResults.length;

      // Pattern: After win streak, expect losses
      if (config.reverseAfterWinStreak) {
        const allWins = lastTwoResults.slice(-config.winStreakLength).every(r => r === true);
        if (allWins) {
          signal = signal === 'BULL' ? 'BEAR' : 'BULL'; // Reverse
          reversed++;
        }
      }

      // Pattern: Skip after win streak
      if (config.skipAfterWinStreak) {
        const allWins = lastTwoResults.slice(-config.winStreakLength).every(r => r === true);
        if (allWins) {
          skipped++;
          continue;
        }
      }

      // Pattern: Skip after loss streak
      if (config.skipAfterLossStreak) {
        const allLosses = lastTwoResults.slice(-config.lossStreakLength).every(r => r === false);
        if (allLosses) {
          skipped++;
          continue;
        }
      }

      // Pattern: Reverse after loss streak
      if (config.reverseAfterLossStreak) {
        const allLosses = lastTwoResults.slice(-config.lossStreakLength).every(r => r === false);
        if (allLosses) {
          signal = signal === 'BULL' ? 'BEAR' : 'BULL';
          reversed++;
        }
      }
    }

    let sizeMultiplier = 1.0;
    const emaGap = parseFloat(r.ema_gap) || 0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;

    if (hasStrongSignal) {
      sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
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
    if (lastTwoResults.length > 10) lastTwoResults.shift();
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
    reversed
  };
}

console.log('Analyzing baseline pattern behavior...\n');

const baselineLog = runBaseline();
const patterns = analyzeWinLossPatterns(baselineLog);

console.log('═'.repeat(100) + '\n');
console.log('📊 PATTERN ANALYSIS RESULTS\n');
console.log('═'.repeat(100) + '\n\n');

console.log('After 3-win streak:');
const total3 = patterns.afterWinStreak3.wins + patterns.afterWinStreak3.losses;
console.log(`  Next trade WR: ${total3 > 0 ? ((patterns.afterWinStreak3.wins / total3) * 100).toFixed(1) : 0}% (${patterns.afterWinStreak3.wins}W ${patterns.afterWinStreak3.losses}L)`);
console.log(`  ${total3 > 0 && patterns.afterWinStreak3.wins / total3 < 0.5 ? '⚠️  PREDICTS LOSS' : '✅ CONTINUES WINNING'}\n`);

console.log('After 5-win streak:');
const total5 = patterns.afterWinStreak5.wins + patterns.afterWinStreak5.losses;
console.log(`  Next trade WR: ${total5 > 0 ? ((patterns.afterWinStreak5.wins / total5) * 100).toFixed(1) : 0}% (${patterns.afterWinStreak5.wins}W ${patterns.afterWinStreak5.losses}L)`);
console.log(`  ${total5 > 0 && patterns.afterWinStreak5.wins / total5 < 0.5 ? '⚠️  PREDICTS LOSS' : '✅ CONTINUES WINNING'}\n`);

console.log('After 7-win streak:');
const total7 = patterns.afterWinStreak7.wins + patterns.afterWinStreak7.losses;
console.log(`  Next trade WR: ${total7 > 0 ? ((patterns.afterWinStreak7.wins / total7) * 100).toFixed(1) : 0}% (${patterns.afterWinStreak7.wins}W ${patterns.afterWinStreak7.losses}L)`);
console.log(`  ${total7 > 0 && patterns.afterWinStreak7.wins / total7 < 0.5 ? '⚠️  PREDICTS LOSS' : '✅ CONTINUES WINNING'}\n`);

console.log('After 2-loss streak:');
const total2Loss = patterns.afterLossStreak2.wins + patterns.afterLossStreak2.losses;
console.log(`  Next trade WR: ${total2Loss > 0 ? ((patterns.afterLossStreak2.wins / total2Loss) * 100).toFixed(1) : 0}% (${patterns.afterLossStreak2.wins}W ${patterns.afterLossStreak2.losses}L)`);
console.log(`  ${total2Loss > 0 && patterns.afterLossStreak2.wins / total2Loss > 0.5 ? '✅ BOUNCE BACK LIKELY' : '⚠️  CONTINUES LOSING'}\n`);

console.log('After 3-loss streak:');
const total3Loss = patterns.afterLossStreak3.wins + patterns.afterLossStreak3.losses;
console.log(`  Next trade WR: ${total3Loss > 0 ? ((patterns.afterLossStreak3.wins / total3Loss) * 100).toFixed(1) : 0}% (${patterns.afterLossStreak3.wins}W ${patterns.afterLossStreak3.losses}L)`);
console.log(`  ${total3Loss > 0 && patterns.afterLossStreak3.wins / total3Loss > 0.5 ? '✅ BOUNCE BACK LIKELY' : '⚠️  CONTINUES LOSING'}\n`);

console.log('\n' + '═'.repeat(100) + '\n');
console.log('🧪 TESTING PATTERN-BASED STRATEGIES\n');
console.log('═'.repeat(100) + '\n\n');

const strategies = [
  {
    name: 'Baseline (EMA Consensus)',
    lookback: 0
  },
  {
    name: 'Skip after 3-win streak',
    skipAfterWinStreak: true,
    winStreakLength: 3,
    lookback: 3
  },
  {
    name: 'Skip after 5-win streak',
    skipAfterWinStreak: true,
    winStreakLength: 5,
    lookback: 5
  },
  {
    name: 'Reverse after 3-win streak',
    reverseAfterWinStreak: true,
    winStreakLength: 3,
    lookback: 3
  },
  {
    name: 'Reverse after 5-win streak',
    reverseAfterWinStreak: true,
    winStreakLength: 5,
    lookback: 5
  },
  {
    name: 'Skip after 2-loss streak (wait for bounce)',
    skipAfterLossStreak: true,
    lossStreakLength: 2,
    lookback: 2
  },
  {
    name: 'Skip after 3-loss streak',
    skipAfterLossStreak: true,
    lossStreakLength: 3,
    lookback: 3
  },
  {
    name: 'Reverse after 2-loss streak',
    reverseAfterLossStreak: true,
    lossStreakLength: 2,
    lookback: 2
  },
  {
    name: 'Reverse after 3-loss streak',
    reverseAfterLossStreak: true,
    lossStreakLength: 3,
    lookback: 3
  }
];

const results = strategies.map(strategy => ({
  ...strategy,
  ...runWithPatternPrediction(strategy)
}));

results.sort((a, b) => b.roi - a.roi);

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;

  console.log(`${rank} ${r.name}`);
  console.log(`   Trades: ${r.trades} | Win Rate: ${r.winRate.toFixed(1)}% | ROI: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}%`);
  console.log(`   Final Bankroll: ${r.bankroll.toFixed(3)} BNB`);
  if (r.skipped > 0) console.log(`   Skipped: ${r.skipped} trades`);
  if (r.reversed > 0) console.log(`   Reversed: ${r.reversed} trades`);
  console.log();
}

console.log('═'.repeat(100) + '\n');

const baseline = results.find(r => r.lookback === 0);
const best = results[0];

console.log('📈 SUMMARY:\n');
console.log(`Baseline: ${baseline.trades} trades, ${baseline.winRate.toFixed(1)}% WR, ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(2)}% ROI\n`);

if (best.roi > baseline.roi) {
  console.log(`✅ PATTERN RECOGNITION WORKS!`);
  console.log(`   Best: ${best.name}`);
  console.log(`   Improvement: ${(best.roi - baseline.roi).toFixed(2)}% ROI\n`);
} else {
  console.log(`❌ NO PATTERN STRATEGY BEATS BASELINE\n`);
}

console.log('═'.repeat(100));

db.close();
