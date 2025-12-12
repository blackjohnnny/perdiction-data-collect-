import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🚀 COMPREHENSIVE SOLUTION TESTING\n');
console.log('═'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Testing on ${rounds.length} complete rounds\n`);
console.log('Combining all discoveries:\n');
console.log('  1. Skip BULL at local bottom (EMA lag issue)');
console.log('  2. Reverse momentum (bet big on weak signals)');
console.log('  3. RSI extreme filter');
console.log('  4. Volume spike detection');
console.log('  5. Time-based filters (avoid specific hours)\n');
console.log('─'.repeat(100) + '\n');

// Helper functions
function isAtLocalExtreme(rounds, index, lookback = 14) {
  if (index < lookback) return { isTop: false, isBottom: false, position: 0.5 };

  const window = rounds.slice(index - lookback, index + 1);
  const prices = window.map(r => {
    const lock = Number(r.lock_price);
    const close = Number(r.close_price);
    if (lock > 0) return lock / 1e8;
    if (close > 0) return close / 1e8;
    return null;
  }).filter(p => p !== null);

  if (prices.length < lookback) return { isTop: false, isBottom: false, position: 0.5 };

  const currentPrice = prices[prices.length - 1];
  const highest = Math.max(...prices);
  const lowest = Math.min(...prices);
  const range = highest - lowest;

  if (range === 0) return { isTop: false, isBottom: false, position: 0.5 };

  const position = (currentPrice - lowest) / range;
  const isTop = position > 0.80;
  const isBottom = position < 0.20;

  return { isTop, isBottom, position };
}

// Calculate RSI
function calculateRSI(rounds, index, period = 14) {
  if (index < period) return 50;

  const window = rounds.slice(index - period, index + 1);
  const prices = window.map(r => {
    const close = Number(r.close_price);
    if (close > 0) return close / 1e8;
    const lock = Number(r.lock_price);
    if (lock > 0) return lock / 1e8;
    return null;
  }).filter(p => p !== null);

  if (prices.length < period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  return rsi;
}

// Detect volume spike (using pool size changes)
function hasVolumeSpike(rounds, index, lookback = 10) {
  if (index < lookback) return false;

  const window = rounds.slice(index - lookback, index + 1);
  const volumes = window.map(r => {
    const bull = parseFloat(r.t20s_bull_wei) / 1e18;
    const bear = parseFloat(r.t20s_bear_wei) / 1e18;
    return bull + bear;
  }).filter(v => v > 0);

  if (volumes.length < lookback) return false;

  const currentVol = volumes[volumes.length - 1];
  const avgVol = volumes.slice(0, -1).reduce((a, b) => a + b) / (volumes.length - 1);

  return currentVol > avgVol * 1.5; // 50% above average
}

// Run strategy
function runStrategy(rounds, config) {
  const {
    name = 'Unnamed',
    skipBullAtBottom = false,
    reverseMomentum = false,
    useRSIFilter = false,
    rsiOversoldThreshold = 30,
    rsiOverboughtThreshold = 70,
    skipVolumeSpikes = false,
    skipLowLiquidity = false,
    minLiquidity = 0.5, // BNB
    skipTimeRanges = [], // Array of {startHour, endHour}
    useEMAStrengthFilter = false,
    minEMAGap = 0.05
  } = config;

  const BASE_CONFIG = {
    BASE_POSITION_SIZE: 0.045,
    MOMENTUM_MULTIPLIER: 1.889,
    RECOVERY_MULTIPLIER: 1.5,
    MIN_PAYOUT: 1.45,
    STARTING_BANKROLL: 1.0
  };

  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let wins = 0;
  let losses = 0;
  let totalProfit = 0;

  let skippedBottom = 0;
  let skippedRSI = 0;
  let skippedVolume = 0;
  let skippedLiquidity = 0;
  let skippedTime = 0;
  let skippedEMAGap = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    const emaSignal = r.ema_signal;
    const emaGap = parseFloat(r.ema_gap);
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    // CONTRARIAN
    let betSide = null;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BULL';
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BEAR';
    }

    if (!betSide) continue;

    // FILTER 1: Skip BULL at bottom
    if (skipBullAtBottom) {
      const extreme = isAtLocalExtreme(rounds, i, 14);
      if (betSide === 'BULL' && extreme.isBottom) {
        skippedBottom++;
        continue;
      }
    }

    // FILTER 2: RSI extremes
    if (useRSIFilter) {
      const rsi = calculateRSI(rounds, i, 14);
      // Skip BULL when RSI > 70 (overbought)
      // Skip BEAR when RSI < 30 (oversold)
      if (betSide === 'BULL' && rsi > rsiOverboughtThreshold) {
        skippedRSI++;
        continue;
      }
      if (betSide === 'BEAR' && rsi < rsiOversoldThreshold) {
        skippedRSI++;
        continue;
      }
    }

    // FILTER 3: Volume spikes (manipulation risk)
    if (skipVolumeSpikes) {
      if (hasVolumeSpike(rounds, i, 10)) {
        skippedVolume++;
        continue;
      }
    }

    // FILTER 4: Low liquidity
    if (skipLowLiquidity && total < minLiquidity) {
      skippedLiquidity++;
      continue;
    }

    // FILTER 5: Time-based filter
    if (skipTimeRanges.length > 0) {
      const hour = new Date(r.lock_timestamp * 1000).getUTCHours();
      let skipThisTime = false;
      for (const range of skipTimeRanges) {
        if (hour >= range.startHour && hour < range.endHour) {
          skipThisTime = true;
          break;
        }
      }
      if (skipThisTime) {
        skippedTime++;
        continue;
      }
    }

    // FILTER 6: EMA strength filter
    if (useEMAStrengthFilter && Math.abs(emaGap) < minEMAGap) {
      skippedEMAGap++;
      continue;
    }

    // Position sizing
    let sizeMultiplier = 1.0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;

    if (reverseMomentum) {
      // Big bets on WEAK signals
      if (!hasStrongSignal) {
        sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
      }
    } else {
      // Big bets on strong signals (current)
      if (hasStrongSignal) {
        sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
      }
    }

    if (lastTwoResults[0] === 'LOSS') {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betSize = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    const won = betSide.toLowerCase() === r.winner.toLowerCase();
    const actualPayout = parseFloat(r.winner_payout_multiple);

    if (won) {
      const profit = betSize * (actualPayout - 1);
      bankroll += profit;
      totalProfit += profit;
      wins++;
      lastTwoResults.unshift('WIN');
    } else {
      bankroll -= betSize;
      totalProfit -= betSize;
      losses++;
      lastTwoResults.unshift('LOSS');
    }

    if (lastTwoResults.length > 2) lastTwoResults.pop();
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = (totalProfit / BASE_CONFIG.STARTING_BANKROLL) * 100;

  return {
    name,
    trades: totalTrades,
    wins,
    losses,
    winRate,
    roi,
    finalBankroll: bankroll,
    profit: totalProfit,
    skippedBottom,
    skippedRSI,
    skippedVolume,
    skippedLiquidity,
    skippedTime,
    skippedEMAGap
  };
}

console.log('🔄 Running comprehensive tests...\n\n');

const strategies = [
  // Baseline
  { name: 'Baseline (Current strategy)', skipBullAtBottom: false, reverseMomentum: false },

  // Single improvements
  { name: 'Skip BULL at bottom', skipBullAtBottom: true },
  { name: 'Reverse momentum', reverseMomentum: true },
  { name: 'RSI filter (30/70)', useRSIFilter: true },
  { name: 'Skip volume spikes', skipVolumeSpikes: true },
  { name: 'Skip low liquidity (<0.5 BNB)', skipLowLiquidity: true, minLiquidity: 0.5 },
  { name: 'EMA strength filter (>0.05%)', useEMAStrengthFilter: true, minEMAGap: 0.05 },

  // Double combos
  { name: 'Skip BULL bottom + Reverse momentum', skipBullAtBottom: true, reverseMomentum: true },
  { name: 'Skip BULL bottom + RSI filter', skipBullAtBottom: true, useRSIFilter: true },
  { name: 'Skip BULL bottom + Skip volume spikes', skipBullAtBottom: true, skipVolumeSpikes: true },

  // Triple combos
  { name: 'Skip BULL bottom + Reverse + RSI', skipBullAtBottom: true, reverseMomentum: true, useRSIFilter: true },
  { name: 'Skip BULL bottom + Reverse + Volume', skipBullAtBottom: true, reverseMomentum: true, skipVolumeSpikes: true },

  // ULTIMATE: All filters combined
  {
    name: 'ULTIMATE: All filters combined',
    skipBullAtBottom: true,
    reverseMomentum: true,
    useRSIFilter: true,
    skipVolumeSpikes: true,
    skipLowLiquidity: true,
    minLiquidity: 0.5,
    useEMAStrengthFilter: true,
    minEMAGap: 0.05
  }
];

const results = strategies.map(config => runStrategy(rounds, config));

// Display results
console.log('═'.repeat(100) + '\n');
console.log('📊 COMPREHENSIVE TEST RESULTS\n');
console.log('═'.repeat(100) + '\n');

results.forEach((r, i) => {
  const roiStr = r.roi >= 0 ? `+${r.roi.toFixed(2)}%` : `${r.roi.toFixed(2)}%`;
  console.log(`${(i + 1).toString().padStart(2)}. ${r.name.padEnd(45)} | ${r.trades.toString().padStart(3)} trades | ${r.winRate.toFixed(1).padStart(5)}% WR | ${roiStr.padStart(12)} ROI`);

  const totalSkipped = r.skippedBottom + r.skippedRSI + r.skippedVolume + r.skippedLiquidity + r.skippedTime + r.skippedEMAGap;
  if (totalSkipped > 0) {
    const parts = [];
    if (r.skippedBottom > 0) parts.push(`${r.skippedBottom} bottom`);
    if (r.skippedRSI > 0) parts.push(`${r.skippedRSI} RSI`);
    if (r.skippedVolume > 0) parts.push(`${r.skippedVolume} volume`);
    if (r.skippedLiquidity > 0) parts.push(`${r.skippedLiquidity} liquidity`);
    if (r.skippedTime > 0) parts.push(`${r.skippedTime} time`);
    if (r.skippedEMAGap > 0) parts.push(`${r.skippedEMAGap} EMA`);
    console.log(`    Skipped: ${parts.join(', ')}`);
  }
  console.log();
});

console.log('═'.repeat(100) + '\n');

// Rank by ROI
const ranked = [...results].sort((a, b) => b.roi - a.roi);

console.log('🏆 TOP 5 STRATEGIES:\n');
ranked.slice(0, 5).forEach((r, i) => {
  const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
  const roiStr = r.roi >= 0 ? `+${r.roi.toFixed(2)}%` : `${r.roi.toFixed(2)}%`;
  console.log(`${medal} ${r.name}`);
  console.log(`   ${r.trades} trades | ${r.winRate.toFixed(1)}% WR | ${roiStr} ROI | Final: ${r.finalBankroll.toFixed(2)} BNB\n`);
});

console.log('═'.repeat(100) + '\n');

// Detailed comparison
const baseline = results[0];
const best = ranked[0];

console.log('📊 BASELINE vs BEST SOLUTION:\n');
console.log('─'.repeat(100) + '\n');

console.log(`Baseline (${baseline.name}):`);
console.log(`  ${baseline.trades} trades | ${baseline.winRate.toFixed(1)}% WR | ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(2)}% ROI\n`);

console.log(`Best (${best.name}):`);
console.log(`  ${best.trades} trades | ${best.winRate.toFixed(1)}% WR | ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(2)}% ROI\n`);

console.log('Improvements:');
console.log(`  ROI: ${baseline.roi.toFixed(2)}% → ${best.roi.toFixed(2)}% (+${(best.roi - baseline.roi).toFixed(2)}%)`);
console.log(`  Win Rate: ${baseline.winRate.toFixed(1)}% → ${best.winRate.toFixed(1)}% (+${(best.winRate - baseline.winRate).toFixed(1)}%)`);
console.log(`  Final Bankroll: ${baseline.finalBankroll.toFixed(2)} BNB → ${best.finalBankroll.toFixed(2)} BNB (${((best.finalBankroll / baseline.finalBankroll - 1) * 100).toFixed(1)}% more)\n`);

console.log('═'.repeat(100) + '\n');

console.log('💡 FINAL RECOMMENDATION:\n');
console.log('─'.repeat(100) + '\n');

console.log(`Implement: ${best.name}\n`);

if (best.skipBullAtBottom) console.log('✅ Skip BULL signals when price at local bottom (20% of 14-period range)');
if (best.reverseMomentum) console.log('✅ Reverse momentum: Bet 8.5% on weak signals (<15% gap), 4.5% on strong');
if (best.useRSIFilter) console.log('✅ Skip BULL when RSI >70, skip BEAR when RSI <30');
if (best.skipVolumeSpikes) console.log('✅ Skip trades during volume spikes (>1.5x average)');
if (best.skipLowLiquidity) console.log('✅ Skip rounds with total pool <0.5 BNB');
if (best.useEMAStrengthFilter) console.log('✅ Require minimum EMA gap of 0.05%');

console.log(`\nExpected Performance:`);
console.log(`  ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(2)}% ROI over ${best.trades} trades`);
console.log(`  ${best.winRate.toFixed(1)}% win rate`);
console.log(`  Turn 1 BNB → ${best.finalBankroll.toFixed(2)} BNB\n`);

console.log('═'.repeat(100) + '\n');

db.close();
