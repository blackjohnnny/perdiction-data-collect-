import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('🔬 BREAKOUT DETECTION THEORY\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('Strategy:');
console.log('  - Normal: REVERSE CROWD (fade crowd on high payout)');
console.log('  - Breakout detected: FLIP to opposite (follow crowd)');
console.log('  - Detection: TradingView price data + indicators\n');
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

console.log(`Total rounds: ${rounds.length}\n`);

// Calculate indicators from TradingView price data
function calculateATR(prices, period = 14) {
  if (prices.length < period + 1) return null;

  const trs = [];
  for (let i = 1; i < prices.length; i++) {
    const high = Math.max(prices[i], prices[i-1]);
    const low = Math.min(prices[i], prices[i-1]);
    trs.push(high - low);
  }

  const atr = trs.slice(-period).reduce((sum, tr) => sum + tr, 0) / period;
  return atr;
}

function calculateBollingerBands(prices, period = 20, stdDevMult = 2) {
  if (prices.length < period) return null;

  const recentPrices = prices.slice(-period);
  const avg = recentPrices.reduce((a, b) => a + b, 0) / period;
  const variance = recentPrices.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = avg + (stdDevMult * stdDev);
  const lower = avg - (stdDevMult * stdDev);
  const currentPrice = prices[prices.length - 1];

  return { upper, lower, avg, currentPrice, stdDev, bandwidth: (upper - lower) / avg };
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;

  const changes = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? -c : 0);

  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateVolatility(prices, period = 10) {
  if (prices.length < period) return null;

  const returns = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    returns.push((prices[i] - prices[i-1]) / prices[i-1]);
  }

  const variance = returns.reduce((sum, r) => sum + r * r, 0) / period;
  return Math.sqrt(variance);
}

// Breakout detection methods
function detectBreakout(prices, i, method) {
  if (prices.length < 20) return false;

  const currentPrice = prices[prices.length - 1];
  const prevPrice = prices[prices.length - 2];
  const priceChange = ((currentPrice - prevPrice) / prevPrice) * 100;

  if (method === 'bollinger_squeeze') {
    // BB Squeeze: Low bandwidth then price moves outside bands
    const bb = calculateBollingerBands(prices, 20, 2);
    if (!bb) return false;

    // Check if bandwidth is contracting (squeeze)
    const prevBB = calculateBollingerBands(prices.slice(0, -1), 20, 2);
    if (!prevBB) return false;

    const bandwidthChange = ((bb.bandwidth - prevBB.bandwidth) / prevBB.bandwidth);

    // Breakout = low bandwidth + price breaking out of bands
    const lowBandwidth = bb.bandwidth < 0.02; // Tight squeeze
    const priceBreakout = currentPrice > bb.upper || currentPrice < bb.lower;

    return lowBandwidth && priceBreakout;

  } else if (method === 'volatility_spike') {
    // Volatility breakout: sudden volatility increase
    const vol = calculateVolatility(prices, 10);
    const avgVol = calculateVolatility(prices.slice(0, -5), 10);
    if (!vol || !avgVol) return false;

    // Volatility increased by 50%+
    return vol > avgVol * 1.5;

  } else if (method === 'atr_expansion') {
    // ATR expansion: price moving with expanding range
    const atr = calculateATR(prices, 14);
    const prevATR = calculateATR(prices.slice(0, -1), 14);
    if (!atr || !prevATR) return false;

    const atrIncrease = (atr - prevATR) / prevATR;
    const strongMove = Math.abs(priceChange) > 0.5;

    return atrIncrease > 0.2 && strongMove;

  } else if (method === 'price_momentum') {
    // Strong momentum: 3 candles same direction with increasing size
    if (prices.length < 4) return false;

    const last3Changes = [];
    for (let j = 0; j < 3; j++) {
      const idx = prices.length - 1 - j;
      last3Changes.push(prices[idx] - prices[idx - 1]);
    }

    // All same direction
    const allBull = last3Changes.every(c => c > 0);
    const allBear = last3Changes.every(c => c < 0);

    if (!allBull && !allBear) return false;

    // Increasing magnitude
    const sizes = last3Changes.map(Math.abs);
    return sizes[0] > sizes[1] && sizes[1] > sizes[2];

  } else if (method === 'range_breakout') {
    // Price breaks out of recent range (10-round high/low)
    const last10 = prices.slice(-11, -1); // Not including current
    const rangeHigh = Math.max(...last10);
    const rangeLow = Math.min(...last10);
    const rangeSize = rangeHigh - rangeLow;

    // Tight range then breakout
    const tightRange = rangeSize / rangeLow < 0.01; // <1% range
    const breakout = currentPrice > rangeHigh * 1.002 || currentPrice < rangeLow * 0.998;

    return tightRange && breakout;

  } else if (method === 'ema_acceleration') {
    // EMA direction + acceleration
    if (prices.length < 15) return false;

    const ema10 = prices.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const ema10_prev = prices.slice(-11, -1).reduce((a, b) => a + b, 0) / 10;
    const ema10_prev2 = prices.slice(-12, -2).reduce((a, b) => a + b, 0) / 10;

    const emaChange = ema10 - ema10_prev;
    const emaChangePrev = ema10_prev - ema10_prev2;

    // Acceleration = change is increasing
    return Math.abs(emaChange) > Math.abs(emaChangePrev) * 1.3;
  }

  return false;
}

function testStrategy(detectionMethod) {
  let bankroll = 1.0;
  let peak = bankroll;
  let maxDD = 0;

  let trades = 0, wins = 0;
  let normalTrades = 0, normalWins = 0;
  let breakoutTrades = 0, breakoutWins = 0;
  let breakoutDetections = 0;

  const priceHistory = [];
  let lastTwoResults = [];

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
    const isBreakout = detectBreakout(priceHistory, i, detectionMethod);
    if (isBreakout) breakoutDetections++;

    // Determine final signal
    let signal = baseSignal;
    if (isBreakout) {
      // FLIP: do opposite of REVERSE CROWD
      signal = baseSignal === 'BULL' ? 'BEAR' : 'BULL';
    }

    // Position sizing
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

    if (isBreakout) {
      breakoutTrades++;
      if (won) breakoutWins++;
    } else {
      normalTrades++;
      if (won) normalWins++;
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();
  }

  const wr = trades > 0 ? (wins / trades * 100) : 0;
  const normalWR = normalTrades > 0 ? (normalWins / normalTrades * 100) : 0;
  const breakoutWR = breakoutTrades > 0 ? (breakoutWins / breakoutTrades * 100) : 0;

  return {
    method: detectionMethod,
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

console.log('Testing breakout detection methods:\n');

const methods = [
  'bollinger_squeeze',
  'volatility_spike',
  'atr_expansion',
  'price_momentum',
  'range_breakout',
  'ema_acceleration'
];

const results = [];

// Baseline
let baseline = testStrategy('none'); // Will use normal only
baseline.method = 'Baseline (no breakout flip)';
baseline.normalTrades = baseline.trades;
baseline.normalWins = baseline.trades * (baseline.wr / 100);
baseline.normalWR = baseline.wr;
baseline.breakoutTrades = 0;
baseline.breakoutWR = 0;
baseline.breakoutDetections = 0;

// Recalculate baseline properly
let bankroll = 1.0;
let peak = 1.0;
let maxDD = 0;
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
  const betAmount = effectiveBankroll * 0.045;
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
}

baseline = {
  method: 'Baseline (no breakout flip)',
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

results.push(baseline);

// Test all methods
for (const method of methods) {
  const result = testStrategy(method);
  results.push(result);
}

results.sort((a, b) => b.bankroll - a.bankroll);

console.log('Detection Method         │  Final   │  DD   │ Overall │ Normal │ B.Out │ B.Trades │ Detections');
console.log('─────────────────────────┼──────────┼───────┼─────────┼────────┼───────┼──────────┼───────────');

results.forEach(r => {
  const breakoutInfo = r.breakoutTrades > 0 ? `${r.breakoutWR.toFixed(1).padStart(5)}% │ ${String(r.breakoutTrades).padStart(8)} │ ${String(r.breakoutDetections).padStart(10)}` : '    - │        - │          -';
  console.log(
    `${r.method.padEnd(24)} │ ${r.bankroll.toFixed(2).padStart(8)} │ ${r.maxDD.toFixed(1).padStart(5)}% │ ${r.wr.toFixed(1).padStart(5)}% │ ${r.normalWR.toFixed(1).padStart(5)}% │ ${breakoutInfo}`
  );
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const winner = results[0];
console.log(`🏆 WINNER: ${winner.method}\n`);
console.log(`Final: ${winner.bankroll.toFixed(2)} BNB`);
console.log(`Max DD: ${winner.maxDD.toFixed(1)}%`);
console.log(`Overall WR: ${winner.wr.toFixed(1)}%\n`);

if (winner.breakoutTrades > 0) {
  console.log(`Breakout Detection:`);
  console.log(`  Detections: ${winner.breakoutDetections}`);
  console.log(`  Trades during breakout: ${winner.breakoutTrades}`);
  console.log(`  Breakout WR: ${winner.breakoutWR.toFixed(1)}%`);
  console.log(`  Normal WR: ${winner.normalWR.toFixed(1)}%\n`);

  const improvement = ((winner.bankroll / baseline.bankroll - 1) * 100).toFixed(1);
  if (parseFloat(improvement) > 0) {
    console.log(`✅ BREAKOUT THEORY WORKS! ${improvement}% better than baseline`);
  } else {
    console.log(`❌ Breakout detection hurts - ${Math.abs(improvement)}% worse than baseline`);
  }
} else {
  console.log(`❌ Baseline wins - no benefit from breakout detection`);
}
