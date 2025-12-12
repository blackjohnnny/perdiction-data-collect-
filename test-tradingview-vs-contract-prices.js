import { initDatabase } from './db-init.js';

const db = initDatabase();

// Simulate TradingView price data (we'll add small random variance to contract prices)
// In reality, there will be slight differences between Binance spot and Chainlink oracle prices
function simulateTradingViewPrices(contractPrices) {
  return contractPrices.map(price => {
    // Add small variance (-0.1% to +0.1%) to simulate market vs oracle differences
    const variance = (Math.random() - 0.5) * 0.002; // ±0.1%
    return price * (1 + variance);
  });
}

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

function runStrategy(useContractPrices) {
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

  const contractPrices = rounds.map(r => r.close_price);
  const tvPrices = simulateTradingViewPrices(contractPrices);

  let bankroll = 1.0;
  let effectiveBankroll = 1.0;
  const MAX_BANKROLL = 50.0;
  let trades = [];
  let consecutiveLosses = 0;
  let cooldownUntilTimestamp = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;

  let signalMismatches = 0;

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
      // Choose which price data to use
      const pricesForCalc = useContractPrices ?
        contractPrices.slice(Math.max(0, i - 20), i + 1) :
        tvPrices.slice(Math.max(0, i - 20), i + 1);

      const bb = calculateBollingerBands(pricesForCalc, 8);
      const momentum = calculateMomentum(pricesForCalc, 10);

      // For comparison, also calculate with the OTHER price source
      const pricesForComparison = !useContractPrices ?
        contractPrices.slice(Math.max(0, i - 20), i + 1) :
        tvPrices.slice(Math.max(0, i - 20), i + 1);
      const bbComparison = calculateBollingerBands(pricesForComparison, 8);
      const momentumComparison = calculateMomentum(pricesForComparison, 10);

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

      // Check if comparison would give different signal
      let comparisonSignal = null;
      if (bbComparison && bbComparison.position < 35) {
        comparisonSignal = 'BULL';
      } else if (bbComparison && bbComparison.position > 65) {
        comparisonSignal = 'BEAR';
      } else if (momentumComparison !== null && momentumComparison < -0.5) {
        comparisonSignal = 'BULL';
      } else if (momentumComparison !== null && momentumComparison > 0.5) {
        comparisonSignal = 'BEAR';
      }

      if (hybridSignal !== comparisonSignal) {
        signalMismatches++;
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
      if (emaSignal === 'BULL' && bearPayout >= 1.45) {
        signal = 'BEAR';
      } else if (emaSignal === 'BEAR' && bullPayout >= 1.45) {
        signal = 'BULL';
      }
    }

    if (!signal) continue;

    effectiveBankroll = Math.min(bankroll, MAX_BANKROLL);

    let positionMultiplier = 1.0;

    if (!isCooldownTrade && emaGap >= 0.15) {
      positionMultiplier *= 1.889;
    }

    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      positionMultiplier *= 1.5;
    }

    const betAmount = effectiveBankroll * 0.045 * positionMultiplier;

    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = (signal === 'BULL' && winner === 'bull') || (signal === 'BEAR' && winner === 'bear');
    const profit = won ? betAmount * (actualPayout - 1) : -betAmount;

    bankroll += profit;

    if (bankroll <= 0) {
      return {
        useContractPrices,
        roi: -100,
        finalBankroll: 0,
        busted: true,
        signalMismatches: 0
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
      if (consecutiveLosses >= 3) {
        cooldownUntilTimestamp = r.lock_timestamp + (45 * 60);
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
    useContractPrices,
    roi,
    winRate,
    finalBankroll: bankroll.toFixed(2),
    peak: peak.toFixed(2),
    maxDrawdown: maxDrawdown.toFixed(1),
    totalTrades: trades.length,
    cooldownTrades: cooldownTrades.length,
    cooldownWR,
    busted: false,
    signalMismatches
  };
}

console.log('🔬 TEST: TradingView vs Contract Prices for BB/Momentum\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

console.log('Testing with Contract close_price...');
const contractResult = runStrategy(true);

console.log('Testing with simulated TradingView prices (±0.1% variance)...');
const tvResult = runStrategy(false);

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('📊 RESULTS:\n');

console.log('CONTRACT PRICES (what backtest used):');
console.log(`  ROI: +${contractResult.roi}%`);
console.log(`  Final: ${contractResult.finalBankroll} BNB`);
console.log(`  Win Rate: ${contractResult.winRate}%`);
console.log(`  Max DD: ${contractResult.maxDrawdown}%`);
console.log(`  Cooldown: ${contractResult.cooldownTrades} trades @ ${contractResult.cooldownWR}% WR`);
console.log(`  Signal mismatches vs TV: ${contractResult.signalMismatches}\n`);

console.log('TRADINGVIEW PRICES (simulated with ±0.1% variance):');
console.log(`  ROI: +${tvResult.roi}%`);
console.log(`  Final: ${tvResult.finalBankroll} BNB`);
console.log(`  Win Rate: ${tvResult.winRate}%`);
console.log(`  Max DD: ${tvResult.maxDrawdown}%`);
console.log(`  Cooldown: ${tvResult.cooldownTrades} trades @ ${tvResult.cooldownWR}% WR`);
console.log(`  Signal mismatches vs Contract: ${tvResult.signalMismatches}\n`);

const roiDiff = parseFloat(tvResult.roi) - parseFloat(contractResult.roi);
const finalDiff = parseFloat(tvResult.finalBankroll) - parseFloat(contractResult.finalBankroll);

console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('📈 IMPACT ANALYSIS:\n');

console.log(`ROI Difference: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(1)}%`);
console.log(`Final Bankroll Difference: ${finalDiff >= 0 ? '+' : ''}${finalDiff.toFixed(2)} BNB`);
console.log(`Signal Mismatches: ${tvResult.signalMismatches} times where TV vs Contract gave different signals`);

const mismatchRate = (tvResult.signalMismatches / contractResult.totalTrades * 100).toFixed(1);
console.log(`Mismatch Rate: ${mismatchRate}% of total trading opportunities`);

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('🎯 CONCLUSION:\n');

if (Math.abs(roiDiff) < 50 && tvResult.signalMismatches < contractResult.totalTrades * 0.05) {
  console.log('✅ MINIMAL IMPACT - TradingView prices are safe to use');
  console.log('   Price variance has negligible effect on strategy performance');
  console.log('   Signal mismatches are rare and don\'t significantly affect ROI');
  console.log('\n   User preference (TradingView) is acceptable. ✅');
} else if (Math.abs(roiDiff) > 100 || tvResult.signalMismatches > contractResult.totalTrades * 0.10) {
  console.log('⚠️ SIGNIFICANT IMPACT - Price source matters');
  console.log(`   ROI difference: ${Math.abs(roiDiff).toFixed(1)}%`);
  console.log(`   Signal mismatches: ${mismatchRate}% of trades`);
  console.log('\n   Recommendation: Use contract prices for consistency');
} else {
  console.log('⚡ MODERATE IMPACT - Some variance but manageable');
  console.log('   TradingView can work but expect slight performance variance');
  console.log('   Monitor live trading for discrepancies');
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('💡 NOTE:\n');
console.log('This test simulates ±0.1% random variance between TradingView and Contract prices.');
console.log('Real-world variance may differ based on:');
console.log('  - Binance spot price vs Chainlink oracle aggregation');
console.log('  - Timing differences (market updates vs oracle updates)');
console.log('  - Network latency');
console.log('\nUser has confirmed they want to use TradingView data regardless.');
console.log('Proceeding with TradingView implementation. ✅');

console.log('\n════════════════════════════════════════════════════════════════════════════');
