import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('🧪 TESTING SUSTAINED BREAKOUT FLIP THEORY\n');
console.log('Strategy: REVERSE CROWD normally, FLIP to opposite during sustained breakout periods\n');
console.log('Detection: Using database close_price data for breakout indicators\n');

// Calculate ATR using close prices (simplified)
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

// ATR Expansion breakout detection
function detectATRBreakout(prices) {
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

function shouldExitATR(prices) {
  const newATR = calculateATR(prices, 14);
  const newAvgATR = calculateATR(prices.slice(0, -5), 14);
  return newATR && newAvgATR && (newATR / newAvgATR) < 1.2;
}

// Range Breakout detection
function detectRangeBreakout(prices) {
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

function shouldExitRange(prices, entryRange) {
  if (!entryRange) return false;
  const currentPrice = prices[prices.length - 1];
  return currentPrice <= entryRange.high && currentPrice >= entryRange.low;
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
  let wins = 0, losses = 0, normalWins = 0, normalLosses = 0;
  let breakoutWins = 0, breakoutLosses = 0;
  let cbActive = false, cbLossStreak = 0, cbCooldownUntil = null;
  let lastTwoResults = [];
  let inBreakout = false, breakoutRoundsRemaining = 0, breakoutCount = 0;
  let breakoutEntryData = null;

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

    // Check breakout exit (dynamic mode)
    if (isDynamic && inBreakout && priceHistory.length >= 20) {
      if (exitFunc(priceHistory, breakoutEntryData)) {
        inBreakout = false;
        breakoutRoundsRemaining = 0;
      }
    }

    // Check for new breakout
    if (!inBreakout && priceHistory.length >= 30 && testName !== 'baseline') {
      const breakout = detectionFunc(priceHistory);
      if (breakout.detected) {
        inBreakout = true;
        breakoutCount++;
        breakoutEntryData = breakout;
        breakoutRoundsRemaining = isDynamic ? 999 : durationRounds;
      }
    }

    // Decrement breakout counter (fixed duration)
    if (!isDynamic && inBreakout && breakoutRoundsRemaining > 0) {
      breakoutRoundsRemaining--;
      if (breakoutRoundsRemaining === 0) inBreakout = false;
    }

    // Generate REVERSE CROWD signal
    let baseSignal = null;
    if (r.ema_signal === 'BULL' && bullPayout > bearPayout && bullPayout >= 1.55) {
      baseSignal = 'BULL';
    } else if (r.ema_signal === 'BEAR' && bearPayout > bullPayout && bearPayout >= 1.55) {
      baseSignal = 'BEAR';
    }

    if (!baseSignal) continue;

    // Flip signal during breakout
    let signal = baseSignal;
    const isBreakoutTrade = inBreakout;
    if (isBreakoutTrade) {
      signal = baseSignal === 'BULL' ? 'BEAR' : 'BULL';
    }

    // Position sizing
    const effectiveBankroll = Math.min(bankroll, 50);
    let positionMultiplier = 1.0;
    if (!isBreakoutTrade && r.ema_gap >= 0.05) positionMultiplier *= 2.2;
    if (lastTwoResults.length >= 2 && lastTwoResults.every(res => !res)) positionMultiplier *= 1.5;

    const betAmount = effectiveBankroll * 0.045 * positionMultiplier;
    const payout = signal === 'BULL' ? bullPayout : bearPayout;

    const winner = r.winner === 'bull' ? 'BULL' : 'BEAR';
    const won = signal === winner;

    if (won) {
      bankroll += betAmount * (payout - 1);
      wins++;
      if (isBreakoutTrade) breakoutWins++;
      else normalWins++;
      cbLossStreak = 0;
    } else {
      bankroll -= betAmount;
      losses++;
      if (isBreakoutTrade) breakoutLosses++;
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
  const breakoutTrades = breakoutWins + breakoutLosses;
  const breakoutWR = breakoutTrades > 0 ? (breakoutWins / breakoutTrades * 100) : 0;

  return {
    testName,
    duration: isDynamic ? 'dynamic' : `${durationRounds}r`,
    finalBankroll: bankroll,
    maxDrawdown,
    totalTrades, wins, losses, winRate,
    normalTrades, normalWR,
    breakoutTrades, breakoutWins, breakoutLosses, breakoutWR, breakoutCount
  };
}

console.log('Running tests...\n');

// Baseline
const baseline = runBacktest('baseline', () => ({ detected: false }), () => false, 0);

console.log('📊 BASELINE (Pure REVERSE CROWD):');
console.log(`   Final: ${baseline.finalBankroll.toFixed(2)} BNB | DD: ${baseline.maxDrawdown.toFixed(1)}% | WR: ${baseline.winRate.toFixed(1)}%\n`);

// ATR Expansion tests
console.log('🔍 ATR EXPANSION METHOD:\n');
const atrResults = [];
for (const duration of [5, 6, 7, 'dynamic']) {
  const result = runBacktest('atr_expansion', detectATRBreakout, shouldExitATR, duration);
  atrResults.push(result);
  const label = duration === 'dynamic' ? 'Dynamic' : `${duration} rounds`;
  console.log(`   ${label.padEnd(12)} → Final: ${result.finalBankroll.toFixed(2).padStart(10)} BNB | Breakouts: ${result.breakoutCount.toString().padStart(2)} | B.Trades: ${result.breakoutTrades.toString().padStart(3)} | B.WR: ${result.breakoutWR.toFixed(1).padStart(5)}%`);
}

// Range Breakout tests
console.log('\n🔍 RANGE BREAKOUT METHOD:\n');
const rangeResults = [];
for (const duration of [5, 6, 7, 'dynamic']) {
  const result = runBacktest('range_breakout', detectRangeBreakout, shouldExitRange, duration);
  rangeResults.push(result);
  const label = duration === 'dynamic' ? 'Dynamic' : `${duration} rounds`;
  console.log(`   ${label.padEnd(12)} → Final: ${result.finalBankroll.toFixed(2).padStart(10)} BNB | Breakouts: ${result.breakoutCount.toString().padStart(2)} | B.Trades: ${result.breakoutTrades.toString().padStart(3)} | B.WR: ${result.breakoutWR.toFixed(1).padStart(5)}%`);
}

// Summary table
console.log('\n\n📊 SUMMARY TABLE');
console.log('═'.repeat(120));
console.log('Method              │ Duration │  Final    │   DD   │ Overall │ Normal │ B.Out │ B.W/L    │ B.Trades │ Breakouts');
console.log('─'.repeat(120));

const printRow = (name, r) => {
  const methodName = name.padEnd(19);
  const duration = r.duration.padEnd(8);
  const final = r.finalBankroll.toFixed(2).padStart(9);
  const dd = r.maxDrawdown.toFixed(1).padStart(5);
  const overall = r.winRate.toFixed(1).padStart(6);
  const normalWR = r.normalWR.toFixed(1).padStart(5);
  const breakoutWR = r.breakoutWR.toFixed(1).padStart(5);
  const breakoutWL = `${r.breakoutWins}/${r.breakoutLosses}`.padStart(8);
  const breakoutTrades = r.breakoutTrades.toString().padStart(8);
  const breakouts = r.breakoutCount.toString().padStart(9);

  console.log(`${methodName} │ ${duration} │ ${final} │ ${dd}% │ ${overall}% │ ${normalWR}% │ ${breakoutWR}% │ ${breakoutWL} │ ${breakoutTrades} │ ${breakouts}`);
};

console.log(`${'Baseline (REVERSE)'.padEnd(19)} │ ${'-'.padEnd(8)} │ ${baseline.finalBankroll.toFixed(2).padStart(9)} │ ${baseline.maxDrawdown.toFixed(1).padStart(5)}% │ ${baseline.winRate.toFixed(1).padStart(6)}% │ ${baseline.winRate.toFixed(1).padStart(5)}% │     - │        - │        - │         -`);

for (const r of atrResults) {
  printRow('ATR Expansion', r);
}

for (const r of rangeResults) {
  printRow('Range Breakout', r);
}

console.log('═'.repeat(120));

// Find best
const allResults = [...atrResults, ...rangeResults];
const best = allResults.reduce((a, b) => a.finalBankroll > b.finalBankroll ? a : b);
const improvement = ((best.finalBankroll - baseline.finalBankroll) / baseline.finalBankroll * 100);

console.log('\n📈 ANALYSIS:');
console.log(`   Baseline: ${baseline.finalBankroll.toFixed(2)} BNB`);
console.log(`   Best: ${best.testName} ${best.duration} → ${best.finalBankroll.toFixed(2)} BNB`);
console.log(`   Improvement: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(2)}%`);
console.log(`   Breakout detection count: ${best.breakoutCount}`);
console.log(`   Breakout trades: ${best.breakoutTrades} (${best.breakoutWins}W / ${best.breakoutLosses}L)`);
console.log(`   Breakout WR: ${best.breakoutWR.toFixed(1)}%`);

if (improvement > 0) {
  console.log('\n✅ BREAKOUT SUSTAINED FLIP THEORY WORKS! 🎉\n');
  console.log(`   By staying in breakout mode for ${best.duration}, we improved performance by ${improvement.toFixed(2)}%`);
} else {
  console.log('\n❌ Baseline still performs better.\n');
  console.log(`   Flipping during breakouts hurts performance by ${Math.abs(improvement).toFixed(2)}%`);
}

db.close();
