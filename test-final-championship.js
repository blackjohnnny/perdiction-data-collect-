import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🏆 FINAL CHAMPIONSHIP - ALL BEST STRATEGIES WITH DYNAMIC POSITIONING\n');
console.log('═'.repeat(100) + '\n');
console.log('Testing ALL top strategies with full dynamic position sizing:\n');
console.log('  • Base: 4.5% of bankroll\n');
console.log('  • Momentum: 1.889x when EMA gap ≥0.15%\n');
console.log('  • Recovery: 1.5x after 2 consecutive losses\n');
console.log('  • Performance-based: Adjust based on recent win rate\n');
console.log('─'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Testing on ${rounds.length} complete rounds\n\n`);

function getPrice(r) {
  const lock = parseFloat(r.lock_price);
  return lock > 1000000 ? lock / 1e8 : lock;
}

function calculateBollingerBands(rounds, index, period = 20, stdDev = 2) {
  if (index < period) return { upper: 0, middle: 0, lower: 0, position: 50 };

  const prices = rounds.slice(Math.max(0, index - period + 1), index + 1).map(r => getPrice(r));
  const middle = prices.reduce((a, b) => a + b, 0) / prices.length;

  const variance = prices.reduce((sum, price) => sum + Math.pow(price - middle, 2), 0) / prices.length;
  const sd = Math.sqrt(variance);

  const upper = middle + (sd * stdDev);
  const lower = middle - (sd * stdDev);

  const currentPrice = prices[prices.length - 1];
  const position = ((currentPrice - lower) / (upper - lower)) * 100;

  return { upper, middle, lower, position };
}

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

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0
};

const strategies = [
  {
    name: '1. EMA Consensus (bet WITH crowd)',
    consensus: true,
    useEMA: true
  },
  {
    name: '2. Bollinger Bands Mean Reversion',
    useBollinger: true,
    meanReversion: true
  },
  {
    name: '3. EMA Consensus + Late Money Filter',
    consensus: true,
    useEMA: true,
    skipLateMoneyOpposite: true
  },
  {
    name: '4. EMA Consensus + Adaptive Switching',
    adaptive: true,
    lookback: 10,
    threshold: 45
  },
  {
    name: '5. EMA Consensus + Skip After 5-Win Streak',
    consensus: true,
    useEMA: true,
    skipAfterWinStreak: true,
    winStreakLength: 5
  },
  {
    name: '6. EMA Consensus + Performance-Based Sizing',
    consensus: true,
    useEMA: true,
    performanceBased: true
  },
  {
    name: '7. Bollinger + Performance-Based Sizing',
    useBollinger: true,
    meanReversion: true,
    performanceBased: true
  },
  {
    name: '8. Adaptive + Performance-Based Sizing',
    adaptive: true,
    lookback: 10,
    threshold: 45,
    performanceBased: true
  },
  {
    name: '9. EMA Consensus + Late Money + Adaptive',
    consensus: true,
    useEMA: true,
    skipLateMoneyOpposite: true,
    adaptiveFallback: true,
    lookback: 10,
    threshold: 45
  },
  {
    name: '10. ULTIMATE: Consensus + Late Money + Performance + Skip Streaks',
    consensus: true,
    useEMA: true,
    skipLateMoneyOpposite: true,
    performanceBased: true,
    skipAfterWinStreak: true,
    winStreakLength: 5
  }
];

function runStrategy(config) {
  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let recentTrades = [];
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  let switched = 0;
  let currentMode = 'consensus';
  let winStreak = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    const bullWei = parseFloat(r.t20s_bull_wei || 0) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei || 0) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    let signal = null;

    // Bollinger Bands
    if (config.useBollinger) {
      const bb = calculateBollingerBands(rounds, i);

      if (config.meanReversion) {
        if (bb.position > 80 && bearPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BEAR';
        else if (bb.position < 20 && bullPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BULL';
      }
    }

    // EMA Consensus or Adaptive
    if (config.consensus || config.adaptive) {
      const emaSignal = r.ema_signal;
      if (!emaSignal || emaSignal === 'NEUTRAL') continue;

      if (config.adaptive) {
        // Check if we should switch modes
        if (recentTrades.length >= config.lookback) {
          const recentWins = recentTrades.slice(-config.lookback).filter(t => t).length;
          const recentWR = (recentWins / config.lookback) * 100;

          if (recentWR < config.threshold) {
            const newMode = currentMode === 'consensus' ? 'contrarian' : 'consensus';
            if (newMode !== currentMode) {
              currentMode = newMode;
              switched++;
            }
          }
        }

        // Apply current mode
        if (currentMode === 'consensus') {
          if (emaSignal === 'BULL' && bullPayout < BASE_CONFIG.MIN_PAYOUT) signal = 'BULL';
          else if (emaSignal === 'BEAR' && bearPayout < BASE_CONFIG.MIN_PAYOUT) signal = 'BEAR';
        } else {
          if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BULL';
          else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BEAR';
        }
      } else if (config.consensus) {
        if (emaSignal === 'BULL' && bullPayout < BASE_CONFIG.MIN_PAYOUT) signal = 'BULL';
        else if (emaSignal === 'BEAR' && bearPayout < BASE_CONFIG.MIN_PAYOUT) signal = 'BEAR';
      }
    }

    if (!signal) continue;

    // Late money filter
    if (config.skipLateMoneyOpposite || (config.adaptiveFallback && currentMode === 'consensus')) {
      const lateMoney = getLateMoney(r);
      if (lateMoney.lateDirection && lateMoney.lateDirection !== signal) {
        skipped++;
        continue;
      }
    }

    // Skip after win streak
    if (config.skipAfterWinStreak && winStreak >= config.winStreakLength) {
      skipped++;
      winStreak = 0; // Reset after skipping
      continue;
    }

    // Calculate position size
    let sizeMultiplier = 1.0;

    // Momentum multiplier
    const emaGap = parseFloat(r.ema_gap) || 0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;
    if (hasStrongSignal && !config.useBollinger) {
      sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    // Recovery multiplier
    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    // Performance-based sizing
    if (config.performanceBased && recentTrades.length >= 10) {
      const recentWins = recentTrades.slice(-10).filter(t => t).length;
      const recentWR = (recentWins / 10) * 100;

      if (recentWR >= 60) {
        sizeMultiplier *= 0.9; // Reduce after good performance
      } else if (recentWR >= 50) {
        sizeMultiplier *= 0.85; // Reduce during medium (unstable)
      } else {
        sizeMultiplier *= 1.15; // INCREASE during bad (73.5% bounce-back)
      }
    }

    const betSize = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    if (betSize > bankroll) continue;

    const actualPayout = parseFloat(r.winner_payout_multiple);
    const won = signal.toLowerCase() === r.winner.toLowerCase();

    if (won) {
      const profit = betSize * (actualPayout - 1);
      bankroll += profit;
      wins++;
      winStreak++;
    } else {
      bankroll -= betSize;
      losses++;
      winStreak = 0;
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
    switched
  };
}

console.log('Running championship tests...\n\n');

const results = strategies.map(strategy => ({
  ...strategy,
  ...runStrategy(strategy)
}));

results.sort((a, b) => b.roi - a.roi);

console.log('═'.repeat(100) + '\n');
console.log('🏆 FINAL CHAMPIONSHIP RESULTS\n');
console.log('═'.repeat(100) + '\n\n');

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  let rank;
  if (i === 0) rank = '🥇 CHAMPION';
  else if (i === 1) rank = '🥈 2nd PLACE';
  else if (i === 2) rank = '🥉 3rd PLACE';
  else rank = `   ${i + 1}.`;

  console.log(`${rank} ${r.name}`);
  console.log(`   Trades: ${r.trades} | Win Rate: ${r.winRate.toFixed(1)}% | ROI: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}%`);
  console.log(`   Final Bankroll: ${r.bankroll.toFixed(3)} BNB (${r.bankroll.toFixed(1)}x)`);
  if (r.skipped > 0) console.log(`   Skipped: ${r.skipped} trades`);
  if (r.switched > 0) console.log(`   Mode switches: ${r.switched} times`);
  console.log();
}

console.log('═'.repeat(100) + '\n');

const champion = results[0];
const baseline = results.find(r => r.name.includes('EMA Consensus (bet WITH crowd)')) || results[0];

console.log('🎯 CHAMPION ANALYSIS:\n');
console.log(`Strategy: ${champion.name}\n`);
console.log(`Performance:`);
console.log(`  • ROI: ${champion.roi >= 0 ? '+' : ''}${champion.roi.toFixed(2)}%`);
console.log(`  • Final Bankroll: ${champion.bankroll.toFixed(3)} BNB (${champion.bankroll.toFixed(1)}x starting capital)`);
console.log(`  • Win Rate: ${champion.winRate.toFixed(1)}%`);
console.log(`  • Total Trades: ${champion.trades}`);
console.log(`  • Wins: ${champion.wins} | Losses: ${champion.losses}`);
if (champion.skipped > 0) console.log(`  • Trades Skipped: ${champion.skipped}`);
if (champion.switched > 0) console.log(`  • Mode Switches: ${champion.switched}\n`);

console.log(`\nProjected 1-Month Performance (starting with 1 BNB):`);
const monthlyMultiplier = Math.pow(champion.bankroll, 30 / 21); // Scale 3 weeks to 1 month
console.log(`  • Expected Bankroll: ${monthlyMultiplier.toFixed(2)} BNB`);
console.log(`  • Expected ROI: +${((monthlyMultiplier - 1) * 100).toFixed(2)}%`);

console.log('\n' + '═'.repeat(100) + '\n');

console.log('📊 TOP 3 COMPARISON:\n');

for (let i = 0; i < Math.min(3, results.length); i++) {
  const r = results[i];
  console.log(`${i + 1}. ${r.name}`);
  console.log(`   ${r.bankroll.toFixed(1)}x | ${r.winRate.toFixed(1)}% WR | ${r.trades} trades\n`);
}

console.log('═'.repeat(100) + '\n');

console.log('💡 KEY INSIGHTS:\n');

// Find which features help most
const consensusBase = results.find(r => r.name === '1. EMA Consensus (bet WITH crowd)');
const withLateMoney = results.find(r => r.name === '3. EMA Consensus + Late Money Filter');
const withAdaptive = results.find(r => r.name === '4. EMA Consensus + Adaptive Switching');
const withPerformance = results.find(r => r.name === '6. EMA Consensus + Performance-Based Sizing');

if (consensusBase) {
  console.log(`Baseline (Consensus): ${consensusBase.roi.toFixed(0)}% ROI\n`);

  if (withLateMoney) {
    const improvement = withLateMoney.roi - consensusBase.roi;
    console.log(`+ Late Money Filter: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(0)}% improvement`);
  }

  if (withAdaptive) {
    const improvement = withAdaptive.roi - consensusBase.roi;
    console.log(`+ Adaptive Switching: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(0)}% improvement`);
  }

  if (withPerformance) {
    const improvement = withPerformance.roi - consensusBase.roi;
    console.log(`+ Performance-Based Sizing: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(0)}% improvement`);
  }

  console.log();
}

console.log('═'.repeat(100) + '\n');

console.log('🚀 DEPLOYMENT RECOMMENDATION:\n');
console.log(`Deploy: ${champion.name}\n`);
console.log(`Expected Results (3 weeks):`);
console.log(`  • Starting: 1.000 BNB`);
console.log(`  • Ending: ${champion.bankroll.toFixed(3)} BNB`);
console.log(`  • ROI: ${champion.roi >= 0 ? '+' : ''}${champion.roi.toFixed(2)}%`);
console.log(`  • Risk Level: ${champion.winRate >= 58 ? 'Low' : champion.winRate >= 55 ? 'Medium' : 'High'}`);

console.log('\n' + '═'.repeat(100));

db.close();
