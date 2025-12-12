import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('🔬 BREAKOUT DETECTION - FIXED & PROPER\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const rounds = db.prepare(`
  SELECT epoch, lock_timestamp, ema_signal, ema_gap,
         t20s_bull_wei, t20s_bear_wei, winner, close_price, lock_price
  FROM rounds
  WHERE t20s_bull_wei IS NOT NULL
    AND t20s_bear_wei IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
    AND close_price IS NOT NULL
    AND lock_price IS NOT NULL
  ORDER BY epoch ASC
`).all();

console.log('Step 1: DEFINE BREAKOUT\n');
console.log('A breakout is when price makes a strong directional move:');
console.log('  - Breaks out of recent consolidation range');
console.log('  - High volume/volatility confirmation');
console.log('  - Sustained momentum (not a fake-out)\n');

// Calculate proper indicators
function calculateBollingerBands(prices, period = 20, mult = 2) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const avg = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, p) => sum + Math.pow(p - avg, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: avg + (mult * stdDev),
    lower: avg - (mult * stdDev),
    middle: avg,
    bandwidth: ((avg + mult * stdDev) - (avg - mult * stdDev)) / avg * 100
  };
}

function calculateATR(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const ranges = [];
  for (let i = 1; i < prices.length; i++) {
    ranges.push(Math.abs(prices[i] - prices[i - 1]));
  }
  return ranges.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateSMA(prices, period) {
  if (prices.length < period) return null;
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// BREAKOUT DETECTION METHODS
const breakoutMethods = {
  // Method 1: Bollinger Band Squeeze + Breakout
  bollinger_breakout: (prices) => {
    if (prices.length < 25) return { detected: false, strength: 0 };

    const bb = calculateBollingerBands(prices, 20, 2);
    const bbPrev = calculateBollingerBands(prices.slice(0, -1), 20, 2);
    if (!bb || !bbPrev) return { detected: false, strength: 0 };

    const currentPrice = prices[prices.length - 1];

    // Squeeze: bandwidth narrowing
    const squeeze = bb.bandwidth < 2.0 && bb.bandwidth < bbPrev.bandwidth;

    // Breakout: price outside bands
    const breakoutUp = currentPrice > bb.upper;
    const breakoutDown = currentPrice < bb.lower;

    const strength = breakoutUp ? (currentPrice - bb.upper) / bb.upper * 100 :
                     breakoutDown ? (bb.lower - currentPrice) / bb.lower * 100 : 0;

    return {
      detected: squeeze && (breakoutUp || breakoutDown),
      direction: breakoutUp ? 'BULL' : breakoutDown ? 'BEAR' : null,
      strength
    };
  },

  // Method 2: Range Breakout (consolidation then explosion)
  range_breakout: (prices) => {
    if (prices.length < 15) return { detected: false, strength: 0 };

    // Check last 10 rounds for consolidation
    const consolidation = prices.slice(-11, -1);
    const high = Math.max(...consolidation);
    const low = Math.min(...consolidation);
    const rangePercent = (high - low) / low * 100;

    // Tight range = consolidation
    const isTightRange = rangePercent < 1.0;

    const currentPrice = prices[prices.length - 1];
    const breakoutUp = currentPrice > high * 1.003; // 0.3% above high
    const breakoutDown = currentPrice < low * 0.997; // 0.3% below low

    const strength = breakoutUp ? (currentPrice - high) / high * 100 :
                     breakoutDown ? (low - currentPrice) / low * 100 : 0;

    return {
      detected: isTightRange && (breakoutUp || breakoutDown),
      direction: breakoutUp ? 'BULL' : breakoutDown ? 'BEAR' : null,
      strength
    };
  },

  // Method 3: ATR Expansion (volatility explosion)
  atr_expansion: (prices) => {
    if (prices.length < 20) return { detected: false, strength: 0 };

    const atr = calculateATR(prices, 14);
    const atrSMA = calculateSMA(prices.slice(-14).map((p, i, arr) =>
      i === 0 ? 0 : Math.abs(p - arr[i-1])
    ), 10);

    if (!atr || !atrSMA) return { detected: false, strength: 0 };

    // ATR spike = volatility breakout
    const atrRatio = atr / atrSMA;
    const expansion = atrRatio > 1.5;

    const currentPrice = prices[prices.length - 1];
    const prevPrice = prices[prices.length - 2];
    const direction = currentPrice > prevPrice ? 'BULL' : 'BEAR';

    return {
      detected: expansion,
      direction,
      strength: (atrRatio - 1) * 100
    };
  },

  // Method 4: Multi-candle momentum (sustained move)
  momentum_breakout: (prices) => {
    if (prices.length < 5) return { detected: false, strength: 0 };

    const last4 = prices.slice(-4);
    const changes = [];
    for (let i = 1; i < last4.length; i++) {
      changes.push(((last4[i] - last4[i-1]) / last4[i-1]) * 100);
    }

    // All same direction + increasing magnitude
    const allBull = changes.every(c => c > 0.1);
    const allBear = changes.every(c => c < -0.1);

    // Check magnitude increasing
    const magnitudes = changes.map(Math.abs);
    const increasing = magnitudes[2] > magnitudes[1] && magnitudes[1] > magnitudes[0];

    const avgChange = changes.reduce((a, b) => a + Math.abs(b), 0) / changes.length;

    return {
      detected: (allBull || allBear) && increasing,
      direction: allBull ? 'BULL' : allBear ? 'BEAR' : null,
      strength: avgChange
    };
  },

  // Method 5: Moving Average Crossover + Acceleration
  ma_breakout: (prices) => {
    if (prices.length < 25) return { detected: false, strength: 0 };

    const sma5 = calculateSMA(prices, 5);
    const sma10 = calculateSMA(prices, 10);
    const sma20 = calculateSMA(prices, 20);

    const sma5_prev = calculateSMA(prices.slice(0, -1), 5);
    const sma10_prev = calculateSMA(prices.slice(0, -1), 10);

    if (!sma5 || !sma10 || !sma20 || !sma5_prev || !sma10_prev) {
      return { detected: false, strength: 0 };
    }

    // Crossover just happened
    const bullCross = sma5 > sma10 && sma5_prev <= sma10_prev && sma5 > sma20;
    const bearCross = sma5 < sma10 && sma5_prev >= sma10_prev && sma5 < sma20;

    const gap = Math.abs(sma5 - sma10) / sma10 * 100;

    return {
      detected: (bullCross || bearCross) && gap > 0.2,
      direction: bullCross ? 'BULL' : bearCross ? 'BEAR' : null,
      strength: gap
    };
  }
};

console.log('Step 2: TEST EACH METHOD\n');

function testStrategyWithBreakout(methodName, detectionFunc) {
  let bankroll = 1.0;
  let peak = bankroll;
  let maxDD = 0;
  let consecutiveLosses = 0;
  let lastTwoResults = [];

  const priceHistory = [];
  let trades = 0, wins = 0;
  let normalTrades = 0, normalWins = 0;
  let breakoutTrades = 0, breakoutWins = 0;
  let breakoutDetections = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    priceHistory.push(r.close_price);
    if (priceHistory.length > 50) priceHistory.shift();

    const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;
    if (totalAmount === 0) continue;

    const bullPayout = totalAmount / bullAmount;
    const bearPayout = totalAmount / bearAmount;

    // Base REVERSE CROWD signal
    let baseSignal = null;
    if (r.ema_signal === 'BULL' && bullPayout > bearPayout && bullPayout >= 1.55) {
      baseSignal = 'BULL';
    } else if (r.ema_signal === 'BEAR' && bearPayout > bullPayout && bearPayout >= 1.55) {
      baseSignal = 'BEAR';
    }

    if (!baseSignal) continue;

    // Detect breakout
    const breakout = detectionFunc(priceHistory);
    const isBreakout = breakout.detected;
    if (isBreakout) breakoutDetections++;

    // Determine signal
    let signal = baseSignal;
    if (isBreakout) {
      // FLIP: take opposite of REVERSE CROWD (so we FOLLOW crowd during breakout)
      signal = baseSignal === 'BULL' ? 'BEAR' : 'BULL';
    }

    // Position sizing (FIXED)
    const effectiveBankroll = Math.min(bankroll, 50);
    let positionMultiplier = 1.0;

    // Momentum multiplier (only in normal mode)
    if (!isBreakout && r.ema_gap >= 0.05) {
      positionMultiplier *= 2.2;
    }

    // Recovery multiplier
    if (lastTwoResults.length >= 2 && lastTwoResults.every(r => !r)) {
      positionMultiplier *= 1.5;
    }

    const betAmount = effectiveBankroll * 0.045 * positionMultiplier;
    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = (signal === 'BULL' && r.winner === 'bull') || (signal === 'BEAR' && r.winner === 'bear');
    const profit = won ? betAmount * (actualPayout - 1) : -betAmount;

    bankroll += profit;
    if (bankroll <= 0) break;

    if (bankroll > peak) peak = bankroll;
    const dd = ((peak - bankroll) / peak) * 100;
    if (dd > maxDD) maxDD = dd;

    trades++;
    if (won) wins++;

    if (isBreakout) {
      breakoutTrades++;
      if (won) breakoutWins++;
    } else {
      normalTrades++;
      if (won) normalWins++;
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    // Circuit breaker tracking
    if (won) {
      consecutiveLosses = 0;
    } else {
      consecutiveLosses++;
    }
  }

  const wr = trades > 0 ? (wins / trades * 100) : 0;
  const normalWR = normalTrades > 0 ? (normalWins / normalTrades * 100) : 0;
  const breakoutWR = breakoutTrades > 0 ? (breakoutWins / breakoutTrades * 100) : 0;

  return {
    method: methodName,
    bankroll,
    maxDD,
    trades,
    wr,
    normalTrades,
    normalWR,
    breakoutTrades,
    breakoutWR,
    breakoutDetections
  };
}

// Test baseline first
console.log('Testing baseline (pure REVERSE CROWD)...\n');

let baseline = {
  method: 'Baseline (Pure REVERSE)',
  bankroll: 0,
  maxDD: 0,
  trades: 0,
  wins: 0
};

{
  let bankroll = 1.0;
  let peak = 1.0;
  let maxDD = 0;
  let lastTwoResults = [];
  let trades = 0, wins = 0;

  for (const r of rounds) {
    const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;
    if (totalAmount === 0) continue;

    const bullPayout = totalAmount / bullAmount;
    const bearPayout = totalAmount / bearAmount;

    let signal = null;
    if (r.ema_signal === 'BULL' && bullPayout > bearPayout && bullPayout >= 1.55) {
      signal = 'BULL';
    } else if (r.ema_signal === 'BEAR' && bearPayout > bullPayout && bearPayout >= 1.55) {
      signal = 'BEAR';
    }

    if (!signal) continue;

    const effectiveBankroll = Math.min(bankroll, 50);
    let positionMultiplier = 1.0;

    if (r.ema_gap >= 0.05) {
      positionMultiplier *= 2.2;
    }

    if (lastTwoResults.length >= 2 && lastTwoResults.every(r => !r)) {
      positionMultiplier *= 1.5;
    }

    const betAmount = effectiveBankroll * 0.045 * positionMultiplier;
    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = (signal === 'BULL' && r.winner === 'bull') || (signal === 'BEAR' && r.winner === 'bear');
    const profit = won ? betAmount * (actualPayout - 1) : -betAmount;

    bankroll += profit;
    if (bankroll <= 0) break;

    if (bankroll > peak) peak = bankroll;
    const dd = ((peak - bankroll) / peak) * 100;
    if (dd > maxDD) maxDD = dd;

    trades++;
    if (won) wins++;

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();
  }

  baseline = {
    method: 'Baseline (Pure REVERSE)',
    bankroll,
    maxDD,
    trades,
    wr: (wins / trades * 100),
    normalTrades: trades,
    normalWR: (wins / trades * 100),
    breakoutTrades: 0,
    breakoutWR: 0,
    breakoutDetections: 0
  };
}

console.log(`Baseline: ${baseline.bankroll.toFixed(2)} BNB, ${baseline.wr.toFixed(1)}% WR, ${baseline.maxDD.toFixed(1)}% DD\n`);

const results = [baseline];

console.log('Testing breakout methods...\n');

for (const [name, func] of Object.entries(breakoutMethods)) {
  const result = testStrategyWithBreakout(name, func);
  results.push(result);
  console.log(`${name}: ${result.breakoutDetections} breakouts detected`);
}

results.sort((a, b) => b.bankroll - a.bankroll);

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('📊 RESULTS:\n');
console.log('Method                │  Final    │  DD   │ Overall │ Normal │ B.Out │ B.Trades │ Detections');
console.log('──────────────────────┼───────────┼───────┼─────────┼────────┼───────┼──────────┼───────────');

results.forEach(r => {
  const breakoutInfo = r.breakoutTrades > 0 ?
    `${r.breakoutWR.toFixed(1).padStart(5)}% │ ${String(r.breakoutTrades).padStart(8)} │ ${String(r.breakoutDetections).padStart(10)}` :
    '    - │        - │          -';
  console.log(
    `${r.method.padEnd(21)} │ ${r.bankroll.toFixed(2).padStart(9)} │ ${r.maxDD.toFixed(1).padStart(5)}% │ ${r.wr.toFixed(1).padStart(5)}% │ ${r.normalWR.toFixed(1).padStart(5)}% │ ${breakoutInfo}`
  );
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const winner = results[0];
console.log(`🏆 WINNER: ${winner.method}\n`);

if (winner.method === 'Baseline (Pure REVERSE)') {
  console.log('❌ NO BREAKOUT METHOD BEATS BASELINE\n');
  console.log('Pure REVERSE CROWD works best - no flipping needed.');
} else {
  const improvement = ((winner.bankroll / baseline.bankroll - 1) * 100).toFixed(1);
  console.log(`✅ BREAKOUT FLIP WORKS! +${improvement}% improvement\n`);
  console.log(`Method: ${winner.method}`);
  console.log(`Breakouts detected: ${winner.breakoutDetections}`);
  console.log(`Breakout trades: ${winner.breakoutTrades} (${winner.breakoutWR.toFixed(1)}% WR)`);
  console.log(`Normal trades: ${winner.normalTrades} (${winner.normalWR.toFixed(1)}% WR)`);
}
