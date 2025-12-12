import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('🧪 TESTING AGGRESSIVE TREND RIDING THEORY\n');
console.log('Strategy: REVERSE CROWD normally, then RIDE trends aggressively\n');
console.log('Logic: Once trend detected, bet trend direction EVERY round (ignore EMA filter)\n');
console.log('Requirement: VERY accurate trend detection is critical!\n');

// Calculate ATR
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

// STRICT ATR Expansion detection (higher threshold)
function detectStrictATRTrend(prices) {
  if (prices.length < 30) return { detected: false };

  const currentATR = calculateATR(prices, 14);
  const avgATR = calculateATR(prices.slice(0, -5), 14);
  if (!currentATR || !avgATR) return { detected: false };

  const atrRatio = currentATR / avgATR;

  // MUCH stricter threshold - only detect strong trends
  const detected = atrRatio > 2.0; // Changed from 1.5 to 2.0

  // Also check price momentum confirmation
  const recentPrices = prices.slice(-5);
  const bullMomentum = recentPrices.filter((p, i) => i > 0 && p > recentPrices[i-1]).length;
  const bearMomentum = recentPrices.filter((p, i) => i > 0 && p < recentPrices[i-1]).length;

  // Need at least 3 out of 4 candles in same direction
  const hasMomentum = bullMomentum >= 3 || bearMomentum >= 3;

  if (!hasMomentum) return { detected: false };

  const direction = bullMomentum > bearMomentum ? 'BULL' : 'BEAR';

  return { detected, direction, strength: atrRatio };
}

function shouldExitStrictATR(prices) {
  const newATR = calculateATR(prices, 14);
  const newAvgATR = calculateATR(prices.slice(0, -5), 14);
  return newATR && newAvgATR && (newATR / newAvgATR) < 1.5; // Exit earlier
}

// STRICT Range Breakout detection
function detectStrictRangeTrend(prices) {
  if (prices.length < 20) return { detected: false };

  const consolidation = prices.slice(-15, -1); // Longer consolidation
  const high = Math.max(...consolidation);
  const low = Math.min(...consolidation);
  const rangePercent = (high - low) / low * 100;

  // MUCH tighter range required
  const isTightRange = rangePercent < 0.5; // Changed from 1.0 to 0.5

  const currentPrice = prices[prices.length - 1];

  // Bigger breakout required
  const breakoutUp = currentPrice > high * 1.005; // 0.5% instead of 0.3%
  const breakoutDown = currentPrice < low * 0.995;

  const detected = isTightRange && (breakoutUp || breakoutDown);

  return {
    detected,
    direction: breakoutUp ? 'BULL' : breakoutDown ? 'BEAR' : null,
    range: { high, low }
  };
}

function shouldExitStrictRange(prices, entryRange) {
  if (!entryRange) return false;
  const currentPrice = prices[prices.length - 1];
  return currentPrice <= entryRange.high && currentPrice >= entryRange.low;
}

// STRICT Multi-Candle Momentum
function detectStrictMomentum(prices) {
  if (prices.length < 15) return { detected: false };

  const recent = prices.slice(-7);

  // Count consecutive moves in same direction
  let bullCandles = 0;
  let bearCandles = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > recent[i-1]) bullCandles++;
    if (recent[i] < recent[i-1]) bearCandles++;
  }

  // Need at least 5 out of 6 candles in same direction (VERY strict)
  const detected = bullCandles >= 5 || bearCandles >= 5;

  if (!detected) return { detected: false };

  // Also check magnitude of move
  const priceChange = ((recent[recent.length - 1] - recent[0]) / recent[0]) * 100;
  const strongMove = Math.abs(priceChange) > 1.0; // Need >1% move

  if (!strongMove) return { detected: false };

  const direction = bullCandles > bearCandles ? 'BULL' : 'BEAR';

  return { detected, direction, strength: Math.abs(priceChange) };
}

function shouldExitStrictMomentum(prices) {
  if (prices.length < 10) return false;

  const recent = prices.slice(-4);
  let reversals = 0;

  for (let i = 2; i < recent.length; i++) {
    const prev = recent[i-1] - recent[i-2];
    const curr = recent[i] - recent[i-1];
    if ((prev > 0 && curr < 0) || (prev < 0 && curr > 0)) reversals++;
  }

  return reversals >= 2; // Exit if 2 reversals in last 3 candles
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
  let wins = 0, losses = 0;
  let normalWins = 0, normalLosses = 0;
  let trendWins = 0, trendLosses = 0;
  let cbActive = false, cbLossStreak = 0, cbCooldownUntil = null;
  let lastTwoResults = [];
  let inTrend = false, trendRoundsRemaining = 0, trendCount = 0;
  let trendDirection = null, trendEntryData = null;

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

    // Check for new trend detection (only if not in trend)
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

    let signal = null;
    const isTrendTrade = inTrend;

    if (isTrendTrade) {
      // AGGRESSIVE TREND MODE: Bet trend direction EVERY round (no EMA filter)
      // Only check minimum payout requirement
      const trendPayout = trendDirection === 'BULL' ? bullPayout : bearPayout;

      if (trendPayout >= 1.45) { // Minimum payout only
        signal = trendDirection;
      }
    } else {
      // NORMAL REVERSE CROWD MODE: Strict filters
      if (r.ema_signal === 'BULL' && bullPayout > bearPayout && bullPayout >= 1.55) {
        signal = 'BULL';
      } else if (r.ema_signal === 'BEAR' && bearPayout > bullPayout && bearPayout >= 1.55) {
        signal = 'BEAR';
      }
    }

    if (!signal) continue;

    // Position sizing
    const effectiveBankroll = Math.min(bankroll, 50);
    let positionMultiplier = 1.0;

    // Apply momentum multiplier (only in normal mode, not during trend riding)
    if (!isTrendTrade && r.ema_gap >= 0.05) positionMultiplier *= 2.2;

    // Recovery multiplier (both modes)
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
    trendCount
  };
}

console.log('Running tests...\n');

// Baseline
const baseline = runBacktest('baseline', () => ({ detected: false }), () => false, 0);

console.log('📊 BASELINE (Pure REVERSE CROWD):');
console.log(`   Final: ${baseline.finalBankroll.toFixed(2)} BNB | DD: ${baseline.maxDrawdown.toFixed(1)}% | WR: ${baseline.winRate.toFixed(1)}%\n`);

// Strict ATR tests
console.log('🔍 STRICT ATR EXPANSION (threshold 2.0x + momentum):\n');
const atrResults = [];
for (const duration of [5, 6, 7, 'dynamic']) {
  const result = runBacktest('strict_atr', detectStrictATRTrend, shouldExitStrictATR, duration);
  atrResults.push(result);
  const label = duration === 'dynamic' ? 'Dynamic' : `${duration} rounds`;
  console.log(`   ${label.padEnd(12)} → Final: ${result.finalBankroll.toFixed(2).padStart(10)} BNB | Trends: ${result.trendCount.toString().padStart(2)} | T.Trades: ${result.trendTrades.toString().padStart(3)} | T.WR: ${result.trendWR.toFixed(1).padStart(5)}%`);
}

// Strict Range tests
console.log('\n🔍 STRICT RANGE BREAKOUT (0.5% range + 0.5% breakout):\n');
const rangeResults = [];
for (const duration of [5, 6, 7, 'dynamic']) {
  const result = runBacktest('strict_range', detectStrictRangeTrend, shouldExitStrictRange, duration);
  rangeResults.push(result);
  const label = duration === 'dynamic' ? 'Dynamic' : `${duration} rounds`;
  console.log(`   ${label.padEnd(12)} → Final: ${result.finalBankroll.toFixed(2).padStart(10)} BNB | Trends: ${result.trendCount.toString().padStart(2)} | T.Trades: ${result.trendTrades.toString().padStart(3)} | T.WR: ${result.trendWR.toFixed(1).padStart(5)}%`);
}

// Strict Momentum tests
console.log('\n🔍 STRICT MOMENTUM (5/6 candles same direction + >1% move):\n');
const momentumResults = [];
for (const duration of [5, 6, 7, 'dynamic']) {
  const result = runBacktest('strict_momentum', detectStrictMomentum, shouldExitStrictMomentum, duration);
  momentumResults.push(result);
  const label = duration === 'dynamic' ? 'Dynamic' : `${duration} rounds`;
  console.log(`   ${label.padEnd(12)} → Final: ${result.finalBankroll.toFixed(2).padStart(10)} BNB | Trends: ${result.trendCount.toString().padStart(2)} | T.Trades: ${result.trendTrades.toString().padStart(3)} | T.WR: ${result.trendWR.toFixed(1).padStart(5)}%`);
}

// Summary table
console.log('\n\n📊 SUMMARY TABLE');
console.log('═'.repeat(120));
console.log('Method              │ Duration │  Final    │   DD   │ Overall │ Normal │ Trend │ T.W/L     │ T.Trades │ Trends');
console.log('─'.repeat(120));

const printRow = (name, r) => {
  const methodName = name.padEnd(19);
  const duration = r.duration.padEnd(8);
  const final = r.finalBankroll.toFixed(2).padStart(9);
  const dd = r.maxDrawdown.toFixed(1).padStart(5);
  const overall = r.winRate.toFixed(1).padStart(6);
  const normalWR = r.normalWR.toFixed(1).padStart(5);
  const trendWR = r.trendWR.toFixed(1).padStart(5);
  const trendWL = `${r.trendWins}/${r.trendLosses}`.padStart(9);
  const trendTrades = r.trendTrades.toString().padStart(8);
  const trends = r.trendCount.toString().padStart(6);

  console.log(`${methodName} │ ${duration} │ ${final} │ ${dd}% │ ${overall}% │ ${normalWR}% │ ${trendWR}% │ ${trendWL} │ ${trendTrades} │ ${trends}`);
};

console.log(`${'Baseline'.padEnd(19)} │ ${'-'.padEnd(8)} │ ${baseline.finalBankroll.toFixed(2).padStart(9)} │ ${baseline.maxDrawdown.toFixed(1).padStart(5)}% │ ${baseline.winRate.toFixed(1).padStart(6)}% │ ${baseline.winRate.toFixed(1).padStart(5)}% │     - │         - │        - │      -`);

for (const r of atrResults) {
  printRow('Strict ATR', r);
}

for (const r of rangeResults) {
  printRow('Strict Range', r);
}

for (const r of momentumResults) {
  printRow('Strict Momentum', r);
}

console.log('═'.repeat(120));

// Find best
const allResults = [...atrResults, ...rangeResults, ...momentumResults];
const best = allResults.reduce((a, b) => a.finalBankroll > b.finalBankroll ? a : b);
const improvement = ((best.finalBankroll - baseline.finalBankroll) / baseline.finalBankroll * 100);

console.log('\n📈 ANALYSIS:');
console.log(`   Baseline: ${baseline.finalBankroll.toFixed(2)} BNB`);
console.log(`   Best: ${best.testName} ${best.duration} → ${best.finalBankroll.toFixed(2)} BNB`);
console.log(`   Improvement: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(2)}%`);
console.log(`   Trends detected: ${best.trendCount}`);
console.log(`   Trend trades: ${best.trendTrades} (${best.trendWins}W / ${best.trendLosses}L)`);
console.log(`   Trend WR: ${best.trendWR.toFixed(1)}%`);
console.log(`   Normal WR: ${best.normalWR.toFixed(1)}%`);

if (improvement > 2) {
  console.log('\n✅ AGGRESSIVE TREND RIDING WORKS! 🚀\n');
  console.log(`   Strict detection + aggressive riding improved performance by ${improvement.toFixed(2)}%`);
} else if (improvement > 0) {
  console.log('\n⚠️  MARGINAL IMPROVEMENT\n');
  console.log(`   Only ${improvement.toFixed(2)}% better - may not be worth the complexity`);
} else {
  console.log('\n❌ Baseline still better\n');
  console.log(`   Even with strict detection, aggressive riding hurts by ${Math.abs(improvement).toFixed(2)}%`);
}

db.close();
