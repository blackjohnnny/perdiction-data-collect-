import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('🎯 TESTING WITH REALISTIC TIMING (T-10s decision point)\n');
console.log('At T-10s before lock:');
console.log('  - We can see: All previous rounds (0 to i-1)');
console.log('  - We cannot see: Current round lock/close prices');
console.log('  - We predict: Will current round go UP or DOWN\n');
console.log('═'.repeat(100) + '\n');

// Indicator calculations
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
    lower: sma - (std * stdDev)
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

// Strategy: Multi-Indicator Confluence
function multiIndicatorConfluence(historicalPrices) {
  if (historicalPrices.length < 30) return null;

  const ema3 = calculateEMA(historicalPrices, 3);
  const ema7 = calculateEMA(historicalPrices, 7);
  const bb = calculateBollingerBands(historicalPrices, 20);
  const rsi = calculateRSI(historicalPrices, 14);
  const currentPrice = historicalPrices[historicalPrices.length - 1];
  const prevPrice = historicalPrices[historicalPrices.length - 2];

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

  // 5. Momentum (last 3 candles)
  const last3 = historicalPrices.slice(-4);
  const greenCandles = last3.filter((p, i) => i > 0 && p > last3[i-1]).length;
  if (greenCandles >= 2) bullSignals++;
  if (greenCandles <= 1) bearSignals++;

  if (bullSignals >= 3) return { signal: 'BULL', strength: bullSignals };
  if (bearSignals >= 3) return { signal: 'BEAR', strength: bearSignals };
  return null;
}

// Fetch all rounds
const rounds = db.prepare(`
  SELECT epoch, lock_timestamp, t20s_bull_wei, t20s_bear_wei,
         winner, close_price, lock_price
  FROM rounds
  WHERE t20s_bull_wei IS NOT NULL
    AND t20s_bear_wei IS NOT NULL
    AND winner IS NOT NULL
    AND close_price IS NOT NULL
  ORDER BY epoch ASC
`).all();

console.log(`Total rounds available: ${rounds.length}\n`);

let bankroll = 1, peak = 1, maxDrawdown = 0;
let wins = 0, losses = 0;
let cbActive = false, cbLossStreak = 0, cbCooldownUntil = null;
let lastTwoResults = [];

// Start from round 60 (need history for indicators)
for (let i = 60; i < rounds.length; i++) {
  const currentRound = rounds[i];

  // Circuit breaker check
  if (cbActive && cbCooldownUntil && currentRound.lock_timestamp < cbCooldownUntil) continue;
  if (cbActive && cbCooldownUntil && currentRound.lock_timestamp >= cbCooldownUntil) {
    cbActive = false;
    cbCooldownUntil = null;
    cbLossStreak = 0;
  }

  // ⏰ REALISTIC TIMING: At T-10s before current round locks
  // We can ONLY see close prices from rounds 0 to i-1 (all previous completed rounds)
  const historicalPrices = rounds.slice(0, i).map(r => parseFloat(r.close_price));

  // Calculate signal based ONLY on historical data
  const result = multiIndicatorConfluence(historicalPrices);
  if (!result || !result.signal) continue;

  const signal = result.signal;

  // Get payout data (this is visible at T-20s)
  const bullAmount = parseFloat(currentRound.t20s_bull_wei) / 1e18;
  const bearAmount = parseFloat(currentRound.t20s_bear_wei) / 1e18;
  const totalAmount = bullAmount + bearAmount;
  if (totalAmount === 0) continue;

  const bullPayout = (totalAmount * 0.97) / bullAmount;
  const bearPayout = (totalAmount * 0.97) / bearAmount;
  const payout = signal === 'BULL' ? bullPayout : bearPayout;

  // Minimum payout filter
  if (payout < 1.3) continue;

  // Position sizing
  const effectiveBankroll = Math.min(bankroll, 50);
  let positionMultiplier = 1.0;

  // Recovery multiplier
  if (lastTwoResults.length >= 2 && lastTwoResults.every(res => !res)) {
    positionMultiplier *= 1.5;
  }

  const betAmount = effectiveBankroll * 0.045 * positionMultiplier;

  // Determine actual winner (we find this out 5 minutes later at close)
  const actualWinner = currentRound.winner === 'bull' ? 'BULL' : 'BEAR';
  const won = signal === actualWinner;

  // Update bankroll
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
      cbCooldownUntil = currentRound.lock_timestamp + (45 * 60);
    }
  }

  lastTwoResults.push(won);
  if (lastTwoResults.length > 2) lastTwoResults.shift();

  // Track drawdown
  if (bankroll > peak) peak = bankroll;
  const currentDD = ((peak - bankroll) / peak) * 100;
  if (currentDD > maxDrawdown) maxDrawdown = currentDD;

  // Prevent infinity
  if (bankroll > 100000) {
    bankroll = 100000;
    break;
  }

  if (bankroll <= 0) break;
}

const totalTrades = wins + losses;
const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
const roi = ((bankroll - 1) / 1) * 100;

console.log('═'.repeat(100));
console.log('📊 RESULTS WITH REALISTIC T-10s TIMING\n');
console.log(`Strategy: Multi-Indicator Confluence`);
console.log(`Decision Point: T-10s before lock (realistic entry timing)\n`);
console.log(`Starting Bankroll: 1.00 BNB`);
console.log(`Final Bankroll: ${bankroll.toFixed(2)} BNB`);
console.log(`ROI: ${roi > 999999 ? '999999+' : roi.toFixed(1)}%`);
console.log(`Max Drawdown: ${maxDrawdown.toFixed(1)}%\n`);
console.log(`Total Trades: ${totalTrades}`);
console.log(`Wins: ${wins} (${winRate.toFixed(1)}%)`);
console.log(`Losses: ${losses} (${(100 - winRate).toFixed(1)}%)`);
console.log('═'.repeat(100));

console.log('\n✅ VERIFICATION:');
console.log('  - Decision made at T-10s (10 seconds before lock)');
console.log('  - Used ONLY historical close prices (rounds 0 to i-1)');
console.log('  - Did NOT use current round lock/close price');
console.log('  - Realistic timing for live trading\n');

if (winRate > 70) {
  console.log('🎉 STRATEGY WORKS with realistic timing!');
  console.log(`   ${winRate.toFixed(1)}% win rate is profitable edge\n`);
} else if (winRate > 55) {
  console.log('⚠️  Strategy shows edge but modest');
  console.log(`   ${winRate.toFixed(1)}% win rate might work live\n`);
} else {
  console.log('❌ Strategy does not show edge');
  console.log(`   ${winRate.toFixed(1)}% win rate too low\n`);
}

db.close();
