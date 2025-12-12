import { initDatabase } from './db-init.js';

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0,
};

function calculateMetrics(rounds, currentIndex, lookback) {
  const startIdx = Math.max(0, currentIndex - lookback);
  const recentRounds = rounds.slice(startIdx, currentIndex + 1);

  if (recentRounds.length < 3) return null;

  const closePrices = recentRounds.map(r => r.close_price);
  const high = Math.max(...closePrices);
  const low = Math.min(...closePrices);
  const range = ((high - low) / low) * 100;

  const avg = closePrices.reduce((a, b) => a + b) / closePrices.length;
  const variance = closePrices.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / closePrices.length;
  const volatility = Math.sqrt(variance) / avg * 100;

  let emaFlips = 0;
  let prevSignal = null;
  for (const r of recentRounds) {
    const signal = r.ema_signal;
    if (signal && signal !== 'NEUTRAL') {
      if (prevSignal && signal !== prevSignal) emaFlips++;
      prevSignal = signal;
    }
  }
  const flipRate = emaFlips / recentRounds.length;

  const emaGaps = recentRounds
    .filter(r => r.ema_gap !== null && r.ema_gap !== undefined)
    .map(r => Math.abs(parseFloat(r.ema_gap)));
  const avgEmaGap = emaGaps.length > 0 ? emaGaps.reduce((a, b) => a + b, 0) / emaGaps.length : 0;

  return { range, volatility, flipRate, avgEmaGap };
}

function testStrategy(rounds, filterConfig) {
  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let wins = 0, losses = 0, skipped = 0;
  let consecutiveLosses = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;
  let cooldownUntilTimestamp = 0;
  let cbTriggered = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    // Calculate metrics
    const metrics = calculateMetrics(rounds, i, filterConfig.lookback);
    if (!metrics) continue;

    // Apply filters
    let shouldSkip = false;
    if (filterConfig.minRange && metrics.range < filterConfig.minRange) shouldSkip = true;
    if (filterConfig.minVolatility && metrics.volatility < filterConfig.minVolatility) shouldSkip = true;
    if (filterConfig.maxFlipRate && metrics.flipRate > filterConfig.maxFlipRate) shouldSkip = true;
    if (filterConfig.minEmaGap && metrics.avgEmaGap < filterConfig.minEmaGap) shouldSkip = true;

    if (shouldSkip) {
      skipped++;
      continue;
    }

    // Circuit breaker
    if (filterConfig.useCircuitBreaker && r.lock_timestamp < cooldownUntilTimestamp) {
      skipped++;
      continue;
    }

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

    let sizeMultiplier = 1.0;
    const emaGap = parseFloat(r.ema_gap) || 0;
    if (Math.abs(emaGap) >= 0.15) sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betAmount = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    const winner = r.winner ? r.winner.toLowerCase() : '';
    const won = (signal === 'BULL' && winner === 'bull') || (signal === 'BEAR' && winner === 'bear');

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

      if (filterConfig.useCircuitBreaker && consecutiveLosses >= 3) {
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

  return { roi, winRate, trades: totalTrades, wins, losses, skipped, maxDrawdown, bankroll, cbTriggered };
}

console.log('🎯 FINDING BEST WIN RATE STRATEGY\n');
console.log('═'.repeat(100));

const db = initDatabase('./prediction.db');
const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`\n📊 Total rounds: ${rounds.length}\n`);
console.log('═'.repeat(100));

const tests = [];

// Baseline
const baseline = testStrategy(rounds, { lookback: 12 });
tests.push({ name: 'BASELINE (No Filter)', ...baseline });

// Range filters
for (const minRange of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5]) {
  const result = testStrategy(rounds, { lookback: 12, minRange });
  tests.push({ name: `Range ≥${minRange}%`, ...result });
}

// Volatility filters
for (const minVol of [0.5, 0.7, 0.9, 1.0, 1.2, 1.5, 2.0]) {
  const result = testStrategy(rounds, { lookback: 12, minVolatility: minVol });
  tests.push({ name: `Vol ≥${minVol}%`, ...result });
}

// Flip rate filters
for (const maxFlip of [0.15, 0.20, 0.25, 0.30, 0.33]) {
  const result = testStrategy(rounds, { lookback: 12, maxFlipRate: maxFlip });
  tests.push({ name: `FlipRate ≤${(maxFlip*100).toFixed(0)}%`, ...result });
}

// Circuit breaker
const cb = testStrategy(rounds, { lookback: 12, useCircuitBreaker: true });
tests.push({ name: 'Circuit Breaker (3L, 45min)', ...cb });

// Combos
const combos = [
  { name: 'Range≥0.8% + CB', minRange: 0.8, useCircuitBreaker: true, lookback: 12 },
  { name: 'FlipRate≤20% + CB', maxFlipRate: 0.20, useCircuitBreaker: true, lookback: 12 },
  { name: 'Range≥0.8% + FlipRate≤20%', minRange: 0.8, maxFlipRate: 0.20, lookback: 12 },
  { name: 'Range≥0.8% + FlipRate≤20% + CB', minRange: 0.8, maxFlipRate: 0.20, useCircuitBreaker: true, lookback: 12 },
  { name: 'Range≥1.0% + CB', minRange: 1.0, useCircuitBreaker: true, lookback: 12 },
  { name: 'Range≥0.7% + CB', minRange: 0.7, useCircuitBreaker: true, lookback: 12 },
];

for (const combo of combos) {
  const result = testStrategy(rounds, combo);
  tests.push({ name: combo.name, ...result });
}

console.log('\n🏆 TOP 15 BY WIN RATE (Minimum 150 trades)\n');
console.log('─'.repeat(100));

const top15 = tests
  .filter(t => t.trades >= 150)
  .sort((a, b) => b.winRate - a.winRate)
  .slice(0, 15);

console.log(`Rank │ Strategy                           │ Win Rate │ Trades │   ROI    │ MaxDD  │ Final`);
console.log('─'.repeat(100));

for (let i = 0; i < top15.length; i++) {
  const t = top15[i];
  const rank = String(i + 1).padStart(2);
  const name = t.name.padEnd(34);
  const wr = `${t.winRate.toFixed(1)}%`.padStart(7);
  const trades = String(t.trades).padStart(6);
  const roi = `${t.roi >= 0 ? '+' : ''}${t.roi.toFixed(1)}%`.padStart(8);
  const dd = `${t.maxDrawdown.toFixed(1)}%`.padStart(6);
  const final = `${t.bankroll.toFixed(2)}`.padStart(5);

  console.log(`${rank}   │ ${name} │ ${wr} │ ${trades} │ ${roi} │ ${dd} │ ${final}`);
}

console.log('\n' + '═'.repeat(100));
console.log('\n📊 DETAILED TOP 5:\n');

for (let i = 0; i < Math.min(5, top15.length); i++) {
  const t = top15[i];
  console.log(`${i + 1}. ${t.name}`);
  console.log(`   Win Rate: ${t.winRate.toFixed(1)}% (${t.wins}W / ${t.losses}L)`);
  console.log(`   ROI: ${t.roi >= 0 ? '+' : ''}${t.roi.toFixed(1)}%  |  Final: ${t.bankroll.toFixed(2)} BNB`);
  console.log(`   Trades: ${t.trades} (${t.skipped} skipped)  |  MaxDD: ${t.maxDrawdown.toFixed(1)}%`);
  if (t.cbTriggered) console.log(`   Circuit Breaker Triggered: ${t.cbTriggered} times`);
  console.log();
}

console.log('═'.repeat(100));
console.log('\n💡 BASELINE COMPARISON:\n');
console.log(`   Win Rate: ${baseline.winRate.toFixed(1)}%`);
console.log(`   ROI: ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(1)}%`);
console.log(`   Trades: ${baseline.trades}`);
console.log(`   MaxDD: ${baseline.maxDrawdown.toFixed(1)}%`);

if (top15.length > 0) {
  const best = top15[0];
  const wrImprovement = best.winRate - baseline.winRate;
  const roiImprovement = best.roi - baseline.roi;

  console.log('\n🎯 BEST STRATEGY IMPROVEMENT:\n');
  console.log(`   Win Rate: ${wrImprovement >= 0 ? '+' : ''}${wrImprovement.toFixed(1)}% (${baseline.winRate.toFixed(1)}% → ${best.winRate.toFixed(1)}%)`);
  console.log(`   ROI: ${roiImprovement >= 0 ? '+' : ''}${roiImprovement.toFixed(1)}% (${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(1)}% → ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(1)}%)`);
  console.log(`   Trades: ${best.trades} (skipped ${best.skipped})`);
}

console.log('\n' + '═'.repeat(100));

db.close();
