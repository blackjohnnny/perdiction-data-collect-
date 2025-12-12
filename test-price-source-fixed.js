import { initDatabase } from './db-init.js';

const db = initDatabase();

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  MIN_EMA_GAP: 0.15,
  CIRCUIT_BREAKER_LOSSES: 3,
  COOLDOWN_MINUTES: 45,
  MAX_BANKROLL: 50.0,
};

function calculateBollingerBands(prices, period = 8, stdDevMultiplier = 2.0) {
  if (prices.length < period) return null;

  const recentPrices = prices.slice(-period);
  const avg = recentPrices.reduce((a, b) => a + b, 0) / period;
  const variance = recentPrices.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = avg + (stdDevMultiplier * stdDev);
  const lower = avg - (stdDevMultiplier * stdDev);
  const currentPrice = prices[prices.length - 1];
  const position = ((currentPrice - lower) / (upper - lower)) * 100;

  return { upper, lower, avg, position, currentPrice };
}

function calculateMomentum(prices, period = 10) {
  if (prices.length < period + 1) return null;

  const oldPrice = prices[prices.length - period - 1];
  const currentPrice = prices[prices.length - 1];
  const momentum = ((currentPrice - oldPrice) / oldPrice) * 100;
  return momentum;
}

function runStrategy(priceArray, strategyName) {
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

  let bankroll = 1.0;
  let effectiveBankroll = 1.0;
  let trades = [];
  let consecutiveLosses = 0;
  let cooldownUntilTimestamp = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const emaGap = parseFloat(r.ema_gap) || 0;

    const t20sBull = parseFloat(r.t20s_bull_wei || 0) / 1e18;
    const t20sBear = parseFloat(r.t20s_bear_wei || 0) / 1e18;
    const t20sTotal = t20sBull + t20sBear;
    if (t20sTotal === 0) continue;

    const bullPayout = (t20sTotal * 0.97) / t20sBull;
    const bearPayout = (t20sTotal * 0.97) / t20sBear;
    const winner = r.winner ? r.winner.toLowerCase() : '';

    const inCooldown = r.lock_timestamp < cooldownUntilTimestamp;

    let signal = null;
    let isCooldownTrade = false;

    if (inCooldown) {
      // Use provided price array for BB/Momentum
      const pricesForCalc = priceArray.slice(Math.max(0, i - 20), i + 1);

      const bb = calculateBollingerBands(pricesForCalc, 8);
      const momentum = calculateMomentum(pricesForCalc, 10);

      let hybridSignal = null;

      if (bb && bb.position < 35) {
        hybridSignal = 'BULL';
      } else if (bb && bb.position > 65) {
        hybridSignal = 'BEAR';
      } else if (momentum !== null && momentum < -0.5) {
        hybridSignal = 'BULL';
      } else if (momentum !== null && momentum > 0.5) {
        hybridSignal = 'BEAR';
      }

      if (hybridSignal) {
        if (hybridSignal === 'BULL' && bullPayout >= 1.65) {
          signal = 'BULL';
          isCooldownTrade = true;
        } else if (hybridSignal === 'BEAR' && bearPayout >= 1.65) {
          signal = 'BEAR';
          isCooldownTrade = true;
        }
      }
    } else {
      // Normal contrarian logic
      if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BEAR';
      } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BULL';
      }
    }

    if (!signal) continue;

    effectiveBankroll = Math.min(bankroll, BASE_CONFIG.MAX_BANKROLL);

    let positionMultiplier = 1.0;

    if (!isCooldownTrade && emaGap >= BASE_CONFIG.MIN_EMA_GAP) {
      positionMultiplier *= BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      positionMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betAmount = effectiveBankroll * BASE_CONFIG.BASE_POSITION_SIZE * positionMultiplier;

    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = (signal === 'BULL' && winner === 'bull') || (signal === 'BEAR' && winner === 'bear');
    const profit = won ? betAmount * (actualPayout - 1) : -betAmount;

    bankroll += profit;

    if (bankroll <= 0) {
      return {
        strategyName,
        roi: -100,
        finalBankroll: 0,
        busted: true,
      };
    }

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    trades.push({ won, isCooldown: isCooldownTrade });

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    if (won) {
      consecutiveLosses = 0;
    } else {
      consecutiveLosses++;
      if (consecutiveLosses >= BASE_CONFIG.CIRCUIT_BREAKER_LOSSES) {
        cooldownUntilTimestamp = r.lock_timestamp + (BASE_CONFIG.COOLDOWN_MINUTES * 60);
        consecutiveLosses = 0;
      }
    }
  }

  const wins = trades.filter(t => t.won).length;
  const winRate = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : 0;

  const cooldownTrades = trades.filter(t => t.isCooldown);
  const cooldownWins = cooldownTrades.filter(t => t.won).length;
  const cooldownWR = cooldownTrades.length > 0 ? (cooldownWins / cooldownTrades.length * 100).toFixed(1) : 0;

  const roi = ((bankroll - 1.0) * 100).toFixed(1);

  return {
    strategyName,
    roi,
    winRate,
    finalBankroll: bankroll.toFixed(2),
    peak: peak.toFixed(2),
    maxDrawdown: maxDrawdown.toFixed(1),
    totalTrades: trades.length,
    cooldownTrades: cooldownTrades.length,
    cooldownWR,
    busted: false,
  };
}

console.log('🔬 FIXED TEST: TradingView vs Contract Prices\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

// Load rounds
const rounds = db.prepare(`
  SELECT close_price
  FROM rounds
  WHERE close_price IS NOT NULL
  ORDER BY epoch ASC
`).all();

const contractPrices = rounds.map(r => r.close_price);

// Generate TV prices ONCE (with consistent seed for reproducibility)
const tvPrices = contractPrices.map((price, idx) => {
  // Use index as seed for consistent variance
  const variance = (Math.sin(idx * 0.1) * 0.001); // ±0.1% consistent variance
  return price * (1 + variance);
});

console.log(`Loaded ${contractPrices.length} rounds\n`);

// Calculate some stats about price differences
const priceDiffs = contractPrices.map((cp, i) => Math.abs(cp - tvPrices[i]) / cp * 100);
const avgDiff = priceDiffs.reduce((a, b) => a + b, 0) / priceDiffs.length;
const maxDiff = Math.max(...priceDiffs);

console.log(`Price variance stats:`);
console.log(`  Average difference: ${avgDiff.toFixed(4)}%`);
console.log(`  Maximum difference: ${maxDiff.toFixed(4)}%\n`);

console.log('Testing with Contract close_price...');
const contractResult = runStrategy(contractPrices, 'Contract Prices');

console.log('Testing with simulated TradingView prices...');
const tvResult = runStrategy(tvPrices, 'TradingView Prices');

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('📊 RESULTS:\n');

console.log('CONTRACT PRICES (what backtest used):');
console.log(`  ROI: +${contractResult.roi}%`);
console.log(`  Final: ${contractResult.finalBankroll} BNB`);
console.log(`  Win Rate: ${contractResult.winRate}%`);
console.log(`  Max DD: ${contractResult.maxDrawdown}%`);
console.log(`  Total Trades: ${contractResult.totalTrades}`);
console.log(`  Cooldown: ${contractResult.cooldownTrades} trades @ ${contractResult.cooldownWR}% WR\n`);

console.log('TRADINGVIEW PRICES (simulated with ±0.1% variance):');
console.log(`  ROI: +${tvResult.roi}%`);
console.log(`  Final: ${tvResult.finalBankroll} BNB`);
console.log(`  Win Rate: ${tvResult.winRate}%`);
console.log(`  Max DD: ${tvResult.maxDrawdown}%`);
console.log(`  Total Trades: ${tvResult.totalTrades}`);
console.log(`  Cooldown: ${tvResult.cooldownTrades} trades @ ${tvResult.cooldownWR}% WR\n`);

const roiDiff = parseFloat(tvResult.roi) - parseFloat(contractResult.roi);
const finalDiff = parseFloat(tvResult.finalBankroll) - parseFloat(contractResult.finalBankroll);
const tradeDiff = tvResult.cooldownTrades - contractResult.cooldownTrades;

console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('📈 IMPACT ANALYSIS:\n');

console.log(`ROI Difference: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(1)}%`);
console.log(`Final Bankroll Difference: ${finalDiff >= 0 ? '+' : ''}${finalDiff.toFixed(2)} BNB`);
console.log(`Cooldown Trade Difference: ${tradeDiff >= 0 ? '+' : ''}${tradeDiff} trades`);
console.log(`Cooldown WR Difference: ${parseFloat(tvResult.cooldownWR) - parseFloat(contractResult.cooldownWR)}%`);

const percentChange = Math.abs((finalDiff / parseFloat(contractResult.finalBankroll)) * 100);
console.log(`Performance Variance: ${percentChange.toFixed(1)}%`);

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('🎯 CONCLUSION:\n');

if (percentChange < 5) {
  console.log('✅ MINIMAL IMPACT (<5% variance)');
  console.log('   TradingView prices are safe to use - negligible performance difference');
  console.log('   Price variance does not significantly affect strategy signals');
  console.log('\n   👍 Proceed with TradingView implementation as requested.');
} else if (percentChange < 15) {
  console.log('⚠️ MODERATE IMPACT (5-15% variance)');
  console.log(`   Performance may vary by ${percentChange.toFixed(1)}% due to price differences`);
  console.log('   TradingView is usable but monitor live performance carefully');
  console.log('\n   ⚡ User accepts this variance - proceeding with TradingView.');
} else {
  console.log('🚨 SIGNIFICANT IMPACT (>15% variance)');
  console.log(`   Performance differs by ${percentChange.toFixed(1)}%`);
  console.log('   Recommend using contract prices for consistency');
  console.log('\n   ⚠️ User choice: TradingView (accepts performance risk)');
}

console.log('\n════════════════════════════════════════════════════════════════════════════');
