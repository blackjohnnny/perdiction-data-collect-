import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const db = initDatabase();

console.log('🧪 TESTING SUSTAINED BREAKOUT FLIP THEORY\n');
console.log('Strategy: REVERSE CROWD normally, FLIP to opposite during breakout periods\n');
console.log('Using: Database + Binance API for real OHLC candles\n');

// Cache for Binance candle data
const candleCache = new Map();

// Fetch OHLC candles from Binance for breakout detection
async function getBinanceCandles(timestamp, lookback = 30) {
  const key = `${timestamp}_${lookback}`;
  if (candleCache.has(key)) {
    return candleCache.get(key);
  }

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

// Helper functions
function calculateBollingerBands(candles, period = 20, stdDev = 2) {
  if (candles.length < period) return null;

  const prices = candles.slice(-period).map(c => c.close);
  const sma = prices.reduce((a, b) => a + b, 0) / period;
  const variance = prices.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const std = Math.sqrt(variance);

  const upper = sma + (std * stdDev);
  const lower = sma - (std * stdDev);
  const bandwidth = ((upper - lower) / sma) * 100;

  return { upper, lower, sma, bandwidth };
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const trueRanges = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    if (i <= 0) continue;
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  return trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
}

// Breakout detection methods
const breakoutDetection = {
  // ATR Expansion - volatility spike
  atr_expansion: (candles) => {
    if (candles.length < 30) return { detected: false };

    const currentATR = calculateATR(candles, 14);
    const avgATR = calculateATR(candles.slice(0, -5), 14);

    if (!currentATR || !avgATR) return { detected: false };

    const atrRatio = currentATR / avgATR;
    const detected = atrRatio > 1.5;

    const currentPrice = candles[candles.length - 1].close;
    const prevPrice = candles[candles.length - 2].close;
    const direction = currentPrice > prevPrice ? 'BULL' : 'BEAR';

    return {
      detected,
      direction,
      strength: atrRatio
    };
  },

  // Range Breakout - consolidation then explosion
  range_breakout: (candles) => {
    if (candles.length < 15) return { detected: false };

    const consolidationPeriod = candles.slice(-11, -1);
    const highs = consolidationPeriod.map(c => c.high);
    const lows = consolidationPeriod.map(c => c.low);
    const high = Math.max(...highs);
    const low = Math.min(...lows);
    const rangePercent = (high - low) / low * 100;

    const isTightRange = rangePercent < 1.0;
    const currentClose = candles[candles.length - 1].close;
    const breakoutUp = currentClose > high * 1.003;
    const breakoutDown = currentClose < low * 0.997;

    const detected = isTightRange && (breakoutUp || breakoutDown);

    return {
      detected,
      direction: breakoutUp ? 'BULL' : breakoutDown ? 'BEAR' : null,
      strength: detected ? Math.abs(currentClose - (breakoutUp ? high : low)) / low * 100 : 0
    };
  },

  // Bollinger Squeeze + Breakout
  bollinger_breakout: (candles) => {
    if (candles.length < 25) return { detected: false };

    const bb = calculateBollingerBands(candles, 20, 2);
    const bbPrev = calculateBollingerBands(candles.slice(0, -1), 20, 2);

    if (!bb || !bbPrev) return { detected: false };

    const squeeze = bb.bandwidth < 2.0 && bb.bandwidth < bbPrev.bandwidth;
    const currentPrice = candles[candles.length - 1].close;
    const breakoutUp = currentPrice > bb.upper;
    const breakoutDown = currentPrice < bb.lower;

    const detected = squeeze && (breakoutUp || breakoutDown);

    return {
      detected,
      direction: breakoutUp ? 'BULL' : breakoutDown ? 'BEAR' : null,
      strength: detected ? Math.abs(currentPrice - bb.sma) / bb.sma * 100 : 0
    };
  }
};

// Exit conditions
function shouldExitBreakout(method, entryData, candles) {
  if (!candles || candles.length < 20) return false;

  switch (method) {
    case 'atr_expansion': {
      const newATR = calculateATR(candles, 14);
      const newAvgATR = calculateATR(candles.slice(0, -5), 14);
      return newATR && newAvgATR && (newATR / newAvgATR) < 1.2;
    }
    case 'range_breakout': {
      // Exit if price returns to consolidation range
      if (!entryData || !entryData.range) return false;
      const currentPrice = candles[candles.length - 1].close;
      return currentPrice <= entryData.range.high && currentPrice >= entryData.range.low;
    }
    case 'bollinger_breakout': {
      // Exit if price returns inside bands
      const bb = calculateBollingerBands(candles, 20, 2);
      if (!bb) return false;
      const currentPrice = candles[candles.length - 1].close;
      return currentPrice <= bb.upper && currentPrice >= bb.lower;
    }
    default:
      return false;
  }
}

// Run backtest with breakout duration
async function runBacktest(detectionMethod, detectionFunc, durationRounds) {
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

  let bankroll = 1;
  let peak = 1;
  let maxDrawdown = 0;

  let wins = 0, losses = 0;
  let normalWins = 0, normalLosses = 0;
  let breakoutWins = 0, breakoutLosses = 0;

  let cbActive = false;
  let cbLossStreak = 0;
  let cbCooldownUntil = null;
  let lastTwoResults = [];

  // Breakout state tracking
  let inBreakout = false;
  let breakoutRoundsRemaining = 0;
  let breakoutEntryData = null;
  let breakoutCount = 0;
  let breakoutStartIdx = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;

    if (totalAmount === 0) continue;

    const bullPayout = (totalAmount * 0.97) / bullAmount;
    const bearPayout = (totalAmount * 0.97) / bearAmount;

    // Circuit breaker check
    if (cbActive && cbCooldownUntil && r.lock_timestamp < cbCooldownUntil) {
      continue;
    }
    if (cbActive && cbCooldownUntil && r.lock_timestamp >= cbCooldownUntil) {
      cbActive = false;
      cbCooldownUntil = null;
      cbLossStreak = 0;
    }

    // Check if we should exit breakout (dynamic mode only)
    if (isDynamic && inBreakout && i >= 30) {
      const candles = await getBinanceCandles(r.lock_timestamp, 30);
      if (candles && shouldExitBreakout(detectionMethod, breakoutEntryData, candles)) {
        inBreakout = false;
        breakoutRoundsRemaining = 0;
      }
    }

    // Check for new breakout detection (only if not already in breakout)
    if (!inBreakout && i >= 30 && detectionMethod !== 'baseline') {
      const candles = await getBinanceCandles(r.lock_timestamp, 30);

      if (candles) {
        const breakout = detectionFunc(candles);

        if (breakout.detected) {
          inBreakout = true;
          breakoutCount++;
          breakoutStartIdx = i;

          // Store range data for exit condition
          if (detectionMethod === 'range_breakout') {
            const consolidationPeriod = candles.slice(-11, -1);
            breakoutEntryData = {
              ...breakout,
              range: {
                high: Math.max(...consolidationPeriod.map(c => c.high)),
                low: Math.min(...consolidationPeriod.map(c => c.low))
              }
            };
          } else {
            breakoutEntryData = breakout;
          }

          if (isDynamic) {
            breakoutRoundsRemaining = 999; // Will exit based on shouldExit()
          } else {
            breakoutRoundsRemaining = durationRounds;
          }
        }
      }

      // Rate limit
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Decrement breakout rounds (fixed duration mode)
    if (!isDynamic && inBreakout && breakoutRoundsRemaining > 0) {
      breakoutRoundsRemaining--;
      if (breakoutRoundsRemaining === 0) {
        inBreakout = false;
      }
    }

    // Generate base REVERSE CROWD signal
    let baseSignal = null;

    if (r.ema_signal === 'BULL' && bullPayout > bearPayout && bullPayout >= 1.55) {
      baseSignal = 'BULL';
    } else if (r.ema_signal === 'BEAR' && bearPayout > bullPayout && bearPayout >= 1.55) {
      baseSignal = 'BEAR';
    }

    if (!baseSignal) continue;

    // Determine final signal (flip if in breakout)
    let signal = baseSignal;
    const isBreakoutTrade = inBreakout;

    if (isBreakoutTrade) {
      // FLIP to opposite (so we FOLLOW crowd during breakout)
      signal = baseSignal === 'BULL' ? 'BEAR' : 'BULL';
    }

    // Position sizing
    const effectiveBankroll = Math.min(bankroll, 50);
    let positionMultiplier = 1.0;

    // Momentum multiplier (only in normal mode, not during breakout)
    if (!isBreakoutTrade && r.ema_gap >= 0.05) {
      positionMultiplier *= 2.2;
    }

    // Recovery multiplier (both modes)
    if (lastTwoResults.length >= 2 && lastTwoResults.every(res => !res)) {
      positionMultiplier *= 1.5;
    }

    const betAmount = effectiveBankroll * 0.045 * positionMultiplier;
    const payout = signal === 'BULL' ? bullPayout : bearPayout;

    // Determine winner
    const winner = r.winner === 'bull' ? 'BULL' : 'BEAR';
    const won = signal === winner;

    // Update bankroll
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

    // Track peak and drawdown
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
  const breakoutWR = breakoutTrades > 0 ? (breakoutWins / breakoutLosses * 100) : 0;

  return {
    method: detectionMethod,
    duration: isDynamic ? 'dynamic' : `${durationRounds}r`,
    finalBankroll: bankroll,
    maxDrawdown,
    totalTrades,
    wins,
    losses,
    winRate,
    normalTrades,
    normalWR,
    breakoutTrades,
    breakoutWR,
    breakoutCount
  };
}

// Main execution
(async () => {
  // Run baseline (pure REVERSE CROWD, no flipping)
  console.log('Running baseline (Pure REVERSE CROWD)...');
  const baseline = await runBacktest('baseline', () => ({ detected: false }), 0);

  console.log('\n📊 BASELINE (Pure REVERSE CROWD - No Flipping)');
  console.log('─'.repeat(80));
  console.log(`Final Bankroll: ${baseline.finalBankroll.toFixed(2)} BNB`);
  console.log(`Max Drawdown: ${baseline.maxDrawdown.toFixed(1)}%`);
  console.log(`Overall Win Rate: ${baseline.winRate.toFixed(1)}% (${baseline.wins}/${baseline.totalTrades})`);
  console.log('');

  // Test each detection method with different durations
  const methods = ['atr_expansion', 'range_breakout', 'bollinger_breakout'];
  const durations = [5, 6, 7, 'dynamic'];

  const results = [];

  for (const method of methods) {
    console.log(`\n🔍 Testing: ${method.toUpperCase()}`);
    console.log('─'.repeat(80));

    for (const duration of durations) {
      const result = await runBacktest(method, breakoutDetection[method], duration);
      results.push(result);

      const durationLabel = duration === 'dynamic' ? 'DYNAMIC' : `${duration} rounds`;
      console.log(`\n  Duration: ${durationLabel}`);
      console.log(`  Final: ${result.finalBankroll.toFixed(2)} BNB | DD: ${result.maxDrawdown.toFixed(1)}% | Overall WR: ${result.winRate.toFixed(1)}%`);
      console.log(`  Normal: ${result.normalTrades} trades, ${result.normalWR.toFixed(1)}% WR`);
      console.log(`  Breakout: ${result.breakoutTrades} trades, ${result.breakoutWR.toFixed(1)}% WR (${result.breakoutCount} breakouts detected)`);
    }
  }

  // Summary table
  console.log('\n\n📊 SUMMARY TABLE');
  console.log('═'.repeat(120));
  console.log('Method              │ Duration │  Final    │   DD   │ Overall │ Normal │ B.Out │ B.Trades │ Breakouts');
  console.log('─'.repeat(120));
  console.log(`${'Baseline (REVERSE)'.padEnd(19)} │ ${'-'.padEnd(8)} │ ${baseline.finalBankroll.toFixed(2).padStart(9)} │ ${baseline.maxDrawdown.toFixed(1).padStart(5)}% │ ${baseline.winRate.toFixed(1).padStart(6)}% │ ${baseline.winRate.toFixed(1).padStart(5)}% │     - │        - │         -`);

  for (const r of results) {
    const methodName = r.method.padEnd(19);
    const duration = r.duration.padEnd(8);
    const final = r.finalBankroll.toFixed(2).padStart(9);
    const dd = r.maxDrawdown.toFixed(1).padStart(5);
    const overall = r.winRate.toFixed(1).padStart(6);
    const normalWR = r.normalWR.toFixed(1).padStart(5);
    const breakoutWR = r.breakoutWR.toFixed(1).padStart(5);
    const breakoutTrades = r.breakoutTrades.toString().padStart(8);
    const breakouts = r.breakoutCount.toString().padStart(9);

    console.log(`${methodName} │ ${duration} │ ${final} │ ${dd}% │ ${overall}% │ ${normalWR}% │ ${breakoutWR}% │ ${breakoutTrades} │ ${breakouts}`);
  }

  console.log('═'.repeat(120));
  console.log('\n✅ Test complete!');

  db.close();
  process.exit(0);
})();
