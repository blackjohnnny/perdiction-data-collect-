const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'pancakeswap_predictions.db'));

const BASE_CONFIG = {
  INITIAL_BANKROLL: 1,
  BASE_POSITION_SIZE: 0.045,
  STOP_LOSS_PERCENT: 0.8,

  EMA_PERIOD: 10,
  REVERSE_CROWD: true,

  RECOVERY_MULTIPLIER: 1.5,

  CIRCUIT_BREAKER_ENABLED: true,
  CIRCUIT_BREAKER_LOSSES: 3,
  CIRCUIT_BREAKER_COOLDOWN_MINUTES: 45,

  HYBRID_ENABLED: true,
  HYBRID_BB_PERIOD: 10,
  HYBRID_BB_LOWER: 35,
  HYBRID_BB_UPPER: 65,
  HYBRID_MOMENTUM_PERIOD: 10,
  HYBRID_MOMENTUM_BULL: -0.5,
  HYBRID_MOMENTUM_BEAR: 0.5,
};

function calculateBollingerBands(prices, period = 20) {
  if (prices.length < period) return null;
  const recentPrices = prices.slice(-period);
  const mean = recentPrices.reduce((a, b) => a + b, 0) / period;
  const variance = recentPrices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = mean + (2 * stdDev);
  const lower = mean - (2 * stdDev);
  const currentPrice = prices[prices.length - 1];
  const position = ((currentPrice - lower) / (upper - lower)) * 100;
  return { upper, lower, mean, position, stdDev };
}

function calculateMomentum(prices, period = 10) {
  if (prices.length < period + 1) return null;
  const currentPrice = prices[prices.length - 1];
  const pastPrice = prices[prices.length - 1 - period];
  return ((currentPrice - pastPrice) / pastPrice) * 100;
}

function runFullStrategy(config) {
  const rounds = db.prepare(`
    SELECT * FROM prediction_rounds
    WHERE epoch >= 52016 AND epoch <= 54844
    AND lock_price IS NOT NULL
    AND close_price IS NOT NULL
    ORDER BY epoch ASC
  `).all();

  let bankroll = config.INITIAL_BANKROLL;
  let maxBankroll = bankroll;
  let minBankroll = bankroll;
  let consecutiveLosses = 0;
  let inCooldown = false;
  let cooldownUntilEpoch = 0;
  let wins = 0, losses = 0;
  let normalWins = 0, normalTotal = 0;
  let cooldownWins = 0, cooldownTotal = 0;
  let circuitBreakerTriggers = 0;

  const priceHistory = [];

  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i];

    priceHistory.push(round.close_price);
    if (priceHistory.length > 50) priceHistory.shift();

    if (inCooldown && round.epoch >= cooldownUntilEpoch) {
      inCooldown = false;
      consecutiveLosses = 0;
    }

    const bullAmount = parseFloat(round.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(round.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;

    if (totalAmount === 0) continue;

    const bullPayout = totalAmount / bullAmount;
    const bearPayout = totalAmount / bearAmount;

    let signal = null;
    let usedHybrid = false;

    if (inCooldown && config.HYBRID_ENABLED) {
      const pricesForCalc = priceHistory.slice();

      if (pricesForCalc.length >= config.HYBRID_BB_PERIOD) {
        const bb = calculateBollingerBands(pricesForCalc, config.HYBRID_BB_PERIOD);
        const momentum = calculateMomentum(pricesForCalc, config.HYBRID_MOMENTUM_PERIOD);

        if (bb && bb.position < config.HYBRID_BB_LOWER && bullPayout >= config.HYBRID_MIN_PAYOUT) {
          signal = 'BULL';
          usedHybrid = true;
        } else if (bb && bb.position > config.HYBRID_BB_UPPER && bearPayout >= config.HYBRID_MIN_PAYOUT) {
          signal = 'BEAR';
          usedHybrid = true;
        } else if (momentum !== null && momentum < config.HYBRID_MOMENTUM_BULL && bullPayout >= config.HYBRID_MIN_PAYOUT) {
          signal = 'BULL';
          usedHybrid = true;
        } else if (momentum !== null && momentum > config.HYBRID_MOMENTUM_BEAR && bearPayout >= config.HYBRID_MIN_PAYOUT) {
          signal = 'BEAR';
          usedHybrid = true;
        }
      }
    } else if (!inCooldown) {
      if (priceHistory.length < config.EMA_PERIOD) continue;

      const recentPrices = priceHistory.slice(-config.EMA_PERIOD);
      const emaPrice = recentPrices.reduce((a, b) => a + b, 0) / config.EMA_PERIOD;
      const lockPrice = round.lock_price;
      const emaDirection = lockPrice > emaPrice ? 'BULL' : 'BEAR';

      let minPayout = config.REVERSAL_MIN_PAYOUT;
      const payoutGap = Math.max(bullPayout, bearPayout) - Math.min(bullPayout, bearPayout);

      if (payoutGap > config.EMA_GAP_THRESHOLD) {
        minPayout = Math.max(minPayout, config.MAX_PAYOUT_THRESHOLD);
      }

      if (config.REVERSE_CROWD) {
        if (emaDirection === 'BULL' && bearPayout >= minPayout) {
          signal = 'BEAR';
        } else if (emaDirection === 'BEAR' && bullPayout >= minPayout) {
          signal = 'BULL';
        }
      }
    }

    if (!signal) continue;

    const payout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = (signal === 'BULL' && round.close_price > round.lock_price) ||
                (signal === 'BEAR' && round.close_price < round.lock_price);

    let positionSize = config.BASE_POSITION_SIZE * bankroll;

    if (!usedHybrid) {
      const payoutGap = Math.max(bullPayout, bearPayout) - Math.min(bullPayout, bearPayout);
      if (payoutGap > config.EMA_GAP_THRESHOLD) {
        positionSize *= config.MOMENTUM_MULTIPLIER;
      }
    }

    if (consecutiveLosses > 0) {
      positionSize *= Math.pow(config.RECOVERY_MULTIPLIER, consecutiveLosses);
    }

    positionSize = Math.min(positionSize, bankroll * 0.2);

    if (won) {
      bankroll += positionSize * (payout - 1);
      consecutiveLosses = 0;
      wins++;
      if (usedHybrid) {
        cooldownWins++;
        cooldownTotal++;
      } else {
        normalWins++;
        normalTotal++;
      }
    } else {
      bankroll -= positionSize;
      consecutiveLosses++;
      losses++;
      if (usedHybrid) {
        cooldownTotal++;
      } else {
        normalTotal++;
      }

      if (config.CIRCUIT_BREAKER_ENABLED && consecutiveLosses >= config.CIRCUIT_BREAKER_LOSSES && !inCooldown) {
        inCooldown = true;
        const cooldownRounds = Math.ceil(config.CIRCUIT_BREAKER_COOLDOWN_MINUTES / 5);
        cooldownUntilEpoch = round.epoch + cooldownRounds;
        circuitBreakerTriggers++;
      }
    }

    maxBankroll = Math.max(maxBankroll, bankroll);
    minBankroll = Math.min(minBankroll, bankroll);

    if (bankroll <= config.INITIAL_BANKROLL * config.STOP_LOSS_PERCENT) {
      break;
    }
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = ((bankroll - config.INITIAL_BANKROLL) / config.INITIAL_BANKROLL) * 100;
  const drawdown = maxBankroll > 0 ? ((maxBankroll - minBankroll) / maxBankroll) * 100 : 0;
  const normalWR = normalTotal > 0 ? (normalWins / normalTotal) * 100 : 0;
  const cooldownWR = cooldownTotal > 0 ? (cooldownWins / cooldownTotal) * 100 : 0;

  return {
    final: bankroll,
    roi,
    winRate,
    drawdown,
    totalTrades,
    wins,
    losses,
    normalWR,
    cooldownWR,
    normalTotal,
    cooldownTotal,
    circuitBreakerTriggers
  };
}

console.log('🔬 Testing configurations with LOWER momentum multipliers (DD <60% target)\n');

const results = [];

for (const emaGap of [0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20]) {
  for (const maxPayout of [1.40, 1.45, 1.50, 1.55]) {
    for (const momentum of [1.2, 1.3, 1.4, 1.5, 1.6]) {
      for (const hybridPay of [1.60, 1.65, 1.70]) {
        const config = {
          ...BASE_CONFIG,
          EMA_GAP_THRESHOLD: emaGap,
          MAX_PAYOUT_THRESHOLD: maxPayout,
          MOMENTUM_MULTIPLIER: momentum,
          REVERSAL_MIN_PAYOUT: 1.45,
          HYBRID_MIN_PAYOUT: hybridPay,
        };

        const result = runFullStrategy(config);

        if (result.drawdown < 60) {
          results.push({
            emaGap,
            maxPayout,
            momentum,
            hybridPay,
            ...result
          });
        }
      }
    }
  }
}

results.sort((a, b) => b.final - a.final);

console.log('🛡️ CONFIGURATIONS WITH DD <60%:\n');
console.log('Rank │ emaGap │ maxPay │ Mom  │ HybPay │   ROI    │ Final  │  DD   │ Normal │ CD WR │ CB');
console.log('─────┼────────┼────────┼──────┼────────┼──────────┼────────┼───────┼────────┼───────┼───');

results.slice(0, 20).forEach((r, i) => {
  console.log(
    `${String(i + 1).padStart(4)} │ ${r.emaGap.toFixed(2).padStart(6)} │ ${r.maxPayout.toFixed(2).padStart(6)} │ ${r.momentum.toFixed(1).padStart(4)} │ ${r.hybridPay.toFixed(2).padStart(6)} │ ${('+' + r.roi.toFixed(1) + '%').padStart(9)} │ ${r.final.toFixed(2).padStart(6)} │ ${r.drawdown.toFixed(1).padStart(5)}% │ ${r.normalWR.toFixed(1).padStart(5)}% │ ${r.cooldownWR.toFixed(1).padStart(5)}% │ ${String(r.circuitBreakerTriggers).padStart(2)}`
  );
});

if (results.length === 0) {
  console.log('\n❌ NO configurations found with DD <60%');
  console.log('\nThe issue: Even with lower momentum multipliers, the recovery multiplier (1.5^consecutiveLosses)');
  console.log('combined with 4.5% base position creates large bets during losing streaks.\n');
} else {
  const best = results[0];
  console.log(`\n🏆 BEST WITH DD <60%:\n`);
  console.log(`/realset ${best.emaGap} ${best.maxPayout} ${best.momentum} 1.45`);
  console.log(`Hybrid Min Payout: ${best.hybridPay}x`);
  console.log(`Final: ${best.final.toFixed(2)} BNB | ROI: +${best.roi.toFixed(1)}% | DD: ${best.drawdown.toFixed(1)}%`);
  console.log(`\nPerformance:`);
  console.log(`  Normal: ${best.normalTotal} trades, ${best.normalWR.toFixed(1)}% WR`);
  console.log(`  Cooldown: ${best.cooldownTotal} trades, ${best.cooldownWR.toFixed(1)}% WR`);
  console.log(`  Circuit Breakers: ${best.circuitBreakerTriggers} times`);
}
