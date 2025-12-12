import { initDatabase } from './db-init.js';

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0,
};

function calculateFlipRate(rounds, currentIndex, lookback) {
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
  const {
    lookback = 12,
    maxFlipRate = 0.20,
    useInverse = false,
    useCircuitBreaker = false
  } = config;

  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let wins = 0, losses = 0, skipped = 0;
  let consecutiveLosses = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;
  let cooldownUntilTimestamp = 0;
  let cbTriggered = 0;
  let inversedTrades = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    // Circuit breaker check
    if (useCircuitBreaker && r.lock_timestamp < cooldownUntilTimestamp) {
      skipped++;
      continue;
    }

    const flipRate = calculateFlipRate(rounds, i, lookback);
    if (flipRate === null) continue;

    const isChoppy = flipRate > maxFlipRate;

    const t20sBull = parseFloat(r.t20s_bull_wei || 0) / 1e18;
    const t20sBear = parseFloat(r.t20s_bear_wei || 0) / 1e18;
    const t20sTotal = t20sBull + t20sBear;
    if (t20sTotal === 0) continue;

    const bullPayout = (t20sTotal * 0.97) / t20sBull;
    const bearPayout = (t20sTotal * 0.97) / t20sBear;

    // CONTRARIAN STRATEGY
    let signal = null;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      signal = 'BULL';
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      signal = 'BEAR';
    }

    if (!signal) continue;

    // INVERSE if choppy
    let finalSignal = signal;
    if (useInverse && isChoppy) {
      finalSignal = signal === 'BULL' ? 'BEAR' : 'BULL';
      inversedTrades++;
    }

    // Position sizing
    let sizeMultiplier = 1.0;
    const emaGap = parseFloat(r.ema_gap) || 0;
    if (Math.abs(emaGap) >= 0.15) sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betAmount = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    const winner = r.winner ? r.winner.toLowerCase() : '';
    const won = (finalSignal === 'BULL' && winner === 'bull') || (finalSignal === 'BEAR' && winner === 'bear');

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
        cbTriggered++;
        consecutiveLosses = 0;
      }
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const roi = ((bankroll - BASE_CONFIG.STARTING_BANKROLL) / BASE_CONFIG.STARTING_BANKROLL) * 100;

  return {
    roi, winRate, trades: totalTrades, wins, losses, maxDrawdown, bankroll, peak,
    skipped, cbTriggered, inversedTrades
  };
}

console.log('🔥 ULTIMATE STRATEGY TEST: INVERSE + CIRCUIT BREAKER\n');
console.log('═'.repeat(100));

const db = initDatabase('./prediction.db');
const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`\n📊 Total rounds: ${rounds.length}\n`);
console.log('═'.repeat(100));
console.log('\n🧪 TESTING ALL COMBINATIONS:\n');

const strategies = [
  { name: 'BASELINE', useInverse: false, useCircuitBreaker: false },
  { name: 'Inverse Only (FlipRate>20%, 12r)', useInverse: true, useCircuitBreaker: false },
  { name: 'Circuit Breaker Only (3L, 45min)', useInverse: false, useCircuitBreaker: true },
  { name: '🔥 INVERSE + CIRCUIT BREAKER', useInverse: true, useCircuitBreaker: true },
];

const results = [];

console.log('Strategy                              │ Win Rate │   ROI    │  Peak  │ Final  │ MaxDD  │ Trades │ CB Hits │ Inversed');
console.log('─'.repeat(100));

for (const strat of strategies) {
  const result = runStrategy(rounds, strat);
  results.push({ name: strat.name, ...result });

  const name = strat.name.padEnd(37);
  const wr = `${result.winRate.toFixed(1)}%`.padStart(8);
  const roi = `${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(0)}%`.padStart(8);
  const peak = `${result.peak.toFixed(2)}`.padStart(6);
  const final = `${result.bankroll.toFixed(2)}`.padStart(6);
  const dd = `${result.maxDrawdown.toFixed(1)}%`.padStart(6);
  const trades = String(result.trades).padStart(6);
  const cb = result.cbTriggered ? String(result.cbTriggered).padStart(7) : '   -   ';
  const inv = result.inversedTrades ? String(result.inversedTrades).padStart(8) : '    -   ';

  console.log(`${name} │ ${wr} │ ${roi} │ ${peak} │ ${final} │ ${dd} │ ${trades} │ ${cb} │ ${inv}`);
}

console.log('\n' + '═'.repeat(100));
console.log('\n🏆 WINNER:\n');

const best = results.sort((a, b) => b.winRate - a.winRate)[0];

console.log(`   ${best.name}`);
console.log(`   Win Rate: ${best.winRate.toFixed(1)}% (${best.wins}W / ${best.losses}L)`);
console.log(`   ROI: ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(1)}%`);
console.log(`   Peak: ${best.peak.toFixed(2)} BNB`);
console.log(`   Final: ${best.bankroll.toFixed(2)} BNB`);
console.log(`   Max Drawdown: ${best.maxDrawdown.toFixed(1)}%`);
console.log(`   Total Trades: ${best.trades}`);
if (best.cbTriggered) console.log(`   Circuit Breaker Triggered: ${best.cbTriggered} times`);
if (best.inversedTrades) console.log(`   Inversed Trades: ${best.inversedTrades}`);

console.log('\n' + '═'.repeat(100));
console.log('\n📊 COMPARISON vs BASELINE:\n');

const baseline = results.find(r => r.name === 'BASELINE');

console.log(`   Win Rate: ${baseline.winRate.toFixed(1)}% → ${best.winRate.toFixed(1)}% (${best.winRate - baseline.winRate >= 0 ? '+' : ''}${(best.winRate - baseline.winRate).toFixed(1)}%)`);
console.log(`   ROI: ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(1)}% → ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(1)}% (${best.roi - baseline.roi >= 0 ? '+' : ''}${(best.roi - baseline.roi).toFixed(1)}%)`);
console.log(`   Max Drawdown: ${baseline.maxDrawdown.toFixed(1)}% → ${best.maxDrawdown.toFixed(1)}% (${best.maxDrawdown - baseline.maxDrawdown >= 0 ? '+' : ''}${(best.maxDrawdown - baseline.maxDrawdown).toFixed(1)}%)`);

console.log('\n' + '═'.repeat(100));

db.close();
