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

  // Volatility (std dev)
  const avg = closePrices.reduce((a, b) => a + b) / closePrices.length;
  const variance = closePrices.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / closePrices.length;
  const volatility = Math.sqrt(variance) / avg * 100;

  // EMA flips
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

  // Avg EMA gap
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
  let peak = bankroll;
  let maxDrawdown = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    // Calculate metrics
    const metrics = calculateMetrics(rounds, i, filterConfig.lookback);
    if (!metrics) continue;

    // Apply filter
    let shouldSkip = false;
    if (filterConfig.minRange && metrics.range < filterConfig.minRange) shouldSkip = true;
    if (filterConfig.minVolatility && metrics.volatility < filterConfig.minVolatility) shouldSkip = true;
    if (filterConfig.maxFlipRate && metrics.flipRate > filterConfig.maxFlipRate) shouldSkip = true;
    if (filterConfig.minEmaGap && metrics.avgEmaGap < filterConfig.minEmaGap) shouldSkip = true;

    if (shouldSkip) {
      skipped++;
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
    if (consecutiveLosses >= 2) sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;

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
    }

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const roi = ((bankroll - BASE_CONFIG.STARTING_BANKROLL) / BASE_CONFIG.STARTING_BANKROLL) * 100;

  return { roi, winRate, trades: totalTrades, wins, losses, skipped, maxDrawdown, bankroll };
}

console.log('🔍 CONSOLIDATION FILTER OPTIMIZATION\n');
console.log('═'.repeat(120));
console.log('\nTesting different combinations to find BEST filter for detecting consolidation/trending markets\n');
console.log('─'.repeat(120));

const db = initDatabase('./prediction.db');
const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`\n📊 Total rounds: ${rounds.length}\n`);
console.log('═'.repeat(120));

// Test different configurations
const tests = [];

// 1. RANGE-BASED FILTERS (different thresholds)
console.log('\n📐 RANGE-BASED FILTERS (Skip when price range < X%)\n');
for (const minRange of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5]) {
  const result = testStrategy(rounds, { lookback: 12, minRange });
  tests.push({ name: `Range ≥${minRange}%`, ...result });
  console.log(`Range ≥${minRange.toFixed(1)}%:  ROI: ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(1)}%  |  WR: ${result.winRate.toFixed(1)}%  |  Trades: ${result.trades}  |  Skipped: ${result.skipped}  |  MaxDD: ${result.maxDrawdown.toFixed(1)}%`);
}

// 2. VOLATILITY-BASED FILTERS
console.log('\n\n📊 VOLATILITY-BASED FILTERS (Skip when volatility < X%)\n');
for (const minVol of [0.3, 0.5, 0.7, 0.9, 1.0, 1.2, 1.5, 2.0]) {
  const result = testStrategy(rounds, { lookback: 12, minVolatility: minVol });
  tests.push({ name: `Vol ≥${minVol}%`, ...result });
  console.log(`Vol ≥${minVol.toFixed(1)}%:  ROI: ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(1)}%  |  WR: ${result.winRate.toFixed(1)}%  |  Trades: ${result.trades}  |  Skipped: ${result.skipped}  |  MaxDD: ${result.maxDrawdown.toFixed(1)}%`);
}

// 3. FLIP RATE FILTERS (Skip when too choppy)
console.log('\n\n🔄 FLIP RATE FILTERS (Skip when EMA flips too often = choppy)\n');
for (const maxFlip of [0.15, 0.20, 0.25, 0.30, 0.33, 0.40]) {
  const result = testStrategy(rounds, { lookback: 12, maxFlipRate: maxFlip });
  tests.push({ name: `FlipRate ≤${(maxFlip*100).toFixed(0)}%`, ...result });
  console.log(`FlipRate ≤${(maxFlip*100).toFixed(0)}%:  ROI: ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(1)}%  |  WR: ${result.winRate.toFixed(1)}%  |  Trades: ${result.trades}  |  Skipped: ${result.skipped}  |  MaxDD: ${result.maxDrawdown.toFixed(1)}%`);
}

// 4. EMA GAP FILTERS (Skip when EMA gap is weak)
console.log('\n\n📏 EMA GAP STRENGTH FILTERS (Skip when avg EMA gap < X%)\n');
for (const minGap of [0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25]) {
  const result = testStrategy(rounds, { lookback: 12, minEmaGap: minGap });
  tests.push({ name: `EmaGap ≥${minGap}%`, ...result });
  console.log(`EmaGap ≥${minGap.toFixed(2)}%:  ROI: ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(1)}%  |  WR: ${result.winRate.toFixed(1)}%  |  Trades: ${result.trades}  |  Skipped: ${result.skipped}  |  MaxDD: ${result.maxDrawdown.toFixed(1)}%`);
}

// 5. LOOKBACK PERIOD (different windows)
console.log('\n\n⏱️  LOOKBACK PERIOD (Using Range ≥0.8% filter with different windows)\n');
for (const lookback of [6, 8, 10, 12, 15, 18, 24]) {
  const result = testStrategy(rounds, { lookback, minRange: 0.8 });
  tests.push({ name: `Lookback ${lookback} rounds`, ...result });
  console.log(`Lookback ${lookback}:  ROI: ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(1)}%  |  WR: ${result.winRate.toFixed(1)}%  |  Trades: ${result.trades}  |  Skipped: ${result.skipped}  |  MaxDD: ${result.maxDrawdown.toFixed(1)}%`);
}

// 6. COMBO FILTERS
console.log('\n\n🎯 COMBINATION FILTERS\n');

const combos = [
  { name: 'Range≥0.7% + Vol≥0.8%', minRange: 0.7, minVolatility: 0.8, lookback: 12 },
  { name: 'Range≥0.8% + Vol≥1.0%', minRange: 0.8, minVolatility: 1.0, lookback: 12 },
  { name: 'Range≥0.8% + FlipRate≤25%', minRange: 0.8, maxFlipRate: 0.25, lookback: 12 },
  { name: 'Range≥0.8% + EmaGap≥0.12%', minRange: 0.8, minEmaGap: 0.12, lookback: 12 },
  { name: 'Vol≥1.0% + FlipRate≤25%', minVolatility: 1.0, maxFlipRate: 0.25, lookback: 12 },
  { name: 'Vol≥1.0% + EmaGap≥0.12%', minVolatility: 1.0, minEmaGap: 0.12, lookback: 12 },
  { name: 'Range≥0.7% + Vol≥0.8% + FlipRate≤30%', minRange: 0.7, minVolatility: 0.8, maxFlipRate: 0.30, lookback: 12 },
  { name: 'Range≥0.8% + Vol≥1.0% + EmaGap≥0.12%', minRange: 0.8, minVolatility: 1.0, minEmaGap: 0.12, lookback: 12 },
  { name: 'Range≥0.6% + Vol≥0.7% + FlipRate≤25% + EmaGap≥0.10%', minRange: 0.6, minVolatility: 0.7, maxFlipRate: 0.25, minEmaGap: 0.10, lookback: 12 },
];

for (const combo of combos) {
  const result = testStrategy(rounds, combo);
  tests.push({ name: combo.name, ...result });
  console.log(`${combo.name}:`);
  console.log(`  ROI: ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(1)}%  |  WR: ${result.winRate.toFixed(1)}%  |  Trades: ${result.trades}  |  Skipped: ${result.skipped}  |  MaxDD: ${result.maxDrawdown.toFixed(1)}%`);
  console.log();
}

// Find top performers
console.log('═'.repeat(120));
console.log('\n🏆 TOP 10 PERFORMERS (by ROI)\n');
console.log('─'.repeat(120));

const baseline = testStrategy(rounds, { lookback: 12 });
console.log(`\nBASELINE (No Filter): ROI: +${baseline.roi.toFixed(1)}%  |  WR: ${baseline.winRate.toFixed(1)}%  |  Trades: ${baseline.trades}  |  MaxDD: ${baseline.maxDrawdown.toFixed(1)}%\n`);
console.log('─'.repeat(120));

tests.sort((a, b) => b.roi - a.roi);
const top10 = tests.slice(0, 10);

for (let i = 0; i < top10.length; i++) {
  const t = top10[i];
  const improvement = t.roi - baseline.roi;
  console.log(`${i + 1}. ${t.name}`);
  console.log(`   ROI: ${t.roi >= 0 ? '+' : ''}${t.roi.toFixed(1)}% (${improvement >= 0 ? '+' : ''}${improvement.toFixed(1)}% vs baseline)`);
  console.log(`   WR: ${t.winRate.toFixed(1)}%  |  Trades: ${t.trades} (${t.skipped} skipped)  |  MaxDD: ${t.maxDrawdown.toFixed(1)}%`);
  console.log();
}

// Find best by drawdown
console.log('═'.repeat(120));
console.log('\n🛡️  TOP 5 BY LOWEST DRAWDOWN (Min 150 trades)\n');
console.log('─'.repeat(120));

const lowDD = tests.filter(t => t.trades >= 150).sort((a, b) => a.maxDrawdown - b.maxDrawdown).slice(0, 5);
for (let i = 0; i < lowDD.length; i++) {
  const t = lowDD[i];
  console.log(`${i + 1}. ${t.name}`);
  console.log(`   MaxDD: ${t.maxDrawdown.toFixed(1)}% (vs ${baseline.maxDrawdown.toFixed(1)}% baseline)`);
  console.log(`   ROI: ${t.roi >= 0 ? '+' : ''}${t.roi.toFixed(1)}%  |  WR: ${t.winRate.toFixed(1)}%  |  Trades: ${t.trades}`);
  console.log();
}

// Find best risk-adjusted (ROI / MaxDD)
console.log('═'.repeat(120));
console.log('\n⚖️  TOP 5 RISK-ADJUSTED (ROI / MaxDD ratio, min 150 trades)\n');
console.log('─'.repeat(120));

const riskAdjusted = tests
  .filter(t => t.trades >= 150 && t.maxDrawdown > 0)
  .map(t => ({ ...t, ratio: t.roi / t.maxDrawdown }))
  .sort((a, b) => b.ratio - a.ratio)
  .slice(0, 5);

for (let i = 0; i < riskAdjusted.length; i++) {
  const t = riskAdjusted[i];
  console.log(`${i + 1}. ${t.name}`);
  console.log(`   Risk Ratio: ${t.ratio.toFixed(2)} (ROI/MaxDD)`);
  console.log(`   ROI: ${t.roi >= 0 ? '+' : ''}${t.roi.toFixed(1)}%  |  MaxDD: ${t.maxDrawdown.toFixed(1)}%  |  Trades: ${t.trades}`);
  console.log();
}

console.log('═'.repeat(120));

db.close();
