import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('📊 CIRCUIT BREAKER IMPACT ANALYSIS\n');
console.log('═'.repeat(100) + '\n');
console.log('Question: How many wins/losses does circuit breaker remove? Final ROI?\n');
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

console.log(`📊 Analyzing ${rounds.length} complete rounds\n\n`);

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0
};

function runStrategy(usCircuitBreaker, lossThreshold, cooldownMinutes) {
  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let wins = 0;
  let losses = 0;
  let skipped = 0;

  let consecutiveLosses = 0;
  let cooldownUntilTimestamp = 0;

  const skippedTrades = []; // Track what we skipped

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
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      signal = 'BULL';
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      signal = 'BEAR';
    }

    if (!signal) continue;

    // Circuit breaker check
    if (usCircuitBreaker && r.lock_timestamp < cooldownUntilTimestamp) {
      skipped++;

      // Track what we would have done
      const actualPayout = parseFloat(r.winner_payout_multiple);
      const wouldHaveWon = signal.toLowerCase() === r.winner.toLowerCase();

      skippedTrades.push({
        epoch: r.epoch,
        signal,
        wouldHaveWon,
        payout: actualPayout
      });

      continue;
    }

    // Dynamic position sizing
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
    if (betSize > bankroll || betSize <= 0) continue;

    const actualPayout = parseFloat(r.winner_payout_multiple);
    const won = signal.toLowerCase() === r.winner.toLowerCase();

    if (won) {
      const profit = betSize * (actualPayout - 1);
      bankroll += profit;
      wins++;
      consecutiveLosses = 0;
    } else {
      bankroll -= betSize;
      losses++;
      consecutiveLosses++;

      if (usCircuitBreaker && consecutiveLosses >= lossThreshold) {
        cooldownUntilTimestamp = r.lock_timestamp + (cooldownMinutes * 60);
        consecutiveLosses = 0;
      }
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = ((bankroll - BASE_CONFIG.STARTING_BANKROLL) / BASE_CONFIG.STARTING_BANKROLL) * 100;

  return { trades: totalTrades, wins, losses, winRate, roi, bankroll, skipped, skippedTrades };
}

console.log('Running tests...\n\n');

// Baseline
const baseline = runStrategy(false, 0, 0);

// Best circuit breaker
const best = runStrategy(true, 3, 45);

console.log('═'.repeat(100) + '\n');
console.log('📊 DETAILED COMPARISON\n');
console.log('═'.repeat(100) + '\n\n');

console.log('BASELINE (No Circuit Breaker):\n');
console.log(`  Total Trades: ${baseline.trades}`);
console.log(`  Wins: ${baseline.wins}`);
console.log(`  Losses: ${baseline.losses}`);
console.log(`  Win Rate: ${baseline.winRate.toFixed(2)}%`);
console.log(`  ROI: ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(2)}%`);
console.log(`  Final Bankroll: ${baseline.bankroll.toFixed(3)} BNB\n`);

console.log('─'.repeat(100) + '\n');

console.log('WITH CIRCUIT BREAKER (3 losses, 45min):\n');
console.log(`  Total Trades: ${best.trades}`);
console.log(`  Wins: ${best.wins}`);
console.log(`  Losses: ${best.losses}`);
console.log(`  Win Rate: ${best.winRate.toFixed(2)}%`);
console.log(`  ROI: ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(2)}%`);
console.log(`  Final Bankroll: ${best.bankroll.toFixed(3)} BNB\n`);

console.log('─'.repeat(100) + '\n');

console.log('TRADES REMOVED BY CIRCUIT BREAKER:\n');
console.log(`  Total Skipped: ${best.skipped} trades\n`);

// Analyze skipped trades
const skippedWins = best.skippedTrades.filter(t => t.wouldHaveWon).length;
const skippedLosses = best.skippedTrades.filter(t => !t.wouldHaveWon).length;

console.log(`  Would-be Wins: ${skippedWins}`);
console.log(`  Would-be Losses: ${skippedLosses}`);
console.log(`  Would-be Win Rate: ${(skippedWins / best.skipped * 100).toFixed(1)}%\n`);

console.log('─'.repeat(100) + '\n');

console.log('NET IMPACT:\n');
console.log(`  Wins removed: ${baseline.wins - best.wins} (${skippedWins} skipped)`);
console.log(`  Losses removed: ${baseline.losses - best.losses} (${skippedLosses} skipped)`);
console.log(`  Net trades removed: ${baseline.trades - best.trades}\n`);

const roiDiff = best.roi - baseline.roi;
const wrDiff = best.winRate - baseline.winRate;

console.log(`  Win Rate change: ${wrDiff >= 0 ? '+' : ''}${wrDiff.toFixed(2)}%`);
console.log(`  ROI change: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}%`);
console.log(`  Bankroll multiplier: ${(best.bankroll / baseline.bankroll).toFixed(2)}x\n`);

console.log('═'.repeat(100) + '\n');
console.log('💡 INTERPRETATION\n');
console.log('═'.repeat(100) + '\n\n');

console.log(`Circuit breaker removed ${skippedLosses} losses and ${skippedWins} wins.\n`);

const netLossesRemoved = skippedLosses - skippedWins;
if (netLossesRemoved > 0) {
  console.log(`✅ NET POSITIVE: Removed ${netLossesRemoved} more LOSSES than wins!\n`);
} else {
  console.log(`⚠️  NET NEGATIVE: Removed ${Math.abs(netLossesRemoved)} more WINS than losses!\n`);
}

console.log(`Win rate of skipped trades: ${(skippedWins / best.skipped * 100).toFixed(1)}%`);
console.log(`Win rate of taken trades: ${best.winRate.toFixed(1)}%\n`);

if ((skippedWins / best.skipped * 100) < best.winRate) {
  console.log(`✅ GOOD: Circuit breaker skipped WORSE trades (${(skippedWins / best.skipped * 100).toFixed(1)}% vs ${best.winRate.toFixed(1)}%)\n`);
} else {
  console.log(`⚠️  BAD: Circuit breaker skipped BETTER trades (${(skippedWins / best.skipped * 100).toFixed(1)}% vs ${best.winRate.toFixed(1)}%)\n`);
}

console.log('─'.repeat(100) + '\n');

console.log('🎯 FINAL ROI COMPARISON:\n\n');

console.log(`BASELINE:`);
console.log(`  1.000 BNB → ${baseline.bankroll.toFixed(3)} BNB`);
console.log(`  ROI: ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(2)}%\n`);

console.log(`WITH CIRCUIT BREAKER:`);
console.log(`  1.000 BNB → ${best.bankroll.toFixed(3)} BNB`);
console.log(`  ROI: ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(2)}%\n`);

console.log(`IMPROVEMENT:`);
console.log(`  ${(best.bankroll / baseline.bankroll).toFixed(2)}x more capital`);
console.log(`  ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}% better ROI\n`);

console.log('═'.repeat(100) + '\n');

console.log('📋 SKIPPED TRADES BREAKDOWN:\n');
console.log('─'.repeat(100) + '\n');

console.log('First 10 skipped trades:\n');
for (let i = 0; i < Math.min(10, best.skippedTrades.length); i++) {
  const t = best.skippedTrades[i];
  console.log(`  ${i + 1}. Epoch ${t.epoch}: ${t.signal} bet → ${t.wouldHaveWon ? '✅ WIN' : '❌ LOSS'} (payout ${t.payout.toFixed(2)}x)`);
}

if (best.skippedTrades.length > 10) {
  console.log(`  ... and ${best.skippedTrades.length - 10} more\n`);
} else {
  console.log();
}

console.log('═'.repeat(100));

db.close();
