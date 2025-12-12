import { initDatabase } from './db-init.js';

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0,
  EMA_GAP_THRESHOLD: 0.0015
};

function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function detectConsolidation(rounds, currentIndex, lookback = 12) {
  const startIdx = Math.max(0, currentIndex - lookback);
  const recentRounds = rounds.slice(startIdx, currentIndex + 1);

  if (recentRounds.length < 6) return { isConsolidating: false };

  const closePrices = recentRounds.map(r => r.close_price);
  const high = Math.max(...closePrices);
  const low = Math.min(...closePrices);
  const range = ((high - low) / low) * 100;

  // Calculate price volatility (std dev)
  const avg = closePrices.reduce((a, b) => a + b) / closePrices.length;
  const variance = closePrices.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / closePrices.length;
  const volatility = Math.sqrt(variance) / avg * 100;

  // Count EMA flips (trend changes)
  let emaFlips = 0;
  let prevSignal = null;
  for (let i = 0; i < recentRounds.length; i++) {
    const r = recentRounds[i];
    const signal = r.ema_signal;
    if (signal && signal !== 'NEUTRAL') {
      if (prevSignal && signal !== prevSignal) emaFlips++;
      prevSignal = signal;
    }
  }
  const flipRate = emaFlips / recentRounds.length;

  // Calculate EMA gap strength (average)
  const emaGaps = recentRounds
    .filter(r => r.ema_gap !== null && r.ema_gap !== undefined)
    .map(r => Math.abs(parseFloat(r.ema_gap)));
  const avgEmaGap = emaGaps.length > 0 ? emaGaps.reduce((a, b) => a + b, 0) / emaGaps.length : 0;

  return {
    range,           // Price range %
    volatility,      // Price std dev %
    flipRate,        // EMA flip frequency
    avgEmaGap,       // Avg EMA gap strength
    emaFlips
  };
}

function testConsolidationFilters() {
  const db = initDatabase('./prediction.db');

  const rounds = db.prepare(`
    SELECT *
    FROM rounds
    WHERE t20s_timestamp IS NOT NULL
      AND winner IS NOT NULL
      AND ema_signal IS NOT NULL
    ORDER BY lock_timestamp ASC
  `).all();

  console.log('🔍 CONSOLIDATION DETECTION TEST\n');
  console.log('═'.repeat(100));
  console.log(`\n📊 Analyzing ${rounds.length} rounds\n`);

  // Test different consolidation filters
  const filters = [
    { name: 'BASELINE (No Filter)', check: () => true },
    { name: 'Skip Low Volatility (<0.5%)', check: (m) => m.volatility >= 0.5 },
    { name: 'Skip Low Volatility (<1.0%)', check: (m) => m.volatility >= 1.0 },
    { name: 'Skip Tight Range (<0.8%)', check: (m) => m.range >= 0.8 },
    { name: 'Skip High Flip Rate (>33%)', check: (m) => m.flipRate <= 0.33 },
    { name: 'Skip Weak EMA Gap (<0.12%)', check: (m) => m.avgEmaGap >= 0.0012 },
    { name: 'Skip Weak EMA Gap (<0.15%)', check: (m) => m.avgEmaGap >= 0.0015 },
    { name: 'COMBO: Vol≥1% + Range≥0.8%', check: (m) => m.volatility >= 1.0 && m.range >= 0.8 },
    { name: 'COMBO: Vol≥0.8% + FlipRate≤25%', check: (m) => m.volatility >= 0.8 && m.flipRate <= 0.25 },
    { name: 'COMBO: Vol≥0.8% + EMAGap≥0.12%', check: (m) => m.volatility >= 0.8 && m.avgEmaGap >= 0.0012 },
  ];

  console.log('─'.repeat(100));
  console.log('\n🧪 TESTING FILTERS:\n');

  for (const filter of filters) {
    let bankroll = BASE_CONFIG.STARTING_BANKROLL;
    let wins = 0, losses = 0, skipped = 0;
    let consecutiveLosses = 0;
    let maxDrawdown = 0;
    let peak = bankroll;

    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];

      // Calculate consolidation metrics
      const metrics = detectConsolidation(rounds, i, 12);

      // Apply filter
      if (!filter.check(metrics)) {
        skipped++;
        continue;
      }

      // Generate signal (EMA contrarian)
      const emaSignal = r.ema_signal;
      if (!emaSignal || emaSignal === 'NEUTRAL') continue;

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
      if (Math.abs(emaGap) >= 0.15) {
        sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
      }
      if (consecutiveLosses >= 2) {
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
      }

      if (bankroll > peak) peak = bankroll;
      const drawdown = ((peak - bankroll) / peak) * 100;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
    const roi = ((bankroll - BASE_CONFIG.STARTING_BANKROLL) / BASE_CONFIG.STARTING_BANKROLL) * 100;

    console.log(`${filter.name}:`);
    console.log(`  ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%  |  WR: ${winRate.toFixed(1)}%  |  Trades: ${totalTrades} (${wins}W/${losses}L)  |  Skipped: ${skipped}  |  Max DD: ${maxDrawdown.toFixed(1)}%`);
    console.log();
  }

  console.log('─'.repeat(100));
  console.log('\n📊 ANALYZING METRICS DURING WIN STREAKS vs LOSS STREAKS:\n');

  // Analyze metrics during streaks
  const streakMetrics = { wins: [], losses: [] };
  let currentStreak = { type: null, count: 0, metrics: [] };

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const metrics = detectConsolidation(rounds, i, 12);

    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

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

    const winner = r.winner ? r.winner.toLowerCase() : '';
    const won = (signal === 'BULL' && winner === 'bull') || (signal === 'BEAR' && winner === 'bear');

    if (currentStreak.type === null) {
      currentStreak.type = won ? 'win' : 'loss';
      currentStreak.count = 1;
      currentStreak.metrics = [metrics];
    } else if ((won && currentStreak.type === 'win') || (!won && currentStreak.type === 'loss')) {
      currentStreak.count++;
      currentStreak.metrics.push(metrics);
    } else {
      // Streak ended
      if (currentStreak.count >= 3) {
        const avgMetrics = {
          volatility: currentStreak.metrics.reduce((s, m) => s + m.volatility, 0) / currentStreak.metrics.length,
          range: currentStreak.metrics.reduce((s, m) => s + m.range, 0) / currentStreak.metrics.length,
          flipRate: currentStreak.metrics.reduce((s, m) => s + m.flipRate, 0) / currentStreak.metrics.length,
          avgEmaGap: currentStreak.metrics.reduce((s, m) => s + m.avgEmaGap, 0) / currentStreak.metrics.length,
        };

        if (currentStreak.type === 'win') streakMetrics.wins.push(avgMetrics);
        else streakMetrics.losses.push(avgMetrics);
      }

      currentStreak = { type: won ? 'win' : 'loss', count: 1, metrics: [metrics] };
    }
  }

  // Calculate averages
  const avgWinMetrics = {
    volatility: streakMetrics.wins.reduce((s, m) => s + m.volatility, 0) / streakMetrics.wins.length,
    range: streakMetrics.wins.reduce((s, m) => s + m.range, 0) / streakMetrics.wins.length,
    flipRate: streakMetrics.wins.reduce((s, m) => s + m.flipRate, 0) / streakMetrics.wins.length,
    avgEmaGap: streakMetrics.wins.reduce((s, m) => s + m.avgEmaGap, 0) / streakMetrics.wins.length * 100,
  };

  const avgLossMetrics = {
    volatility: streakMetrics.losses.reduce((s, m) => s + m.volatility, 0) / streakMetrics.losses.length,
    range: streakMetrics.losses.reduce((s, m) => s + m.range, 0) / streakMetrics.losses.length,
    flipRate: streakMetrics.losses.reduce((s, m) => s + m.flipRate, 0) / streakMetrics.losses.length,
    avgEmaGap: streakMetrics.losses.reduce((s, m) => s + m.avgEmaGap, 0) / streakMetrics.losses.length * 100,
  };

  console.log(`DURING WIN STREAKS (3+):`);
  console.log(`  Volatility: ${avgWinMetrics.volatility.toFixed(2)}%`);
  console.log(`  Range: ${avgWinMetrics.range.toFixed(2)}%`);
  console.log(`  Flip Rate: ${(avgWinMetrics.flipRate * 100).toFixed(1)}%`);
  console.log(`  EMA Gap: ${avgWinMetrics.avgEmaGap.toFixed(3)}%`);
  console.log();

  console.log(`DURING LOSS STREAKS (3+):`);
  console.log(`  Volatility: ${avgLossMetrics.volatility.toFixed(2)}%`);
  console.log(`  Range: ${avgLossMetrics.range.toFixed(2)}%`);
  console.log(`  Flip Rate: ${(avgLossMetrics.flipRate * 100).toFixed(1)}%`);
  console.log(`  EMA Gap: ${avgLossMetrics.avgEmaGap.toFixed(3)}%`);
  console.log();

  console.log('─'.repeat(100));
  console.log('\n💡 DIFFERENCE (Win - Loss):\n');
  console.log(`  Volatility: ${(avgWinMetrics.volatility - avgLossMetrics.volatility >= 0 ? '+' : '')}${(avgWinMetrics.volatility - avgLossMetrics.volatility).toFixed(2)}%`);
  console.log(`  Range: ${(avgWinMetrics.range - avgLossMetrics.range >= 0 ? '+' : '')}${(avgWinMetrics.range - avgLossMetrics.range).toFixed(2)}%`);
  console.log(`  Flip Rate: ${(avgWinMetrics.flipRate - avgLossMetrics.flipRate >= 0 ? '+' : '')}${((avgWinMetrics.flipRate - avgLossMetrics.flipRate) * 100).toFixed(1)}%`);
  console.log(`  EMA Gap: ${(avgWinMetrics.avgEmaGap - avgLossMetrics.avgEmaGap >= 0 ? '+' : '')}${(avgWinMetrics.avgEmaGap - avgLossMetrics.avgEmaGap).toFixed(3)}%`);

  console.log('\n' + '═'.repeat(100));

  db.close();
}

testConsolidationFilters();
