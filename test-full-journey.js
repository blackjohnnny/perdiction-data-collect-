import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🚀 FULL JOURNEY TEST - FROM FIRST TO LAST ROUND\n');
console.log('═'.repeat(100) + '\n');
console.log('Starting: 1 BNB at first recorded round\n');
console.log('Dynamic Position Sizing:\n');
console.log('  • Base: 4.5% of bankroll\n');
console.log('  • Momentum: 8.5% (1.889x) when EMA gap ≥0.15%\n');
console.log('  • Recovery: 1.5x after 2 consecutive losses\n');
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

console.log(`📊 Total complete rounds: ${rounds.length}`);

if (rounds.length > 0) {
  const firstDate = new Date(rounds[0].lock_timestamp * 1000);
  const lastDate = new Date(rounds[rounds.length - 1].lock_timestamp * 1000);
  console.log(`📅 Date range: ${firstDate.toLocaleDateString()} to ${lastDate.toLocaleDateString()}`);
  console.log(`⏱️  Duration: ${Math.ceil((rounds[rounds.length - 1].lock_timestamp - rounds[0].lock_timestamp) / 86400)} days\n`);
}

console.log('═'.repeat(100) + '\n');

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,      // 4.5%
  MOMENTUM_MULTIPLIER: 1.889,     // 8.5% total (1.889x base)
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0
};

function runFullJourney(useCircuitBreaker = false) {
  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let wins = 0;
  let losses = 0;
  let skipped = 0;

  let peakBankroll = BASE_CONFIG.STARTING_BANKROLL;
  let maxDrawdown = 0;

  // Circuit breaker
  let consecutiveLosses = 0;
  let cooldownUntilTimestamp = 0;
  let circuitBreakerTriggered = 0;

  const milestones = [];
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

    // Circuit breaker check
    if (useCircuitBreaker && r.lock_timestamp < cooldownUntilTimestamp) {
      skipped++;
      continue;
    }

    // DYNAMIC POSITION SIZING
    let sizeMultiplier = 1.0;

    // 1. Momentum
    const emaGap = parseFloat(r.ema_gap) || 0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;
    if (hasStrongSignal) {
      sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    // 2. Recovery
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
      consecutiveLosses = 0;
    } else {
      bankroll -= betSize;
      losses++;
      consecutiveLosses++;

      if (useCircuitBreaker && consecutiveLosses >= 3) {
        cooldownUntilTimestamp = r.lock_timestamp + (45 * 60);
        circuitBreakerTriggered++;
        consecutiveLosses = 0;
      }
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    // Track peak and drawdown
    if (bankroll > peakBankroll) {
      peakBankroll = bankroll;
    }

    const currentDrawdown = ((peakBankroll - bankroll) / peakBankroll) * 100;
    if (currentDrawdown > maxDrawdown) {
      maxDrawdown = currentDrawdown;
    }

    // Record milestones
    if (bankroll >= 2 && !milestones.find(m => m.milestone === '2x')) {
      milestones.push({ milestone: '2x', bankroll: bankroll, epoch: r.epoch, date: new Date(r.lock_timestamp * 1000) });
    }
    if (bankroll >= 5 && !milestones.find(m => m.milestone === '5x')) {
      milestones.push({ milestone: '5x', bankroll: bankroll, epoch: r.epoch, date: new Date(r.lock_timestamp * 1000) });
    }
    if (bankroll >= 10 && !milestones.find(m => m.milestone === '10x')) {
      milestones.push({ milestone: '10x', bankroll: bankroll, epoch: r.epoch, date: new Date(r.lock_timestamp * 1000) });
    }
    if (bankroll >= 50 && !milestones.find(m => m.milestone === '50x')) {
      milestones.push({ milestone: '50x', bankroll: bankroll, epoch: r.epoch, date: new Date(r.lock_timestamp * 1000) });
    }

    tradeLog.push({
      epoch: r.epoch,
      won,
      bankroll,
      prevBankroll,
      consecutiveLosses
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
    peakBankroll,
    milestones,
    tradeLog
  };
}

console.log('🔄 Running baseline strategy (no circuit breaker)...\n');
const baseline = runFullJourney(false);

console.log('🔄 Running with circuit breaker (3 losses, 45min)...\n');
const withBreaker = runFullJourney(true);

console.log('═'.repeat(100) + '\n');
console.log('📊 RESULTS\n');
console.log('═'.repeat(100) + '\n\n');

console.log('BASELINE (No Protection):\n');
console.log(`  Starting Bankroll: 1.000 BNB`);
console.log(`  Final Bankroll: ${baseline.bankroll.toFixed(3)} BNB`);
console.log(`  Peak Bankroll: ${baseline.peakBankroll.toFixed(3)} BNB`);
console.log(`  ROI: ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(2)}%`);
console.log(`  Total Trades: ${baseline.trades} (${baseline.wins}W / ${baseline.losses}L)`);
console.log(`  Win Rate: ${baseline.winRate.toFixed(2)}%`);
console.log(`  Max Drawdown: ${baseline.maxDrawdown.toFixed(1)}%\n`);

if (baseline.milestones.length > 0) {
  console.log(`  Milestones reached:`);
  baseline.milestones.forEach(m => {
    console.log(`    ${m.milestone}: ${m.bankroll.toFixed(2)} BNB at epoch ${m.epoch} (${m.date.toLocaleDateString()})`);
  });
  console.log();
}

console.log('─'.repeat(100) + '\n');

console.log('WITH CIRCUIT BREAKER (3 losses, 45min):\n');
console.log(`  Starting Bankroll: 1.000 BNB`);
console.log(`  Final Bankroll: ${withBreaker.bankroll.toFixed(3)} BNB`);
console.log(`  Peak Bankroll: ${withBreaker.peakBankroll.toFixed(3)} BNB`);
console.log(`  ROI: ${withBreaker.roi >= 0 ? '+' : ''}${withBreaker.roi.toFixed(2)}%`);
console.log(`  Total Trades: ${withBreaker.trades} (${withBreaker.wins}W / ${withBreaker.losses}L)`);
console.log(`  Win Rate: ${withBreaker.winRate.toFixed(2)}%`);
console.log(`  Max Drawdown: ${withBreaker.maxDrawdown.toFixed(1)}%`);
console.log(`  Skipped: ${withBreaker.skipped} trades`);
console.log(`  Circuit Breaker Triggered: ${withBreaker.circuitBreakerTriggered} times\n`);

if (withBreaker.milestones.length > 0) {
  console.log(`  Milestones reached:`);
  withBreaker.milestones.forEach(m => {
    console.log(`    ${m.milestone}: ${m.bankroll.toFixed(2)} BNB at epoch ${m.epoch} (${m.date.toLocaleDateString()})`);
  });
  console.log();
}

console.log('═'.repeat(100) + '\n');
console.log('📈 COMPARISON\n');
console.log('═'.repeat(100) + '\n\n');

const roiDiff = withBreaker.roi - baseline.roi;
const drawdownImprovement = baseline.maxDrawdown - withBreaker.maxDrawdown;

console.log(`ROI Improvement: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}%`);
console.log(`Drawdown Improvement: ${drawdownImprovement >= 0 ? '-' : '+'}${Math.abs(drawdownImprovement).toFixed(1)}% ${drawdownImprovement >= 0 ? 'BETTER' : 'WORSE'}`);
console.log(`Final Bankroll: ${(withBreaker.bankroll / baseline.bankroll).toFixed(2)}x more capital\n`);

console.log('═'.repeat(100) + '\n');
console.log('🎯 FINAL ANSWER\n');
console.log('═'.repeat(100) + '\n\n');

console.log(`Starting with 1 BNB at your first recorded round:\n`);
console.log(`WITHOUT Circuit Breaker:`);
console.log(`  → ${baseline.bankroll.toFixed(3)} BNB (${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(0)}% ROI)\n`);

console.log(`WITH Circuit Breaker (3 losses, 45min):`);
console.log(`  → ${withBreaker.bankroll.toFixed(3)} BNB (${withBreaker.roi >= 0 ? '+' : ''}${withBreaker.roi.toFixed(0)}% ROI)\n`);

console.log(`Circuit breaker ${roiDiff >= 0 ? 'IMPROVES' : 'HURTS'} performance by ${Math.abs(roiDiff).toFixed(0)}%`);

console.log('\n' + '═'.repeat(100));

db.close();
