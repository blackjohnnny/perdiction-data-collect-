import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const db = initDatabase();

console.log('🧪 TESTING SUSTAINED BREAKOUT FLIP THEORY\n');
console.log('Strategy: REVERSE CROWD normally, FLIP to opposite during breakout periods\n');

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
    const startTime = endTime - (lookback * 5 * 60 * 1000); // lookback candles × 5 minutes

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

function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  if (prices.length < period) return null;

  const slice = prices.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const std = Math.sqrt(variance);

  const upper = sma + (std * stdDev);
  const lower = sma - (std * stdDev);
  const bandwidth = ((upper - lower) / sma) * 100;

  return { upper, lower, sma, bandwidth };
}

function calculateATR(tvData, period = 14) {
  if (tvData.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < tvData.length; i++) {
    const high = tvData[i].high;
    const low = tvData[i].low;
    const prevClose = tvData[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  const recentTR = trueRanges.slice(-period);
  return recentTR.reduce((a, b) => a + b, 0) / period;
}

// Breakout detection methods
const breakoutDetection = {
  // ATR Expansion - volatility spike
  atr_expansion: (tvData) => {
    if (tvData.length < 30) return { detected: false };

    const currentATR = calculateATR(tvData, 14);
    const olderData = tvData.slice(0, -5);
    const avgATR = calculateATR(olderData, 14);

    if (!currentATR || !avgATR) return { detected: false };

    const atrRatio = currentATR / avgATR;
    const detected = atrRatio > 1.5;

    const currentPrice = tvData[tvData.length - 1].close;
    const prevPrice = tvData[tvData.length - 2].close;
    const direction = currentPrice > prevPrice ? 'BULL' : 'BEAR';

    return {
      detected,
      direction,
      strength: atrRatio,
      // Exit condition: ATR drops below 1.2x average
      shouldExit: (newTvData) => {
        const newATR = calculateATR(newTvData, 14);
        const newAvgATR = calculateATR(newTvData.slice(0, -5), 14);
        return newATR && newAvgATR && (newATR / newAvgATR) < 1.2;
      }
    };
  },

  // Range Breakout - consolidation then explosion
  range_breakout: (tvData) => {
    if (tvData.length < 15) return { detected: false };

    const consolidationPeriod = tvData.slice(-11, -1);
    const highs = consolidationPeriod.map(d => d.high);
    const lows = consolidationPeriod.map(d => d.low);
    const high = Math.max(...highs);
    const low = Math.min(...lows);
    const rangePercent = (high - low) / low * 100;

    const isTightRange = rangePercent < 1.0;
    const currentClose = tvData[tvData.length - 1].close;
    const breakoutUp = currentClose > high * 1.003;
    const breakoutDown = currentClose < low * 0.997;

    const detected = isTightRange && (breakoutUp || breakoutDown);

    return {
      detected,
      direction: breakoutUp ? 'BULL' : breakoutDown ? 'BEAR' : null,
      strength: detected ? Math.abs(currentClose - (breakoutUp ? high : low)) / low * 100 : 0,
      // Exit condition: Price returns to range
      shouldExit: (newTvData) => {
        const newClose = newTvData[newTvData.length - 1].close;
        return newClose <= high && newClose >= low;
      }
    };
  },

  // Bollinger Squeeze + Breakout
  bollinger_breakout: (tvData) => {
    if (tvData.length < 25) return { detected: false };

    const prices = tvData.map(d => d.close);
    const bb = calculateBollingerBands(prices, 20, 2);
    const bbPrev = calculateBollingerBands(prices.slice(0, -1), 20, 2);

    if (!bb || !bbPrev) return { detected: false };

    const squeeze = bb.bandwidth < 2.0 && bb.bandwidth < bbPrev.bandwidth;
    const currentPrice = prices[prices.length - 1];
    const breakoutUp = currentPrice > bb.upper;
    const breakoutDown = currentPrice < bb.lower;

    const detected = squeeze && (breakoutUp || breakoutDown);

    return {
      detected,
      direction: breakoutUp ? 'BULL' : breakoutDown ? 'BEAR' : null,
      strength: detected ? Math.abs(currentPrice - bb.sma) / bb.sma * 100 : 0,
      // Exit condition: Price returns inside bands
      shouldExit: (newTvData) => {
        const newPrices = newTvData.map(d => d.close);
        const newBB = calculateBollingerBands(newPrices, 20, 2);
        if (!newBB) return false;
        const newPrice = newPrices[newPrices.length - 1];
        return newPrice <= newBB.upper && newPrice >= newBB.lower;
      }
    };
  }
};

// Run backtest with breakout duration
function runBacktest(detectionMethod, detectionFunc, durationRounds) {
  const isDynamic = durationRounds === 'dynamic';

  let bankroll = 1;
  let peak = 1;
  let maxDrawdown = 0;

  let wins = 0;
  let losses = 0;
  let normalWins = 0;
  let normalLosses = 0;
  let breakoutWins = 0;
  let breakoutLosses = 0;

  let cbActive = false;
  let cbLossStreak = 0;
  let cbCooldownUntil = null;
  let lastTwoResults = [];

  // Breakout state tracking
  let inBreakout = false;
  let breakoutRoundsRemaining = 0;
  let breakoutEntryData = null;
  let breakoutEnterEpoch = null;
  let breakoutCount = 0;

  const startIdx = 100; // Need history for indicators

  for (let i = startIdx; i < historicalData.length; i++) {
    const r = historicalData[i];

    if (!r.tradingview_data || r.tradingview_data.length === 0) continue;

    const bullPayout = r.bullPayout_t20s;
    const bearPayout = r.bearPayout_t20s;

    if (!bullPayout || !bearPayout) continue;

    // Circuit breaker check
    if (cbActive && cbCooldownUntil && r.epoch < cbCooldownUntil) {
      continue;
    }
    if (cbActive && cbCooldownUntil && r.epoch >= cbCooldownUntil) {
      cbActive = false;
      cbCooldownUntil = null;
      cbLossStreak = 0;
    }

    // Get TV data for this round
    const tvData = r.tradingview_data;

    // Check if we should exit breakout (dynamic mode only)
    if (isDynamic && inBreakout && breakoutEntryData && breakoutEntryData.shouldExit) {
      if (breakoutEntryData.shouldExit(tvData)) {
        inBreakout = false;
        breakoutRoundsRemaining = 0;
      }
    }

    // Check for new breakout detection (only if not already in breakout)
    if (!inBreakout) {
      const breakout = detectionFunc(tvData);

      if (breakout.detected) {
        inBreakout = true;
        breakoutCount++;
        breakoutEntryData = breakout;
        breakoutEnterEpoch = r.epoch;

        if (isDynamic) {
          breakoutRoundsRemaining = 999; // Will exit based on shouldExit()
        } else {
          breakoutRoundsRemaining = durationRounds;
        }
      }
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
    const winner = r.closePrice >= r.lockPrice ? 'BULL' : 'BEAR';
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
        cbCooldownUntil = r.epoch + (45 * 60);
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
  const breakoutWR = breakoutTrades > 0 ? (breakoutWins / breakoutTrades * 100) : 0;

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

// Run baseline (pure REVERSE CROWD, no flipping)
console.log('Running baseline (Pure REVERSE CROWD)...');
const baseline = runBacktest('baseline', () => ({ detected: false }), 0);

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
    const result = runBacktest(method, breakoutDetection[method], duration);
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
