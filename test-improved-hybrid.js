import { initDatabase } from './db-init.js';

const db = initDatabase();

function calculateBollingerBands(prices, period, stdDevMult) {
  if (prices.length < period) return null;
  const recentPrices = prices.slice(-period);
  const avg = recentPrices.reduce((a, b) => a + b, 0) / period;
  const variance = recentPrices.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = avg + (stdDevMult * stdDev);
  const lower = avg - (stdDevMult * stdDev);
  const currentPrice = prices[prices.length - 1];
  const position = ((currentPrice - lower) / (upper - lower)) * 100;
  return { upper, lower, avg, position };
}

function runStrategy(useHybrid) {
  const config = {
    EMA_GAP: 0.05,
    MAX_PAYOUT: 1.55,
    MOMENTUM_MULT: 2.2,
    RECOVERY_MULT: 1.5,
    CB_THRESHOLD: 3,
    CB_COOLDOWN_MIN: 45,
    HYBRID_ENABLED: useHybrid,
    HYBRID_BB_PERIOD: 14,
    HYBRID_BB_STDDEV: 2.5,
    HYBRID_BB_LOWER: 30,
    HYBRID_BB_UPPER: 65,
    HYBRID_MIN_PAYOUT: 1.7,
  };

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
  const MAX_BANKROLL = 50.0;
  let consecutiveLosses = 0;
  let cooldownUntilTimestamp = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;
  let normalTrades = [], hybridTrades = [];
  let allPrices = rounds.map(r => r.close_price);

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const inCooldown = r.lock_timestamp < cooldownUntilTimestamp;

    const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;

    if (totalAmount === 0) continue;

    const bullPayout = totalAmount / bullAmount;
    const bearPayout = totalAmount / bearAmount;

    let signal = null;
    let isHybridTrade = false;

    if (inCooldown && config.HYBRID_ENABLED) {
      const pricesForCalc = allPrices.slice(Math.max(0, i - 20), i + 1);
      const bb = calculateBollingerBands(pricesForCalc, config.HYBRID_BB_PERIOD, config.HYBRID_BB_STDDEV);

      if (bb && !isNaN(bb.position)) {
        if (bb.position < config.HYBRID_BB_LOWER && bullPayout >= config.HYBRID_MIN_PAYOUT) {
          signal = 'BULL';
          isHybridTrade = true;
        } else if (bb.position > config.HYBRID_BB_UPPER && bearPayout >= config.HYBRID_MIN_PAYOUT) {
          signal = 'BEAR';
          isHybridTrade = true;
        }
      }
    } else if (!inCooldown) {
      const emaSignal = r.ema_signal;
      if (emaSignal === 'BULL' && bullPayout >= config.MAX_PAYOUT) {
        signal = 'BULL';
      } else if (emaSignal === 'BEAR' && bearPayout >= config.MAX_PAYOUT) {
        signal = 'BEAR';
      }
    }

    if (!signal) continue;

    const effectiveBankroll = Math.min(bankroll, MAX_BANKROLL);
    let positionMultiplier = 1.0;

    if (!isHybridTrade) {
      const currentEmaGap = r.ema_gap || 0;
      if (currentEmaGap >= config.EMA_GAP) {
        positionMultiplier *= config.MOMENTUM_MULT;
      }
    }

    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      positionMultiplier *= config.RECOVERY_MULT;
    }

    const betAmount = effectiveBankroll * 0.045 * positionMultiplier;
    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = (signal === 'BULL' && r.winner === 'bull') || (signal === 'BEAR' && r.winner === 'bear');
    const profit = won ? betAmount * (actualPayout - 1) : -betAmount;

    bankroll += profit;

    if (bankroll <= 0) break;

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    if (isHybridTrade) {
      hybridTrades.push({ won, payout: actualPayout });
    } else {
      normalTrades.push({ won, payout: actualPayout });
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    if (won) {
      consecutiveLosses = 0;
    } else {
      consecutiveLosses++;
      if (consecutiveLosses >= config.CB_THRESHOLD) {
        cooldownUntilTimestamp = r.lock_timestamp + (config.CB_COOLDOWN_MIN * 60);
        consecutiveLosses = 0;
      }
    }
  }

  const normalWins = normalTrades.filter(t => t.won).length;
  const normalWR = normalTrades.length > 0 ? (normalWins / normalTrades.length * 100) : 0;

  const hybridWins = hybridTrades.filter(t => t.won).length;
  const hybridWR = hybridTrades.length > 0 ? (hybridWins / hybridTrades.length * 100) : 0;

  const totalTrades = normalTrades.length + hybridTrades.length;
  const totalWins = normalWins + hybridWins;
  const overallWR = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;

  return {
    bankroll,
    maxDrawdown,
    normalTrades: normalTrades.length,
    normalWR,
    hybridTrades: hybridTrades.length,
    hybridWR,
    totalTrades,
    overallWR
  };
}

console.log('🔬 TESTING IMPROVED BB HYBRID vs NO HYBRID\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const withImprovedHybrid = runStrategy(true);
const noHybrid = runStrategy(false);

console.log('WITH IMPROVED HYBRID (BB: 14 period, 2.5 stddev, 30/65, ≥1.7x):\n');
console.log(`  Final: ${withImprovedHybrid.bankroll.toFixed(2)} BNB`);
console.log(`  ROI: +${((withImprovedHybrid.bankroll - 1) * 100).toFixed(1)}%`);
console.log(`  Max DD: ${withImprovedHybrid.maxDrawdown.toFixed(1)}%`);
console.log(`  Normal: ${withImprovedHybrid.normalTrades} trades, ${withImprovedHybrid.normalWR.toFixed(1)}% WR`);
console.log(`  Hybrid: ${withImprovedHybrid.hybridTrades} trades, ${withImprovedHybrid.hybridWR.toFixed(1)}% WR`);
console.log(`  Overall: ${withImprovedHybrid.totalTrades} trades, ${withImprovedHybrid.overallWR.toFixed(1)}% WR\n`);

console.log('NO HYBRID (skip cooldown):\n');
console.log(`  Final: ${noHybrid.bankroll.toFixed(2)} BNB`);
console.log(`  ROI: +${((noHybrid.bankroll - 1) * 100).toFixed(1)}%`);
console.log(`  Max DD: ${noHybrid.maxDrawdown.toFixed(1)}%`);
console.log(`  Trades: ${noHybrid.totalTrades} (${noHybrid.normalWR.toFixed(1)}% WR)\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');

if (withImprovedHybrid.bankroll > noHybrid.bankroll) {
  const improvement = ((withImprovedHybrid.bankroll / noHybrid.bankroll - 1) * 100).toFixed(1);
  console.log(`✅ IMPROVED HYBRID WINS by +${improvement}%\n`);
  console.log(`Use: /realset 0.05 1.55 2.2 1.45`);
  console.log(`Hybrid BB: period=14, stddev=2.5x, thresholds=30/65, minPay=1.7x`);
} else {
  const worse = ((1 - withImprovedHybrid.bankroll / noHybrid.bankroll) * 100).toFixed(1);
  console.log(`❌ HYBRID STILL WORSE by -${worse}%\n`);
  console.log(`Skip cooldown is still better.`);
  console.log(`Use: /realset 0.05 1.55 2.2 1.45 (circuit breaker SKIP)`);
}
