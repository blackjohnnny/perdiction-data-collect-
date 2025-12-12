import { initDatabase } from './db-init.js';

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0,
};

function calculateFlipRate(rounds, currentIndex, lookback = 12) {
  const startIdx = Math.max(0, currentIndex - lookback);
  const recentRounds = rounds.slice(startIdx, currentIndex + 1);

  if (recentRounds.length < 3) return null;

  let emaFlips = 0;
  let prevSignal = null;
  for (const r of recentRounds) {
    const signal = r.ema_signal;
    if (signal && signal !== 'NEUTRAL') {
      if (prevSignal && signal !== prevSignal) emaFlips++;
      prevSignal = signal;
    }
  }

  return emaFlips / recentRounds.length;
}

function runStrategy(rounds, config) {
  const { useFlipRateFilter = false, maxFlipRate = 0.20, useCircuitBreaker = false } = config;

  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let wins = 0, losses = 0, skipped = 0;
  let consecutiveLosses = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;
  let cooldownUntilTimestamp = 0;
  let circuitBreakerTriggered = 0;
  let flipRateSkipped = 0;
  let circuitBreakerSkipped = 0;

  const tradeLog = [];
  const milestones = [];

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    // FlipRate filter
    if (useFlipRateFilter) {
      const flipRate = calculateFlipRate(rounds, i, 12);
      if (flipRate !== null && flipRate > maxFlipRate) {
        skipped++;
        flipRateSkipped++;
        continue;
      }
    }

    // Circuit breaker check
    if (useCircuitBreaker && r.lock_timestamp < cooldownUntilTimestamp) {
      skipped++;
      circuitBreakerSkipped++;
      continue;
    }

    // Generate signal
    const t20sBull = parseFloat(r.t20s_bull_wei || 0) / 1e18;
    const t20sBear = parseFloat(r.t20s_bear_wei || 0) / 1e18;
    const t20sTotal = t20sBull + t20sBear;
    if (t20sTotal === 0) continue;

    const bullPayout = (t20sTotal * 0.97) / t20sBull;
    const bearPayout = (t20sTotal * 0.97) / t20sBear;

    let signal = null;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BULL';
    else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BEAR';

    if (!signal) continue;

    // Position sizing
    let sizeMultiplier = 1.0;
    const emaGap = parseFloat(r.ema_gap) || 0;
    if (Math.abs(emaGap) >= 0.15) sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betAmount = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    const winner = r.winner ? r.winner.toLowerCase() : '';
    const won = (signal === 'BULL' && winner === 'bull') || (signal === 'BEAR' && winner === 'bear');

    const prevBankroll = bankroll;

    if (won) {
      const actualPayout = parseFloat(r.winner_payout_multiple);
      const profit = betAmount * (actualPayout - 1);
      bankroll += profit;
      wins++;
      consecutiveLosses = 0;
    } else {
      bankroll -= betAmount;
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

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    // Milestones
    if (bankroll >= 2 && !milestones.find(m => m.milestone === '2x')) {
      milestones.push({ milestone: '2x', bankroll, epoch: r.epoch, date: new Date(r.lock_timestamp * 1000) });
    }
    if (bankroll >= 5 && !milestones.find(m => m.milestone === '5x')) {
      milestones.push({ milestone: '5x', bankroll, epoch: r.epoch, date: new Date(r.lock_timestamp * 1000) });
    }
    if (bankroll >= 10 && !milestones.find(m => m.milestone === '10x')) {
      milestones.push({ milestone: '10x', bankroll, epoch: r.epoch, date: new Date(r.lock_timestamp * 1000) });
    }

    tradeLog.push({ epoch: r.epoch, won, bankroll, prevBankroll, consecutiveLosses });
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const roi = ((bankroll - BASE_CONFIG.STARTING_BANKROLL) / BASE_CONFIG.STARTING_BANKROLL) * 100;

  return {
    trades: totalTrades,
    wins,
    losses,
    winRate,
    roi,
    bankroll,
    skipped,
    flipRateSkipped,
    circuitBreakerSkipped,
    circuitBreakerTriggered,
    maxDrawdown,
    peak,
    milestones,
    tradeLog
  };
}

console.log('🎯 TESTING FLIPRATE FILTER + CIRCUIT BREAKER COMBINATION\n');
console.log('═'.repeat(100));

const db = initDatabase('./prediction.db');
const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`\n📊 Total rounds: ${rounds.length}\n`);
console.log('═'.repeat(100));

// Test 4 scenarios
console.log('\n🧪 TESTING 4 SCENARIOS:\n');

const baseline = runStrategy(rounds, {});
console.log('1️⃣  BASELINE (No Protection):');
console.log(`   ROI: ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(1)}%`);
console.log(`   Bankroll: ${baseline.bankroll.toFixed(3)} BNB (Peak: ${baseline.peak.toFixed(3)} BNB)`);
console.log(`   Trades: ${baseline.trades} (${baseline.wins}W / ${baseline.losses}L)`);
console.log(`   Win Rate: ${baseline.winRate.toFixed(1)}%`);
console.log(`   Max Drawdown: ${baseline.maxDrawdown.toFixed(1)}%`);
console.log();

const flipRate = runStrategy(rounds, { useFlipRateFilter: true, maxFlipRate: 0.20 });
console.log('2️⃣  FLIPRATE FILTER ONLY (Skip when flips > 20%):');
console.log(`   ROI: ${flipRate.roi >= 0 ? '+' : ''}${flipRate.roi.toFixed(1)}% (${flipRate.roi >= baseline.roi ? '+' : ''}${(flipRate.roi - baseline.roi).toFixed(1)}% vs baseline)`);
console.log(`   Bankroll: ${flipRate.bankroll.toFixed(3)} BNB (Peak: ${flipRate.peak.toFixed(3)} BNB)`);
console.log(`   Trades: ${flipRate.trades} (${flipRate.wins}W / ${flipRate.losses}L)`);
console.log(`   Win Rate: ${flipRate.winRate.toFixed(1)}%`);
console.log(`   Max Drawdown: ${flipRate.maxDrawdown.toFixed(1)}%`);
console.log(`   Skipped: ${flipRate.skipped} trades (${flipRate.flipRateSkipped} by flip rate)`);
console.log();

const circuitBreaker = runStrategy(rounds, { useCircuitBreaker: true });
console.log('3️⃣  CIRCUIT BREAKER ONLY (3 losses, 45min cooldown):');
console.log(`   ROI: ${circuitBreaker.roi >= 0 ? '+' : ''}${circuitBreaker.roi.toFixed(1)}% (${circuitBreaker.roi >= baseline.roi ? '+' : ''}${(circuitBreaker.roi - baseline.roi).toFixed(1)}% vs baseline)`);
console.log(`   Bankroll: ${circuitBreaker.bankroll.toFixed(3)} BNB (Peak: ${circuitBreaker.peak.toFixed(3)} BNB)`);
console.log(`   Trades: ${circuitBreaker.trades} (${circuitBreaker.wins}W / ${circuitBreaker.losses}L)`);
console.log(`   Win Rate: ${circuitBreaker.winRate.toFixed(1)}%`);
console.log(`   Max Drawdown: ${circuitBreaker.maxDrawdown.toFixed(1)}%`);
console.log(`   Skipped: ${circuitBreaker.skipped} trades | CB Triggered: ${circuitBreaker.circuitBreakerTriggered} times`);
console.log();

const combined = runStrategy(rounds, { useFlipRateFilter: true, maxFlipRate: 0.20, useCircuitBreaker: true });
console.log('4️⃣  COMBINED (FlipRate ≤20% + Circuit Breaker):');
console.log(`   ROI: ${combined.roi >= 0 ? '+' : ''}${combined.roi.toFixed(1)}% (${combined.roi >= baseline.roi ? '+' : ''}${(combined.roi - baseline.roi).toFixed(1)}% vs baseline)`);
console.log(`   Bankroll: ${combined.bankroll.toFixed(3)} BNB (Peak: ${combined.peak.toFixed(3)} BNB)`);
console.log(`   Trades: ${combined.trades} (${combined.wins}W / ${combined.losses}L)`);
console.log(`   Win Rate: ${combined.winRate.toFixed(1)}%`);
console.log(`   Max Drawdown: ${combined.maxDrawdown.toFixed(1)}%`);
console.log(`   Skipped: ${combined.skipped} trades (${combined.flipRateSkipped} by flip rate, ${combined.circuitBreakerSkipped} by CB)`);
console.log(`   CB Triggered: ${combined.circuitBreakerTriggered} times`);
console.log();

console.log('═'.repeat(100));
console.log('\n📊 COMPARISON SUMMARY:\n');
console.log('─'.repeat(100));

console.log(`Strategy                  │   ROI    │ Peak BNB │ Final BNB │ MaxDD  │ Trades │ WR`);
console.log('─'.repeat(100));
console.log(`Baseline                  │ ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(1).padStart(6)}% │  ${baseline.peak.toFixed(2).padStart(6)} │   ${baseline.bankroll.toFixed(2).padStart(6)} │ ${baseline.maxDrawdown.toFixed(1).padStart(5)}% │   ${String(baseline.trades).padStart(4)} │ ${baseline.winRate.toFixed(1)}%`);
console.log(`FlipRate ≤20%             │ ${flipRate.roi >= 0 ? '+' : ''}${flipRate.roi.toFixed(1).padStart(6)}% │  ${flipRate.peak.toFixed(2).padStart(6)} │   ${flipRate.bankroll.toFixed(2).padStart(6)} │ ${flipRate.maxDrawdown.toFixed(1).padStart(5)}% │   ${String(flipRate.trades).padStart(4)} │ ${flipRate.winRate.toFixed(1)}%`);
console.log(`Circuit Breaker           │ ${circuitBreaker.roi >= 0 ? '+' : ''}${circuitBreaker.roi.toFixed(1).padStart(6)}% │  ${circuitBreaker.peak.toFixed(2).padStart(6)} │   ${circuitBreaker.bankroll.toFixed(2).padStart(6)} │ ${circuitBreaker.maxDrawdown.toFixed(1).padStart(5)}% │   ${String(circuitBreaker.trades).padStart(4)} │ ${circuitBreaker.winRate.toFixed(1)}%`);
console.log(`COMBINED 🏆               │ ${combined.roi >= 0 ? '+' : ''}${combined.roi.toFixed(1).padStart(6)}% │  ${combined.peak.toFixed(2).padStart(6)} │   ${combined.bankroll.toFixed(2).padStart(6)} │ ${combined.maxDrawdown.toFixed(1).padStart(5)}% │   ${String(combined.trades).padStart(4)} │ ${combined.winRate.toFixed(1)}%`);

console.log('\n═'.repeat(100));

// Show milestones
if (combined.milestones.length > 0) {
  console.log('\n🎖️  MILESTONES REACHED (Combined Strategy):\n');
  for (const m of combined.milestones) {
    console.log(`   ${m.milestone}: ${m.bankroll.toFixed(2)} BNB at epoch ${m.epoch} (${m.date.toLocaleDateString()})`);
  }
  console.log();
}

console.log('═'.repeat(100));

db.close();
