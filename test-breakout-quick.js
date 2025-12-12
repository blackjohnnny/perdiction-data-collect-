import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const db = initDatabase();

console.log('🧪 TESTING SUSTAINED BREAKOUT FLIP THEORY (QUICK VERSION)\n');
console.log('Strategy: REVERSE CROWD normally, FLIP to opposite during breakout periods\n');

// Cache for Binance candle data
const candleCache = new Map();

async function getBinanceCandles(timestamp, lookback = 30) {
  const key = `${timestamp}_${lookback}`;
  if (candleCache.has(key)) return candleCache.get(key);

  try {
    const endTime = timestamp * 1000;
    const startTime = endTime - (lookback * 5 * 60 * 1000);
    const url = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=${lookback}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const candles = await response.json();
    if (!Array.isArray(candles) || candles.length < lookback) return null;

    const ohlcData = candles.map(c => ({
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5])
    }));

    candleCache.set(key, ohlcData);
    return ohlcData;
  } catch (err) {
    return null;
  }
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trueRanges = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    if (i <= 0) continue;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trueRanges.push(tr);
  }
  return trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
}

// ATR Expansion breakout detection
function detectATRBreakout(candles) {
  if (candles.length < 30) return { detected: false };

  const currentATR = calculateATR(candles, 14);
  const avgATR = calculateATR(candles.slice(0, -5), 14);

  if (!currentATR || !avgATR) return { detected: false };

  const atrRatio = currentATR / avgATR;
  const detected = atrRatio > 1.5;

  const currentPrice = candles[candles.length - 1].close;
  const prevPrice = candles[candles.length - 2].close;
  const direction = currentPrice > prevPrice ? 'BULL' : 'BEAR';

  return { detected, direction, strength: atrRatio };
}

function shouldExitATR(candles) {
  const newATR = calculateATR(candles, 14);
  const newAvgATR = calculateATR(candles.slice(0, -5), 14);
  return newATR && newAvgATR && (newATR / newAvgATR) < 1.2;
}

async function runBacktest(testName, durationRounds) {
  const isDynamic = durationRounds === 'dynamic';

  const rounds = db.prepare(`
    SELECT epoch, lock_timestamp, ema_signal, ema_gap,
           t20s_bull_wei, t20s_bear_wei, winner
    FROM rounds
    WHERE t20s_bull_wei IS NOT NULL
      AND t20s_bear_wei IS NOT NULL
      AND winner IS NOT NULL
      AND ema_signal IS NOT NULL
    ORDER BY epoch ASC
  `).all();

  let bankroll = 1, peak = 1, maxDrawdown = 0;
  let wins = 0, losses = 0, normalWins = 0, normalLosses = 0;
  let breakoutWins = 0, breakoutLosses = 0;
  let cbActive = false, cbLossStreak = 0, cbCooldownUntil = null;
  let lastTwoResults = [];
  let inBreakout = false, breakoutRoundsRemaining = 0, breakoutCount = 0;

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

    // Check breakout exit (dynamic mode)
    if (isDynamic && inBreakout && i >= 30) {
      const candles = await getBinanceCandles(r.lock_timestamp, 30);
      if (candles && shouldExitATR(candles)) {
        inBreakout = false;
        breakoutRoundsRemaining = 0;
      }
      await new Promise(resolve => setTimeout(resolve, 100)); // Rate limit
    }

    // Check for new breakout
    if (!inBreakout && i >= 30 && testName !== 'baseline') {
      const candles = await getBinanceCandles(r.lock_timestamp, 30);
      if (candles) {
        const breakout = detectATRBreakout(candles);
        if (breakout.detected) {
          inBreakout = true;
          breakoutCount++;
          breakoutRoundsRemaining = isDynamic ? 999 : durationRounds;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100)); // Rate limit
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
    breakoutTrades, breakoutWR, breakoutCount
  };
}

(async () => {
  console.log('1️⃣ Running baseline (Pure REVERSE CROWD)...\n');
  const baseline = await runBacktest('baseline', 0);

  console.log('📊 BASELINE RESULTS:');
  console.log(`   Final: ${baseline.finalBankroll.toFixed(2)} BNB | DD: ${baseline.maxDrawdown.toFixed(1)}% | WR: ${baseline.winRate.toFixed(1)}%\n`);

  console.log('2️⃣ Testing ATR Expansion breakout flip...\n');

  const tests = [
    { name: '5 rounds', duration: 5 },
    { name: '7 rounds', duration: 7 },
    { name: 'Dynamic', duration: 'dynamic' }
  ];

  const results = [];
  for (const test of tests) {
    console.log(`   Testing ${test.name}...`);
    const result = await runBacktest('atr_expansion', test.duration);
    results.push(result);
  }

  console.log('\n\n📊 FINAL RESULTS TABLE');
  console.log('═'.repeat(110));
  console.log('Test          │ Duration │  Final    │   DD   │ Overall │ Normal │ B.Out │ B.Trades │ Breakouts');
  console.log('─'.repeat(110));

  const bName = 'Baseline'.padEnd(13);
  console.log(`${bName} │ ${'-'.padEnd(8)} │ ${baseline.finalBankroll.toFixed(2).padStart(9)} │ ${baseline.maxDrawdown.toFixed(1).padStart(5)}% │ ${baseline.winRate.toFixed(1).padStart(6)}% │ ${baseline.winRate.toFixed(1).padStart(5)}% │     - │        - │         -`);

  for (const r of results) {
    const name = 'ATR Flip'.padEnd(13);
    const dur = r.duration.padEnd(8);
    console.log(`${name} │ ${dur} │ ${r.finalBankroll.toFixed(2).padStart(9)} │ ${r.maxDrawdown.toFixed(1).padStart(5)}% │ ${r.winRate.toFixed(1).padStart(6)}% │ ${r.normalWR.toFixed(1).padStart(5)}% │ ${r.breakoutWR.toFixed(1).padStart(5)}% │ ${r.breakoutTrades.toString().padStart(8)} │ ${r.breakoutCount.toString().padStart(9)}`);
  }

  console.log('═'.repeat(110));

  // Analysis
  const best = results.reduce((a, b) => a.finalBankroll > b.finalBankroll ? a : b);
  const improvement = ((best.finalBankroll - baseline.finalBankroll) / baseline.finalBankroll * 100).toFixed(2);

  console.log('\n📈 ANALYSIS:');
  console.log(`   Best performer: ${best.duration}`);
  console.log(`   Improvement over baseline: ${improvement}%`);
  console.log(`   Breakouts detected: ${best.breakoutCount}`);
  console.log(`   Breakout WR: ${best.breakoutWR.toFixed(1)}%`);

  if (parseFloat(improvement) > 0) {
    console.log('\n✅ BREAKOUT FLIP THEORY WORKS! 🎉');
  } else {
    console.log('\n❌ Baseline still better. Theory needs refinement.');
  }

  db.close();
  process.exit(0);
})();
