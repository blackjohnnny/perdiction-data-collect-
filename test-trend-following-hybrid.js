import { initDatabase } from './db-init.js';

const db = initDatabase();

function runStrategy(hybridEnabled) {
  const config = {
    EMA_GAP: 0.05,
    MAX_PAYOUT: 1.55,
    MOMENTUM_MULT: 2.2,
    RECOVERY_MULT: 1.5,
    CB_THRESHOLD: 3,
    CB_COOLDOWN_MIN: 45,
    HYBRID_ENABLED: hybridEnabled,
    HYBRID_MIN_PAYOUT: 1.5,
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
  let cooldownHistory = []; // Track cooldown round winners
  let peak = bankroll;
  let maxDrawdown = 0;
  let normalTrades = [], hybridTrades = [];

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
      // TREND FOLLOWING HYBRID: If last 2 cooldown rounds went same direction, follow it
      if (cooldownHistory.length >= 2) {
        const last2 = cooldownHistory.slice(-2);
        const bullCount = last2.filter(w => w === 'bull').length;

        if (bullCount === 2 && bullPayout >= config.HYBRID_MIN_PAYOUT) {
          signal = 'BULL'; // Last 2 were bull, continue bull
          isHybridTrade = true;
        } else if (bullCount === 0 && bearPayout >= config.HYBRID_MIN_PAYOUT) {
          signal = 'BEAR'; // Last 2 were bear, continue bear
          isHybridTrade = true;
        }
      }

      // Track cooldown winners for next decision
      cooldownHistory.push(r.winner);
      if (cooldownHistory.length > 5) cooldownHistory.shift();

    } else if (!inCooldown) {
      // Reset cooldown history when exiting cooldown
      if (cooldownHistory.length > 0) {
        cooldownHistory = [];
      }

      // Normal EMA FOLLOW strategy
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

console.log('🔬 TESTING TREND-FOLLOWING HYBRID vs NO HYBRID\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const withHybrid = runStrategy(true);
const noHybrid = runStrategy(false);

console.log('WITH TREND-FOLLOWING HYBRID (follow last 2 cooldown rounds):\n');
console.log(`  Final: ${withHybrid.bankroll.toFixed(2)} BNB`);
console.log(`  ROI: +${((withHybrid.bankroll - 1) * 100).toFixed(1)}%`);
console.log(`  Max DD: ${withHybrid.maxDrawdown.toFixed(1)}%`);
console.log(`  Normal: ${withHybrid.normalTrades} trades, ${withHybrid.normalWR.toFixed(1)}% WR`);
console.log(`  Hybrid: ${withHybrid.hybridTrades} trades, ${withHybrid.hybridWR.toFixed(1)}% WR`);
console.log(`  Overall: ${withHybrid.totalTrades} trades, ${withHybrid.overallWR.toFixed(1)}% WR\n`);

console.log('NO HYBRID (skip cooldown):\n');
console.log(`  Final: ${noHybrid.bankroll.toFixed(2)} BNB`);
console.log(`  ROI: +${((noHybrid.bankroll - 1) * 100).toFixed(1)}%`);
console.log(`  Max DD: ${noHybrid.maxDrawdown.toFixed(1)}%`);
console.log(`  Trades: ${noHybrid.totalTrades} (${noHybrid.normalWR.toFixed(1)}% WR)\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');

if (withHybrid.bankroll > noHybrid.bankroll) {
  const improvement = ((withHybrid.bankroll / noHybrid.bankroll - 1) * 100).toFixed(1);
  console.log(`✅ TREND-FOLLOWING HYBRID WINS by +${improvement}%\n`);
  console.log(`Final Settings:`);
  console.log(`  /realset 0.05 1.55 2.2 1.45`);
  console.log(`  Hybrid: Trend-Following (follow last 2 rounds, ≥1.5x payout)`);
  console.log(`\nHybrid adds ${withHybrid.hybridTrades} trades with ${withHybrid.hybridWR.toFixed(1)}% WR!`);
} else {
  const worse = ((1 - withHybrid.bankroll / noHybrid.bankroll) * 100).toFixed(1);
  console.log(`❌ HYBRID WORSE by -${worse}%\n`);
  console.log(`Skip cooldown is still better.`);
  console.log(`  /realset 0.05 1.55 2.2 1.45 (circuit breaker SKIP)`);
}
