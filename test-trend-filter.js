import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('🧪 TESTING TREND FILTER THEORY\n');
console.log('Strategy: REVERSE CROWD + Trend Filter\n');
console.log('Logic: During trends, ONLY take REVERSE CROWD trades aligned with trend direction\n');

// Calculate ATR using close prices
function calculateATR(prices, period = 14) {
  if (prices.length < period + 1) return null;

  const trueRanges = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    if (i <= 0) continue;
    const tr = Math.abs(prices[i] - prices[i - 1]);
    trueRanges.push(tr);
  }

  return trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
}

// ATR Expansion trend detection
function detectATRTrend(prices) {
  if (prices.length < 30) return { detected: false };

  const currentATR = calculateATR(prices, 14);
  const avgATR = calculateATR(prices.slice(0, -5), 14);

  if (!currentATR || !avgATR) return { detected: false };

  const atrRatio = currentATR / avgATR;
  const detected = atrRatio > 1.5;

  const currentPrice = prices[prices.length - 1];
  const prevPrice = prices[prices.length - 2];
  const direction = currentPrice > prevPrice ? 'BULL' : 'BEAR';

  return { detected, direction, strength: atrRatio };
}

function shouldExitATRTrend(prices) {
  const newATR = calculateATR(prices, 14);
  const newAvgATR = calculateATR(prices.slice(0, -5), 14);
  return newATR && newAvgATR && (newATR / newAvgATR) < 1.2;
}

// Range Breakout trend detection
function detectRangeTrend(prices) {
  if (prices.length < 15) return { detected: false };

  const consolidation = prices.slice(-11, -1);
  const high = Math.max(...consolidation);
  const low = Math.min(...consolidation);
  const rangePercent = (high - low) / low * 100;

  const isTightRange = rangePercent < 1.0;
  const currentPrice = prices[prices.length - 1];
  const breakoutUp = currentPrice > high * 1.003;
  const breakoutDown = currentPrice < low * 0.997;

  const detected = isTightRange && (breakoutUp || breakoutDown);

  return {
    detected,
    direction: breakoutUp ? 'BULL' : breakoutDown ? 'BEAR' : null,
    range: { high, low }
  };
}

function shouldExitRangeTrend(prices, entryRange) {
  if (!entryRange) return false;
  const currentPrice = prices[prices.length - 1];
  return currentPrice <= entryRange.high && currentPrice >= entryRange.low;
}

// Momentum trend detection
function detectMomentumTrend(prices) {
  if (prices.length < 10) return { detected: false };

  const recentPrices = prices.slice(-5);
  const olderPrices = prices.slice(-10, -5);

  const recentAvg = recentPrices.reduce((a, b) => a + b) / recentPrices.length;
  const olderAvg = olderPrices.reduce((a, b) => a + b) / olderPrices.length;

  const momentum = ((recentAvg - olderAvg) / olderAvg) * 100;
  const detected = Math.abs(momentum) > 0.5; // 0.5% momentum threshold

  return {
    detected,
    direction: momentum > 0 ? 'BULL' : 'BEAR',
    strength: Math.abs(momentum)
  };
}

function shouldExitMomentumTrend(prices) {
  if (prices.length < 10) return false;

  const recentPrices = prices.slice(-5);
  const olderPrices = prices.slice(-10, -5);

  const recentAvg = recentPrices.reduce((a, b) => a + b) / recentPrices.length;
  const olderAvg = olderPrices.reduce((a, b) => a + b) / olderPrices.length;

  const momentum = ((recentAvg - olderAvg) / olderAvg) * 100;
  return Math.abs(momentum) < 0.2; // Exit when momentum drops below 0.2%
}

function runBacktest(testName, detectionFunc, exitFunc, durationRounds) {
  const isDynamic = durationRounds === 'dynamic';

  const rounds = db.prepare(`
    SELECT epoch, lock_timestamp, ema_signal, ema_gap,
           t20s_bull_wei, t20s_bear_wei, winner, close_price
    FROM rounds
    WHERE t20s_bull_wei IS NOT NULL
      AND t20s_bear_wei IS NOT NULL
      AND winner IS NOT NULL
      AND ema_signal IS NOT NULL
      AND close_price IS NOT NULL
    ORDER BY epoch ASC
  `).all();

  let bankroll = 1, peak = 1, maxDrawdown = 0;
  let wins = 0, losses = 0, skipped = 0;
  let normalWins = 0, normalLosses = 0;
  let trendWins = 0, trendLosses = 0;
  let cbActive = false, cbLossStreak = 0, cbCooldownUntil = null;
  let lastTwoResults = [];
  let inTrend = false, trendRoundsRemaining = 0, trendCount = 0;
  let trendDirection = null, trendEntryData = null;
  let skippedCounterTrend = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;
    if (totalAmount === 0) continue;

    const bullPayout = (totalAmount * 0.97) / bullAmount;
    const bearPayout = (totalAmount * 0.97) / bearAmount;

    // Circuit breaker
    if (cbActive && cbCooldownUntil && r.lock_timestamp < cbCooldownUntil) continue;
    if (cbActive && cbCooldownUntil && r.lock_timestamp >= cbCooldownUntil) {
      cbActive = false;
      cbCooldownUntil = null;
      cbLossStreak = 0;
    }

    // Get price history
    const priceHistory = rounds.slice(Math.max(0, i - 30), i + 1).map(r => r.close_price);

    // Check trend exit (dynamic mode)
    if (isDynamic && inTrend && priceHistory.length >= 20) {
      if (exitFunc(priceHistory, trendEntryData)) {
        inTrend = false;
        trendRoundsRemaining = 0;
        trendDirection = null;
      }
    }

    // Check for new trend detection
    if (!inTrend && priceHistory.length >= 30 && testName !== 'baseline') {
      const trend = detectionFunc(priceHistory);
      if (trend.detected) {
        inTrend = true;
        trendCount++;
        trendDirection = trend.direction;
        trendEntryData = trend;
        trendRoundsRemaining = isDynamic ? 999 : durationRounds;
      }
    }

    // Decrement trend counter (fixed duration)
    if (!isDynamic && inTrend && trendRoundsRemaining > 0) {
      trendRoundsRemaining--;
      if (trendRoundsRemaining === 0) {
        inTrend = false;
        trendDirection = null;
      }
    }

    // Generate REVERSE CROWD signal
    let baseSignal = null;
    if (r.ema_signal === 'BULL' && bullPayout > bearPayout && bullPayout >= 1.55) {
      baseSignal = 'BULL';
    } else if (r.ema_signal === 'BEAR' && bearPayout > bullPayout && bearPayout >= 1.55) {
      baseSignal = 'BEAR';
    }

    if (!baseSignal) continue;

    // TREND FILTER: If in trend, only take trades aligned with trend direction
    const isTrendTrade = inTrend;
    if (isTrendTrade && baseSignal !== trendDirection) {
      // Skip counter-trend REVERSE CROWD signal
      skippedCounterTrend++;
      continue;
    }

    // If we get here, either:
    // 1. Not in trend (normal REVERSE CROWD trade)
    // 2. In trend AND signal aligns with trend direction (filtered REVERSE CROWD trade)

    const signal = baseSignal;

    // Position sizing
    const effectiveBankroll = Math.min(bankroll, 50);
    let positionMultiplier = 1.0;
    if (r.ema_gap >= 0.05) positionMultiplier *= 2.2;
    if (lastTwoResults.length >= 2 && lastTwoResults.every(res => !res)) positionMultiplier *= 1.5;

    const betAmount = effectiveBankroll * 0.045 * positionMultiplier;
    const payout = signal === 'BULL' ? bullPayout : bearPayout;

    const winner = r.winner === 'bull' ? 'BULL' : 'BEAR';
    const won = signal === winner;

    if (won) {
      bankroll += betAmount * (payout - 1);
      wins++;
      if (isTrendTrade) trendWins++;
      else normalWins++;
      cbLossStreak = 0;
    } else {
      bankroll -= betAmount;
      losses++;
      if (isTrendTrade) trendLosses++;
      else normalLosses++;
      cbLossStreak++;
      if (cbLossStreak >= 3) {
        cbActive = true;
        cbCooldownUntil = r.lock_timestamp + (45 * 60);
      }
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    if (bankroll > peak) peak = bankroll;
    const currentDD = ((peak - bankroll) / peak) * 100;
    if (currentDD > maxDrawdown) maxDrawdown = currentDD;

    if (bankroll <= 0) break;
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const normalTrades = normalWins + normalLosses;
  const normalWR = normalTrades > 0 ? (normalWins / normalTrades * 100) : 0;
  const trendTrades = trendWins + trendLosses;
  const trendWR = trendTrades > 0 ? (trendWins / trendTrades * 100) : 0;

  return {
    testName,
    duration: isDynamic ? 'dynamic' : `${durationRounds}r`,
    finalBankroll: bankroll,
    maxDrawdown,
    totalTrades, wins, losses, winRate,
    normalTrades, normalWR,
    trendTrades, trendWins, trendLosses, trendWR,
    trendCount, skippedCounterTrend
  };
}

console.log('Running tests...\n');

// Baseline
const baseline = runBacktest('baseline', () => ({ detected: false }), () => false, 0);

console.log('📊 BASELINE (Pure REVERSE CROWD - No Filter):');
console.log(`   Final: ${baseline.finalBankroll.toFixed(2)} BNB | DD: ${baseline.maxDrawdown.toFixed(1)}% | WR: ${baseline.winRate.toFixed(1)}%\n`);

// ATR Expansion tests
console.log('🔍 ATR EXPANSION TREND FILTER:\n');
const atrResults = [];
for (const duration of [5, 6, 7, 'dynamic']) {
  const result = runBacktest('atr_trend', detectATRTrend, shouldExitATRTrend, duration);
  atrResults.push(result);
  const label = duration === 'dynamic' ? 'Dynamic' : `${duration} rounds`;
  console.log(`   ${label.padEnd(12)} → Final: ${result.finalBankroll.toFixed(2).padStart(10)} BNB | Trends: ${result.trendCount.toString().padStart(2)} | T.Trades: ${result.trendTrades.toString().padStart(3)} | T.WR: ${result.trendWR.toFixed(1).padStart(5)}% | Skipped: ${result.skippedCounterTrend.toString().padStart(3)}`);
}

// Range Breakout tests
console.log('\n🔍 RANGE BREAKOUT TREND FILTER:\n');
const rangeResults = [];
for (const duration of [5, 6, 7, 'dynamic']) {
  const result = runBacktest('range_trend', detectRangeTrend, shouldExitRangeTrend, duration);
  rangeResults.push(result);
  const label = duration === 'dynamic' ? 'Dynamic' : `${duration} rounds`;
  console.log(`   ${label.padEnd(12)} → Final: ${result.finalBankroll.toFixed(2).padStart(10)} BNB | Trends: ${result.trendCount.toString().padStart(2)} | T.Trades: ${result.trendTrades.toString().padStart(3)} | T.WR: ${result.trendWR.toFixed(1).padStart(5)}% | Skipped: ${result.skippedCounterTrend.toString().padStart(3)}`);
}

// Momentum tests
console.log('\n🔍 MOMENTUM TREND FILTER:\n');
const momentumResults = [];
for (const duration of [5, 6, 7, 'dynamic']) {
  const result = runBacktest('momentum_trend', detectMomentumTrend, shouldExitMomentumTrend, duration);
  momentumResults.push(result);
  const label = duration === 'dynamic' ? 'Dynamic' : `${duration} rounds`;
  console.log(`   ${label.padEnd(12)} → Final: ${result.finalBankroll.toFixed(2).padStart(10)} BNB | Trends: ${result.trendCount.toString().padStart(2)} | T.Trades: ${result.trendTrades.toString().padStart(3)} | T.WR: ${result.trendWR.toFixed(1).padStart(5)}% | Skipped: ${result.skippedCounterTrend.toString().padStart(3)}`);
}

// Summary table
console.log('\n\n📊 SUMMARY TABLE');
console.log('═'.repeat(130));
console.log('Method              │ Duration │  Final    │   DD   │ Overall │ Normal │ Trend │ T.W/L    │ T.Trades │ Trends │ Skipped');
console.log('─'.repeat(130));

const printRow = (name, r) => {
  const methodName = name.padEnd(19);
  const duration = r.duration.padEnd(8);
  const final = r.finalBankroll.toFixed(2).padStart(9);
  const dd = r.maxDrawdown.toFixed(1).padStart(5);
  const overall = r.winRate.toFixed(1).padStart(6);
  const normalWR = r.normalWR.toFixed(1).padStart(5);
  const trendWR = r.trendWR.toFixed(1).padStart(5);
  const trendWL = `${r.trendWins}/${r.trendLosses}`.padStart(8);
  const trendTrades = r.trendTrades.toString().padStart(8);
  const trends = r.trendCount.toString().padStart(6);
  const skipped = r.skippedCounterTrend.toString().padStart(7);

  console.log(`${methodName} │ ${duration} │ ${final} │ ${dd}% │ ${overall}% │ ${normalWR}% │ ${trendWR}% │ ${trendWL} │ ${trendTrades} │ ${trends} │ ${skipped}`);
};

console.log(`${'Baseline (No Filter)'.padEnd(19)} │ ${'-'.padEnd(8)} │ ${baseline.finalBankroll.toFixed(2).padStart(9)} │ ${baseline.maxDrawdown.toFixed(1).padStart(5)}% │ ${baseline.winRate.toFixed(1).padStart(6)}% │ ${baseline.winRate.toFixed(1).padStart(5)}% │     - │        - │        - │      - │       -`);

for (const r of atrResults) {
  printRow('ATR Trend Filter', r);
}

for (const r of rangeResults) {
  printRow('Range Trend Filter', r);
}

for (const r of momentumResults) {
  printRow('Momentum Filter', r);
}

console.log('═'.repeat(130));

// Find best
const allResults = [...atrResults, ...rangeResults, ...momentumResults];
const best = allResults.reduce((a, b) => a.finalBankroll > b.finalBankroll ? a : b);
const improvement = ((best.finalBankroll - baseline.finalBankroll) / baseline.finalBankroll * 100);

console.log('\n📈 ANALYSIS:');
console.log(`   Baseline: ${baseline.finalBankroll.toFixed(2)} BNB`);
console.log(`   Best: ${best.testName} ${best.duration} → ${best.finalBankroll.toFixed(2)} BNB`);
console.log(`   Improvement: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(2)}%`);
console.log(`   Trends detected: ${best.trendCount}`);
console.log(`   Trend trades taken: ${best.trendTrades} (${best.trendWins}W / ${best.trendLosses}L)`);
console.log(`   Trend WR: ${best.trendWR.toFixed(1)}%`);
console.log(`   Counter-trend trades skipped: ${best.skippedCounterTrend}`);

if (improvement > 0) {
  console.log('\n✅ TREND FILTER THEORY WORKS! 🎉\n');
  console.log(`   By filtering out counter-trend signals during ${best.duration}, we improved by ${improvement.toFixed(2)}%`);
} else {
  console.log('\n❌ Baseline still performs better.\n');
  console.log(`   Filtering counter-trend signals hurts performance by ${Math.abs(improvement).toFixed(2)}%`);
}

db.close();
