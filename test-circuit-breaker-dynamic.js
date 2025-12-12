import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🔬 CIRCUIT BREAKER TEST WITH FULL DYNAMIC POSITION SIZING\n');
console.log('═'.repeat(100) + '\n');
console.log('Testing: EMA Contrarian + Circuit Breaker + FULL Dynamic Positioning\n');
console.log('  • Base: 4.5% of bankroll\n');
console.log('  • Momentum: 1.889x when EMA gap ≥0.15%\n');
console.log('  • Recovery: 1.5x after 2 consecutive losses\n');
console.log('  • Circuit Breaker: Stop after N losses for X minutes\n');
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
    name: 'BASELINE: EMA Contrarian (no protection)',
    circuitBreaker: false
  },
  {
    name: 'Circuit Breaker: Stop after 2 losses (15min)',
    circuitBreaker: true,
    lossThreshold: 2,
    cooldownMinutes: 15
  },
  {
    name: 'Circuit Breaker: Stop after 3 losses (15min)',
    circuitBreaker: true,
    lossThreshold: 3,
    cooldownMinutes: 15
  },
  {
    name: 'Circuit Breaker: Stop after 3 losses (30min)',
    circuitBreaker: true,
    lossThreshold: 3,
    cooldownMinutes: 30
  },
  {
    name: 'Circuit Breaker: Stop after 3 losses (45min)',
    circuitBreaker: true,
    lossThreshold: 3,
    cooldownMinutes: 45
  },
  {
    name: 'Circuit Breaker: Stop after 3 losses (60min)',
    circuitBreaker: true,
    lossThreshold: 3,
    cooldownMinutes: 60
  },
  {
    name: 'Circuit Breaker: Stop after 4 losses (30min)',
    circuitBreaker: true,
    lossThreshold: 4,
    cooldownMinutes: 30
  },
  {
    name: 'Circuit Breaker: Stop after 5 losses (30min)',
    circuitBreaker: true,
    lossThreshold: 5,
    cooldownMinutes: 30
  }
];

function runStrategy(config) {
  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  let circuitBreakerTriggered = 0;

  // Circuit breaker state
  let consecutiveLosses = 0;
  let cooldownUntilTimestamp = 0;

  let maxDrawdown = 0;
  let peakBankroll = BASE_CONFIG.STARTING_BANKROLL;

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

    // CONTRARIAN STRATEGY
    let signal = null;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      signal = 'BULL';
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      signal = 'BEAR';
    }

    if (!signal) continue;

    // CIRCUIT BREAKER CHECK
    if (config.circuitBreaker) {
      const currentTimestamp = r.lock_timestamp;

      if (currentTimestamp < cooldownUntilTimestamp) {
        skipped++;
        continue; // Still in cooldown
      }
    }

    // DYNAMIC POSITION SIZING
    let sizeMultiplier = 1.0;

    // 1. Momentum multiplier (EMA gap ≥0.15%)
    const emaGap = parseFloat(r.ema_gap) || 0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;

    if (hasStrongSignal) {
      sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    // 2. Recovery multiplier (after 2 consecutive losses)
    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betSize = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    if (betSize > bankroll || betSize <= 0) continue;

    const actualPayout = parseFloat(r.winner_payout_multiple);
    const won = signal.toLowerCase() === r.winner.toLowerCase();

    const prevBankroll = bankroll;

    if (won) {
      const profit = betSize * (actualPayout - 1);
      bankroll += profit;
      wins++;

      // Reset consecutive losses on win
      consecutiveLosses = 0;
    } else {
      bankroll -= betSize;
      losses++;

      // Increment consecutive losses
      consecutiveLosses++;

      // Check if circuit breaker should trigger
      if (config.circuitBreaker && consecutiveLosses >= config.lossThreshold) {
        const cooldownSeconds = config.cooldownMinutes * 60;
        cooldownUntilTimestamp = r.lock_timestamp + cooldownSeconds;
        circuitBreakerTriggered++;
        consecutiveLosses = 0; // Reset after triggering
      }
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    // Track max drawdown
    if (bankroll > peakBankroll) {
      peakBankroll = bankroll;
    }

    const drawdown = ((peakBankroll - bankroll) / peakBankroll) * 100;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }

    tradeLog.push({
      epoch: r.epoch,
      won,
      bankroll,
      prevBankroll,
      consecutiveLosses: consecutiveLosses,
      betSize,
      sizeMultiplier
    });
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
    circuitBreakerTriggered,
    maxDrawdown,
    tradeLog
  };
}

console.log('Running tests...\n\n');

const results = strategies.map(strategy => ({
  ...strategy,
  ...runStrategy(strategy)
}));

results.sort((a, b) => b.roi - a.roi);

console.log('═'.repeat(100) + '\n');
console.log('🏆 CIRCUIT BREAKER TEST RESULTS (RANKED BY ROI)\n');
console.log('═'.repeat(100) + '\n\n');

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;

  console.log(`${rank} ${r.name}`);
  console.log(`   Trades: ${r.trades} | Win Rate: ${r.winRate.toFixed(1)}% | ROI: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}%`);
  console.log(`   Final Bankroll: ${r.bankroll.toFixed(3)} BNB (${r.bankroll.toFixed(1)}x)`);
  console.log(`   Max Drawdown: ${r.maxDrawdown.toFixed(1)}%`);
  if (r.skipped > 0) console.log(`   Skipped: ${r.skipped} trades (due to cooldown)`);
  if (r.circuitBreakerTriggered > 0) console.log(`   Circuit Breaker Triggered: ${r.circuitBreakerTriggered} times`);
  console.log();
}

console.log('═'.repeat(100) + '\n');

const baseline = results.find(r => r.name.includes('BASELINE'));
const best = results[0];

console.log('📊 COMPARISON: Baseline vs Best Circuit Breaker\n');
console.log('─'.repeat(100) + '\n');

console.log('BASELINE (No Protection):');
console.log(`  ROI: ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(2)}%`);
console.log(`  Final Bankroll: ${baseline.bankroll.toFixed(3)} BNB`);
console.log(`  Max Drawdown: ${baseline.maxDrawdown.toFixed(1)}%`);
console.log(`  Trades: ${baseline.trades}\n`);

console.log(`BEST (${best.name}):`);
console.log(`  ROI: ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(2)}%`);
console.log(`  Final Bankroll: ${best.bankroll.toFixed(3)} BNB`);
console.log(`  Max Drawdown: ${best.maxDrawdown.toFixed(1)}%`);
console.log(`  Trades: ${best.trades} (skipped ${best.skipped})`);
console.log(`  Circuit Breaker Triggers: ${best.circuitBreakerTriggered} times\n`);

const roiImprovement = best.roi - baseline.roi;
const drawdownReduction = baseline.maxDrawdown - best.maxDrawdown;

console.log('IMPROVEMENTS:');
console.log(`  ROI: ${roiImprovement >= 0 ? '+' : ''}${roiImprovement.toFixed(2)}% improvement`);
console.log(`  Max Drawdown: ${drawdownReduction >= 0 ? '-' : '+'}${Math.abs(drawdownReduction).toFixed(1)}% ${drawdownReduction >= 0 ? 'BETTER' : 'WORSE'}`);
console.log(`  Bankroll: ${((best.bankroll / baseline.bankroll - 1) * 100).toFixed(1)}% more capital\n`);

console.log('═'.repeat(100) + '\n');

// Find 13-loss streak in baseline
console.log('🔍 ANALYZING 13-LOSS STREAK WITH CIRCUIT BREAKER\n');
console.log('─'.repeat(100) + '\n');

let maxStreak = 0;
let currentStreak = 0;
let streakStart = -1;
let maxStreakStart = -1;
let maxStreakEnd = -1;

for (let i = 0; i < baseline.tradeLog.length; i++) {
  if (!baseline.tradeLog[i].won) {
    if (currentStreak === 0) {
      streakStart = i;
    }
    currentStreak++;
    if (currentStreak > maxStreak) {
      maxStreak = currentStreak;
      maxStreakStart = streakStart;
      maxStreakEnd = i;
    }
  } else {
    currentStreak = 0;
  }
}

console.log(`Baseline longest loss streak: ${maxStreak} consecutive losses`);
console.log(`  Bankroll: ${baseline.tradeLog[maxStreakStart].prevBankroll.toFixed(3)} → ${baseline.tradeLog[maxStreakEnd].bankroll.toFixed(3)} BNB`);
console.log(`  Drawdown: ${(((baseline.tradeLog[maxStreakEnd].bankroll - baseline.tradeLog[maxStreakStart].prevBankroll) / baseline.tradeLog[maxStreakStart].prevBankroll) * 100).toFixed(1)}%\n`);

// Check if best strategy prevented this
const bestTradeLog = best.tradeLog;
const streakEpochStart = baseline.tradeLog[maxStreakStart].epoch;
const streakEpochEnd = baseline.tradeLog[maxStreakEnd].epoch;

const bestStreakTrades = bestTradeLog.filter(t => t.epoch >= streakEpochStart && t.epoch <= streakEpochEnd);
const bestStreakLosses = bestStreakTrades.filter(t => !t.won).length;

console.log(`Best Strategy (${best.name}) during same period:`);
console.log(`  Trades taken: ${bestStreakTrades.length} (vs ${maxStreak} in baseline)`);
console.log(`  Losses: ${bestStreakLosses}`);
console.log(`  ${maxStreak - bestStreakTrades.length} trades PREVENTED by circuit breaker\n`);

if (bestStreakTrades.length > 0) {
  console.log(`  Bankroll: ${bestStreakTrades[0].prevBankroll.toFixed(3)} → ${bestStreakTrades[bestStreakTrades.length - 1].bankroll.toFixed(3)} BNB`);
  const bestDrawdown = ((bestStreakTrades[bestStreakTrades.length - 1].bankroll - bestStreakTrades[0].prevBankroll) / bestStreakTrades[0].prevBankroll) * 100;
  console.log(`  Drawdown: ${bestDrawdown.toFixed(1)}% (vs ${(((baseline.tradeLog[maxStreakEnd].bankroll - baseline.tradeLog[maxStreakStart].prevBankroll) / baseline.tradeLog[maxStreakStart].prevBankroll) * 100).toFixed(1)}% baseline)`);
  console.log(`  SAVED: ${Math.abs(bestDrawdown - (((baseline.tradeLog[maxStreakEnd].bankroll - baseline.tradeLog[maxStreakStart].prevBankroll) / baseline.tradeLog[maxStreakStart].prevBankroll) * 100)).toFixed(1)}% drawdown\n`);
}

console.log('═'.repeat(100) + '\n');
console.log('🎯 FINAL RECOMMENDATION\n');
console.log('─'.repeat(100) + '\n');

console.log(`Deploy: ${best.name}\n`);
console.log(`Expected Performance (3 weeks):`);
console.log(`  • Starting: 1.000 BNB`);
console.log(`  • Ending: ${best.bankroll.toFixed(3)} BNB`);
console.log(`  • ROI: ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(2)}%`);
console.log(`  • Max Drawdown: ${best.maxDrawdown.toFixed(1)}% (vs ${baseline.maxDrawdown.toFixed(1)}% without protection)`);
console.log(`  • Protection: Circuit breaker triggers ${best.circuitBreakerTriggered} times to prevent catastrophic losses\n`);

console.log(`Projected 1-Month Performance:`);
const monthlyMultiplier = Math.pow(best.bankroll, 30 / 21);
console.log(`  • Expected Bankroll: ${monthlyMultiplier.toFixed(2)} BNB`);
console.log(`  • Expected ROI: +${((monthlyMultiplier - 1) * 100).toFixed(2)}%\n`);

console.log('═'.repeat(100));

db.close();
