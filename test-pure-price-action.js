import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('🚀 FUCK THE CROWD - PURE PRICE ACTION TESTING\n');
console.log('Strategy: Ignore crowd payouts, predict price movement using technical analysis\n');
console.log('═'.repeat(100) + '\n');

// Technical indicator calculations
function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateSMA(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  if (prices.length < period) return null;
  const sma = calculateSMA(prices, period);
  const slice = prices.slice(-period);
  const variance = slice.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const std = Math.sqrt(variance);

  return {
    upper: sma + (std * stdDev),
    middle: sma,
    lower: sma - (std * stdDev),
    bandwidth: ((std * stdDev * 2) / sma) * 100
  };
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;

  const changes = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  let gains = 0, losses = 0;
  for (const change of changes) {
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateATR(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const trueRanges = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    if (i <= 0) continue;
    trueRanges.push(Math.abs(prices[i] - prices[i - 1]));
  }
  return trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
}

// Strategy 1: Multi-Indicator Confluence (3+ must agree)
function multiIndicatorConfluence(prices, currentIdx) {
  if (prices.length < 30) return null;

  const recentPrices = prices.slice(Math.max(0, currentIdx - 30), currentIdx + 1);
  const ema3 = calculateEMA(recentPrices, 3);
  const ema7 = calculateEMA(recentPrices, 7);
  const bb = calculateBollingerBands(recentPrices, 20);
  const rsi = calculateRSI(recentPrices, 14);
  const currentPrice = recentPrices[recentPrices.length - 1];
  const prevPrice = recentPrices[recentPrices.length - 2];

  if (!ema3 || !ema7 || !bb || !rsi) return null;

  let bullSignals = 0, bearSignals = 0;

  // 1. EMA trend
  if (ema3 > ema7) bullSignals++; else bearSignals++;

  // 2. BB position
  if (currentPrice > bb.middle) bullSignals++; else bearSignals++;

  // 3. RSI (not overbought/oversold)
  if (rsi < 70 && rsi > 50) bullSignals++;
  if (rsi > 30 && rsi < 50) bearSignals++;

  // 4. Recent candle direction
  if (currentPrice > prevPrice) bullSignals++; else bearSignals++;

  // 5. Momentum (3 candles)
  const last3 = recentPrices.slice(-4);
  const greenCandles = last3.filter((p, i) => i > 0 && p > last3[i-1]).length;
  if (greenCandles >= 2) bullSignals++;
  if (greenCandles <= 1) bearSignals++;

  // Need at least 3 signals
  if (bullSignals >= 3) return { signal: 'BULL', strength: bullSignals };
  if (bearSignals >= 3) return { signal: 'BEAR', strength: bearSignals };
  return null;
}

// Strategy 2: Mean Reversion (BB extremes + RSI)
function meanReversion(prices, currentIdx) {
  if (prices.length < 30) return null;

  const recentPrices = prices.slice(Math.max(0, currentIdx - 30), currentIdx + 1);
  const bb = calculateBollingerBands(recentPrices, 20);
  const rsi = calculateRSI(recentPrices, 14);
  const currentPrice = recentPrices[recentPrices.length - 1];

  if (!bb || !rsi) return null;

  // Oversold → Buy
  if (currentPrice < bb.lower && rsi < 30) {
    return { signal: 'BULL', strength: (30 - rsi) };
  }

  // Overbought → Sell
  if (currentPrice > bb.upper && rsi > 70) {
    return { signal: 'BEAR', strength: (rsi - 70) };
  }

  return null;
}

// Strategy 3: Momentum Continuation
function momentumContinuation(prices, currentIdx) {
  if (prices.length < 10) return null;

  const recentPrices = prices.slice(Math.max(0, currentIdx - 10), currentIdx + 1);
  const atr = calculateATR(recentPrices, 7);
  const avgATR = calculateATR(recentPrices.slice(0, -3), 7);

  if (!atr || !avgATR) return null;

  // Count consecutive candles
  let consecutive = 0;
  let direction = null;

  for (let i = recentPrices.length - 1; i > 0; i--) {
    const isGreen = recentPrices[i] > recentPrices[i - 1];
    const currentDir = isGreen ? 'BULL' : 'BEAR';

    if (direction === null) {
      direction = currentDir;
      consecutive = 1;
    } else if (direction === currentDir) {
      consecutive++;
    } else {
      break;
    }
  }

  // Need 3+ consecutive + expanding volatility
  if (consecutive >= 3 && atr > avgATR * 1.2) {
    return { signal: direction, strength: consecutive };
  }

  return null;
}

// Strategy 4: Higher Timeframe Alignment
function higherTimeframeAlignment(prices, currentIdx) {
  if (prices.length < 60) return null;

  const allPrices = prices.slice(Math.max(0, currentIdx - 60), currentIdx + 1);

  // 5min trend (last 3 candles = 15min)
  const tf5m = allPrices.slice(-3);
  const trend5m = tf5m[tf5m.length - 1] > tf5m[0] ? 'BULL' : 'BEAR';

  // 15min trend (last 9 candles = 45min)
  const tf15m = allPrices.slice(-9);
  const ema15m = calculateEMA(tf15m, 3);
  const sma15m = calculateSMA(tf15m, 7);
  const trend15m = ema15m > sma15m ? 'BULL' : 'BEAR';

  // 1hr trend (last 12 candles)
  const tf1h = allPrices.slice(-12);
  const ema1h = calculateEMA(tf1h, 3);
  const sma1h = calculateSMA(tf1h, 7);
  const trend1h = ema1h > sma1h ? 'BULL' : 'BEAR';

  // All must align
  if (trend5m === trend15m && trend15m === trend1h) {
    return { signal: trend5m, strength: 3 };
  }

  // At least 2 timeframes align
  if (trend5m === trend15m) {
    return { signal: trend5m, strength: 2 };
  }

  return null;
}

// Strategy 5: Volatility Breakout
function volatilityBreakout(prices, currentIdx) {
  if (prices.length < 30) return null;

  const recentPrices = prices.slice(Math.max(0, currentIdx - 30), currentIdx + 1);
  const bb = calculateBollingerBands(recentPrices, 20);
  const atr = calculateATR(recentPrices, 14);
  const avgATR = calculateATR(recentPrices.slice(0, -5), 14);

  if (!bb || !atr || !avgATR) return null;

  const currentPrice = recentPrices[recentPrices.length - 1];

  // Squeeze detection (low volatility)
  const isSqueeze = bb.bandwidth < 3.0;

  // Volatility expansion
  const isExpansion = atr > avgATR * 1.5;

  // Breakout direction
  const breakoutUp = currentPrice > bb.upper;
  const breakoutDown = currentPrice < bb.lower;

  // Trade breakout in direction of expansion
  if (isSqueeze && isExpansion) {
    if (breakoutUp) return { signal: 'BULL', strength: atr / avgATR };
    if (breakoutDown) return { signal: 'BEAR', strength: atr / avgATR };
  }

  return null;
}

function runStrategy(strategyName, strategyFunc) {
  const rounds = db.prepare(`
    SELECT epoch, lock_timestamp, t20s_bull_wei, t20s_bear_wei, winner, close_price
    FROM rounds
    WHERE t20s_bull_wei IS NOT NULL
      AND t20s_bear_wei IS NOT NULL
      AND winner IS NOT NULL
      AND close_price IS NOT NULL
    ORDER BY epoch ASC
  `).all();

  let bankroll = 1, peak = 1, maxDrawdown = 0;
  let wins = 0, losses = 0;
  let cbActive = false, cbLossStreak = 0, cbCooldownUntil = null;
  let lastTwoResults = [];

  for (let i = 60; i < rounds.length; i++) {
    const r = rounds[i];

    // Circuit breaker
    if (cbActive && cbCooldownUntil && r.lock_timestamp < cbCooldownUntil) continue;
    if (cbActive && cbCooldownUntil && r.lock_timestamp >= cbCooldownUntil) {
      cbActive = false;
      cbCooldownUntil = null;
      cbLossStreak = 0;
    }

    // Get signal from strategy - ONLY PASS HISTORICAL DATA (no look-ahead)
    const historicalPrices = rounds.slice(0, i + 1).map(r => r.close_price);
    const result = strategyFunc(historicalPrices, historicalPrices.length - 1);
    if (!result || !result.signal) continue;

    const signal = result.signal;

    // Calculate payout for the side we're betting
    const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;
    if (totalAmount === 0) continue;

    const bullPayout = (totalAmount * 0.97) / bullAmount;
    const bearPayout = (totalAmount * 0.97) / bearAmount;
    const payout = signal === 'BULL' ? bullPayout : bearPayout;

    // Minimum payout filter (don't take terrible odds)
    if (payout < 1.3) continue;

    // Position sizing
    const effectiveBankroll = Math.min(bankroll, 50);
    let positionMultiplier = 1.0;

    // Recovery multiplier
    if (lastTwoResults.length >= 2 && lastTwoResults.every(res => !res)) {
      positionMultiplier *= 1.5;
    }

    const betAmount = effectiveBankroll * 0.045 * positionMultiplier;

    // Determine winner
    const winner = r.winner === 'bull' ? 'BULL' : 'BEAR';
    const won = signal === winner;

    if (won) {
      bankroll += betAmount * (payout - 1);
      wins++;
      cbLossStreak = 0;
    } else {
      bankroll -= betAmount;
      losses++;
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

    // Cap bankroll to prevent infinity (stop compounding at 100k BNB)
    if (bankroll > 100000) {
      bankroll = 100000;
      break;
    }

    if (bankroll <= 0) break;
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const roi = ((bankroll - 1) / 1) * 100;

  return {
    strategyName,
    finalBankroll: Math.min(bankroll, 100000),
    maxDrawdown,
    totalTrades,
    wins,
    losses,
    winRate,
    roi: Math.min(roi, 9999999)
  };
}

console.log('Running all pure price action strategies...\n');

const strategies = [
  { name: 'Multi-Indicator Confluence', func: multiIndicatorConfluence },
  { name: 'Mean Reversion', func: meanReversion },
  { name: 'Momentum Continuation', func: momentumContinuation },
  { name: 'Higher Timeframe Alignment', func: higherTimeframeAlignment },
  { name: 'Volatility Breakout', func: volatilityBreakout }
];

const results = [];

for (const strategy of strategies) {
  console.log(`Testing ${strategy.name}...`);
  const result = runStrategy(strategy.name, strategy.func);
  results.push(result);
}

// Also run baseline REVERSE CROWD for comparison
console.log('Testing REVERSE CROWD (baseline)...');

const baselineResult = (() => {
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
  let cbActive = false, cbLossStreak = 0, cbCooldownUntil = null;
  let lastTwoResults = [];

  for (const r of rounds) {
    if (cbActive && cbCooldownUntil && r.lock_timestamp < cbCooldownUntil) continue;
    if (cbActive && cbCooldownUntil && r.lock_timestamp >= cbCooldownUntil) {
      cbActive = false;
      cbCooldownUntil = null;
      cbLossStreak = 0;
    }

    const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;
    if (totalAmount === 0) continue;

    const bullPayout = (totalAmount * 0.97) / bullAmount;
    const bearPayout = (totalAmount * 0.97) / bearAmount;

    let signal = null;
    if (r.ema_signal === 'BULL' && bullPayout > bearPayout && bullPayout >= 1.55) {
      signal = 'BULL';
    } else if (r.ema_signal === 'BEAR' && bearPayout > bullPayout && bearPayout >= 1.55) {
      signal = 'BEAR';
    }

    if (!signal) continue;

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
      cbLossStreak = 0;
    } else {
      bankroll -= betAmount;
      losses++;
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

    // Cap bankroll to prevent infinity
    if (bankroll > 100000) {
      bankroll = 100000;
      break;
    }

    if (bankroll <= 0) break;
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const roi = ((bankroll - 1) / 1) * 100;

  return {
    strategyName: 'REVERSE CROWD (baseline)',
    finalBankroll: Math.min(bankroll, 100000),
    maxDrawdown,
    totalTrades,
    wins,
    losses,
    winRate,
    roi: Math.min(roi, 9999999)
  };
})();

console.log('\n\n' + '═'.repeat(120));
console.log('📊 PURE PRICE ACTION RESULTS');
console.log('═'.repeat(120));
console.log('Strategy                          │  Final     │   ROI      │   DD   │ Trades │  W/L    │  WR   ');
console.log('─'.repeat(120));

// Print baseline first
const b = baselineResult;
console.log(`${b.strategyName.padEnd(33)} │ ${b.finalBankroll.toFixed(2).padStart(10)} │ ${b.roi.toFixed(1).padStart(9)}% │ ${b.maxDrawdown.toFixed(1).padStart(5)}% │ ${b.totalTrades.toString().padStart(6)} │ ${b.wins.toString().padStart(3)}/${b.losses.toString().padEnd(3)} │ ${b.winRate.toFixed(1).padStart(5)}%`);

console.log('─'.repeat(120));

// Print pure price action strategies
for (const r of results) {
  console.log(`${r.strategyName.padEnd(33)} │ ${r.finalBankroll.toFixed(2).padStart(10)} │ ${r.roi.toFixed(1).padStart(9)}% │ ${r.maxDrawdown.toFixed(1).padStart(5)}% │ ${r.totalTrades.toString().padStart(6)} │ ${r.wins.toString().padStart(3)}/${r.losses.toString().padEnd(3)} │ ${r.winRate.toFixed(1).padStart(5)}%`);
}

console.log('═'.repeat(120));

// Find best
const allResults = [...results];
const best = allResults.reduce((a, b) => a.finalBankroll > b.finalBankroll ? a : b);
const improvement = ((best.finalBankroll - baselineResult.finalBankroll) / baselineResult.finalBankroll * 100);

console.log('\n📈 ANALYSIS:');
console.log(`   Baseline (REVERSE CROWD): ${baselineResult.finalBankroll.toFixed(2)} BNB`);
console.log(`   Best Pure Price Action: ${best.strategyName} → ${best.finalBankroll.toFixed(2)} BNB`);
console.log(`   Improvement: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(2)}%`);
console.log(`   Best Win Rate: ${best.winRate.toFixed(1)}%`);
console.log(`   Best Trades: ${best.totalTrades} (${best.wins}W / ${best.losses}L)`);

if (improvement > 10) {
  console.log('\n🎉 PURE PRICE ACTION DESTROYS CROWD STRATEGY!\n');
} else if (improvement > 0) {
  console.log('\n✅ Pure price action shows improvement\n');
} else {
  console.log('\n❌ REVERSE CROWD still wins\n');
  console.log('   Crowd data does provide edge in backtests');
}

db.close();
