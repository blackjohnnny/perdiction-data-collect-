import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🔬 TEST 1: ALTERNATIVE INDICATORS\n');
console.log('═'.repeat(100) + '\n');
console.log('Testing: RSI, MACD, Bollinger Bands, Momentum, Price Action\n');
console.log('─'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Testing on ${rounds.length} complete rounds\n\n`);

function getPrice(r) {
  const lock = parseFloat(r.lock_price);
  return lock > 1000000 ? lock / 1e8 : lock;
}

// RSI Calculator
function calculateRSI(rounds, index, period = 14) {
  if (index < period) return 50;

  const prices = rounds.slice(Math.max(0, index - period), index + 1).map(r => getPrice(r));
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
  return 100 - (100 / (1 + rs));
}

// MACD Calculator
function calculateMACD(rounds, index, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (index < slowPeriod) return { macd: 0, signal: 0, histogram: 0 };

  const prices = rounds.slice(Math.max(0, index - slowPeriod), index + 1).map(r => getPrice(r));

  // Simple EMA approximation
  const fastEMA = prices.slice(-fastPeriod).reduce((a, b) => a + b, 0) / fastPeriod;
  const slowEMA = prices.reduce((a, b) => a + b, 0) / slowPeriod;
  const macd = fastEMA - slowEMA;

  // Signal line (simplified)
  const signal = macd * 0.9; // Simplified

  return {
    macd,
    signal,
    histogram: macd - signal
  };
}

// Bollinger Bands
function calculateBollingerBands(rounds, index, period = 20, stdDev = 2) {
  if (index < period) return { upper: 0, middle: 0, lower: 0, position: 50 };

  const prices = rounds.slice(Math.max(0, index - period + 1), index + 1).map(r => getPrice(r));
  const middle = prices.reduce((a, b) => a + b, 0) / prices.length;

  const variance = prices.reduce((sum, price) => sum + Math.pow(price - middle, 2), 0) / prices.length;
  const sd = Math.sqrt(variance);

  const upper = middle + (sd * stdDev);
  const lower = middle - (sd * stdDev);

  const currentPrice = prices[prices.length - 1];
  const position = ((currentPrice - lower) / (upper - lower)) * 100;

  return { upper, middle, lower, position };
}

// Simple Momentum
function calculateMomentum(rounds, index, period = 10) {
  if (index < period) return 0;

  const currentPrice = getPrice(rounds[index]);
  const oldPrice = getPrice(rounds[index - period]);

  return ((currentPrice - oldPrice) / oldPrice) * 100;
}

// Price Action Pattern (Higher Highs, Higher Lows)
function analyzePriceAction(rounds, index, lookback = 5) {
  if (index < lookback) return 'NEUTRAL';

  const prices = rounds.slice(index - lookback, index + 1).map(r => getPrice(r));

  let higherHighs = 0;
  let lowerLows = 0;

  for (let i = 1; i < prices.length - 1; i++) {
    if (prices[i] > prices[i - 1] && prices[i + 1] > prices[i]) higherHighs++;
    if (prices[i] < prices[i - 1] && prices[i + 1] < prices[i]) lowerLows++;
  }

  if (higherHighs > lowerLows + 1) return 'BULLISH';
  if (lowerLows > higherHighs + 1) return 'BEARISH';
  return 'NEUTRAL';
}

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0
};

const strategies = [
  {
    name: 'Baseline (EMA 3/7 Contrarian)',
    useEMA: true
  },
  {
    name: 'RSI Strategy (Buy <30, Sell >70)',
    useRSI: true,
    oversold: 30,
    overbought: 70
  },
  {
    name: 'RSI Strategy (Buy <40, Sell >60)',
    useRSI: true,
    oversold: 40,
    overbought: 60
  },
  {
    name: 'RSI Mean Reversion (Buy >70, Sell <30)',
    useRSI: true,
    meanReversion: true,
    oversold: 30,
    overbought: 70
  },
  {
    name: 'MACD Strategy (Histogram crossover)',
    useMACD: true
  },
  {
    name: 'Bollinger Bands (Buy at lower, Sell at upper)',
    useBollinger: true
  },
  {
    name: 'Bollinger Bands Mean Reversion (Reverse)',
    useBollinger: true,
    meanReversion: true
  },
  {
    name: 'Momentum Strategy (10-period)',
    useMomentum: true,
    threshold: 0.2
  },
  {
    name: 'Momentum Strategy (5-period, aggressive)',
    useMomentum: true,
    period: 5,
    threshold: 0.1
  },
  {
    name: 'Price Action Pattern Recognition',
    usePriceAction: true
  },
  {
    name: 'COMBO: RSI + EMA (both must agree)',
    useCombo: true,
    indicators: ['RSI', 'EMA']
  },
  {
    name: 'COMBO: MACD + Momentum',
    useCombo: true,
    indicators: ['MACD', 'MOMENTUM']
  },
  {
    name: 'COMBO: Bollinger + RSI',
    useCombo: true,
    indicators: ['BOLLINGER', 'RSI']
  }
];

function runStrategy(config) {
  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let wins = 0;
  let losses = 0;
  let skipped = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    let signal = null;

    // EMA Strategy
    if (config.useEMA) {
      const emaSignal = r.ema_signal;
      if (!emaSignal || emaSignal === 'NEUTRAL') continue;

      // Contrarian
      if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BULL';
      } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BEAR';
      }
    }

    // RSI Strategy
    if (config.useRSI) {
      const rsi = calculateRSI(rounds, i, 14);

      if (config.meanReversion) {
        // Mean reversion: buy overbought, sell oversold
        if (rsi > config.overbought && bearPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BEAR';
        else if (rsi < config.oversold && bullPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BULL';
      } else {
        // Momentum: buy oversold, sell overbought
        if (rsi < config.oversold && bearPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BULL';
        else if (rsi > config.overbought && bullPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BEAR';
      }
    }

    // MACD Strategy
    if (config.useMACD) {
      const macd = calculateMACD(rounds, i);

      if (macd.histogram > 0 && bearPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BULL';
      else if (macd.histogram < 0 && bullPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BEAR';
    }

    // Bollinger Bands
    if (config.useBollinger) {
      const bb = calculateBollingerBands(rounds, i);

      if (config.meanReversion) {
        // Mean reversion: buy at upper (expect drop), sell at lower (expect rise)
        if (bb.position > 80 && bearPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BEAR';
        else if (bb.position < 20 && bullPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BULL';
      } else {
        // Breakout: buy at lower, sell at upper
        if (bb.position < 20 && bearPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BULL';
        else if (bb.position > 80 && bullPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BEAR';
      }
    }

    // Momentum
    if (config.useMomentum) {
      const period = config.period || 10;
      const momentum = calculateMomentum(rounds, i, period);

      if (momentum > config.threshold && bearPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BULL';
      else if (momentum < -config.threshold && bullPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BEAR';
    }

    // Price Action
    if (config.usePriceAction) {
      const pattern = analyzePriceAction(rounds, i);

      if (pattern === 'BULLISH' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BULL';
      else if (pattern === 'BEARISH' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BEAR';
    }

    // COMBO
    if (config.useCombo) {
      const signals = [];

      if (config.indicators.includes('EMA')) {
        const emaSignal = r.ema_signal;
        if (emaSignal && emaSignal !== 'NEUTRAL') signals.push(emaSignal);
      }

      if (config.indicators.includes('RSI')) {
        const rsi = calculateRSI(rounds, i);
        if (rsi < 40) signals.push('BULL');
        else if (rsi > 60) signals.push('BEAR');
      }

      if (config.indicators.includes('MACD')) {
        const macd = calculateMACD(rounds, i);
        if (macd.histogram > 0) signals.push('BULL');
        else if (macd.histogram < 0) signals.push('BEAR');
      }

      if (config.indicators.includes('BOLLINGER')) {
        const bb = calculateBollingerBands(rounds, i);
        if (bb.position < 20) signals.push('BULL');
        else if (bb.position > 80) signals.push('BEAR');
      }

      if (config.indicators.includes('MOMENTUM')) {
        const momentum = calculateMomentum(rounds, i);
        if (momentum > 0.2) signals.push('BULL');
        else if (momentum < -0.2) signals.push('BEAR');
      }

      // All must agree
      if (signals.length === config.indicators.length) {
        const allBull = signals.every(s => s === 'BULL');
        const allBear = signals.every(s => s === 'BEAR');

        if (allBull && bearPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BULL';
        else if (allBear && bullPayout >= BASE_CONFIG.MIN_PAYOUT) signal = 'BEAR';
      }
    }

    if (!signal) {
      skipped++;
      continue;
    }

    // Position sizing
    let sizeMultiplier = 1.0;
    const emaGap = parseFloat(r.ema_gap) || 0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;

    if (hasStrongSignal) {
      sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    if (lastTwoResults.length === 2 && lastTwoResults.every(r => !r)) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betSize = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    if (betSize > bankroll) continue;

    const actualPayout = parseFloat(r.winner_payout_multiple);
    const won = signal.toLowerCase() === r.winner.toLowerCase();

    if (won) {
      const profit = betSize * (actualPayout - 1);
      bankroll += profit;
      wins++;
    } else {
      bankroll -= betSize;
      losses++;
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = ((bankroll - BASE_CONFIG.STARTING_BANKROLL) / BASE_CONFIG.STARTING_BANKROLL) * 100;

  return {
    trades: totalTrades,
    wins,
    losses,
    winRate,
    roi,
    bankroll,
    skipped
  };
}

console.log('Running tests...\n\n');

const results = strategies.map(strategy => ({
  ...strategy,
  ...runStrategy(strategy)
}));

// Sort by ROI
results.sort((a, b) => b.roi - a.roi);

console.log('═'.repeat(100) + '\n');
console.log('📊 ALTERNATIVE INDICATOR TEST RESULTS\n');
console.log('═'.repeat(100) + '\n\n');

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;

  console.log(`${rank} ${r.name}`);
  console.log(`   Trades: ${r.trades} | Win Rate: ${r.winRate.toFixed(1)}% | ROI: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}%`);
  console.log(`   Final Bankroll: ${r.bankroll.toFixed(3)} BNB`);
  if (r.skipped > 0) {
    console.log(`   Skipped: ${r.skipped} rounds (no signal)`);
  }
  console.log();
}

console.log('═'.repeat(100) + '\n');

const baseline = results.find(r => r.useEMA);
const best = results[0];

console.log('📈 SUMMARY:\n');
console.log(`Baseline (EMA 3/7): ${baseline.trades} trades, ${baseline.winRate.toFixed(1)}% WR, ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(2)}% ROI\n`);

if (best.roi > baseline.roi) {
  console.log(`✅ BEST ALTERNATIVE: ${best.name}`);
  console.log(`   Improvement: ${(best.roi - baseline.roi).toFixed(2)}% ROI`);
  console.log(`   Win Rate: ${best.winRate.toFixed(1)}% vs ${baseline.winRate.toFixed(1)}%`);
  console.log(`   ${best.trades} trades vs ${baseline.trades} trades\n`);
} else {
  console.log(`❌ NO ALTERNATIVE BEATS EMA 3/7`);
  console.log(`   Best alternative: ${best.name} (${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(2)}% ROI)\n`);
}

console.log('═'.repeat(100));

db.close();
