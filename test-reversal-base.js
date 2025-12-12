import { initDatabase } from './db-init.js';

const db = initDatabase();

function runStrategy(hybridMode) {
  // hybridMode: 'none', 'combo'

  const config = {
    EMA_GAP: 0.05,
    MAX_PAYOUT: 1.55,
    MOMENTUM_MULT: 2.2,
    RECOVERY_MULT: 1.5,
    CB_THRESHOLD: 3,
    CB_COOLDOWN_MIN: 45,
    HYBRID_MODE: hybridMode,
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
  let cooldownHistory = [];
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

    if (inCooldown && config.HYBRID_MODE !== 'none') {
      // COMBO HYBRID during cooldown

      // 1. Trend Follow (last 2 same)
      if (cooldownHistory.length >= 2) {
        const last2 = cooldownHistory.slice(-2);
        const bullCount = last2.filter(w => w === 'bull').length;

        if (bullCount === 2 && bullPayout >= 1.5) {
          signal = 'BULL';
          isHybridTrade = true;
        } else if (bullCount === 0 && bearPayout >= 1.5) {
          signal = 'BEAR';
          isHybridTrade = true;
        }
      }

      // 2. Mean Reversion (last 3+ same, FADE)
      if (!signal && cooldownHistory.length >= 3) {
        const last3 = cooldownHistory.slice(-3);
        const bullCount = last3.filter(w => w === 'bull').length;

        if (bullCount >= 3 && bearPayout >= 1.6) {
          signal = 'BEAR';
          isHybridTrade = true;
        } else if (bullCount === 0 && bullPayout >= 1.6) {
          signal = 'BULL';
          isHybridTrade = true;
        }
      }

      // 3. EMA Follow fallback
      if (!signal) {
        const emaSignal = r.ema_signal;
        if (emaSignal === 'BULL' && bullPayout >= 1.5) {
          signal = 'BULL';
          isHybridTrade = true;
        } else if (emaSignal === 'BEAR' && bearPayout >= 1.5) {
          signal = 'BEAR';
          isHybridTrade = true;
        }
      }

      cooldownHistory.push(r.winner);
      if (cooldownHistory.length > 5) cooldownHistory.shift();

    } else if (!inCooldown) {
      if (cooldownHistory.length > 0) {
        cooldownHistory = [];
      }

      // *** REVERSAL CONTRARIAN STRATEGY (bet AGAINST EMA) ***
      const emaSignal = r.ema_signal;

      if (emaSignal === 'BULL' && bearPayout >= config.MAX_PAYOUT) {
        signal = 'BEAR';  // EMA bullish → bet BEAR (contrarian)
      } else if (emaSignal === 'BEAR' && bullPayout >= config.MAX_PAYOUT) {
        signal = 'BULL';  // EMA bearish → bet BULL (contrarian)
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

console.log('🔬 TESTING WITH CORRECT BASE: EMA REVERSAL (CONTRARIAN)\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

console.log('Base Strategy: EMA REVERSAL (bet AGAINST EMA signal)');
console.log('  - EMA=BULL → Bet BEAR (crowd fade)');
console.log('  - EMA=BEAR → Bet BULL (crowd fade)\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const noHybrid = runStrategy('none');
const withCombo = runStrategy('combo');

console.log('1. REVERSAL + SKIP COOLDOWN:\n');
console.log(`   Final: ${noHybrid.bankroll.toFixed(2)} BNB`);
console.log(`   ROI: +${((noHybrid.bankroll - 1) * 100).toFixed(1)}%`);
console.log(`   Max DD: ${noHybrid.maxDrawdown.toFixed(1)}%`);
console.log(`   Normal: ${noHybrid.normalTrades} trades, ${noHybrid.normalWR.toFixed(1)}% WR`);
console.log(`   Overall WR: ${noHybrid.overallWR.toFixed(1)}%\n`);

console.log('2. REVERSAL + COMBO HYBRID:\n');
console.log(`   Final: ${withCombo.bankroll.toFixed(2)} BNB`);
console.log(`   ROI: +${((withCombo.bankroll - 1) * 100).toFixed(1)}%`);
console.log(`   Max DD: ${withCombo.maxDrawdown.toFixed(1)}%`);
console.log(`   Normal: ${withCombo.normalTrades} trades, ${withCombo.normalWR.toFixed(1)}% WR`);
console.log(`   Hybrid: ${withCombo.hybridTrades} trades, ${withCombo.hybridWR.toFixed(1)}% WR`);
console.log(`   Overall WR: ${withCombo.overallWR.toFixed(1)}%\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');

if (withCombo.bankroll > noHybrid.bankroll) {
  const improvement = ((withCombo.bankroll / noHybrid.bankroll - 1) * 100).toFixed(1);
  const ddChange = withCombo.maxDrawdown - noHybrid.maxDrawdown;
  console.log(`✅ COMBO HYBRID WINS by +${improvement}%`);
  console.log(`   DD: ${ddChange >= 0 ? '+' : ''}${ddChange.toFixed(1)}% ${ddChange > 10 ? '⚠️ (worse)' : ''}\n`);
  console.log(`FINAL SETTINGS:`);
  console.log(`  /realset 0.05 1.55 2.2 1.45`);
  console.log(`  Base: EMA REVERSAL (contrarian)`);
  console.log(`  Hybrid: COMBO (Trend Follow → Mean Rev → EMA Follow)`);
} else {
  const worse = ((1 - withCombo.bankroll / noHybrid.bankroll) * 100).toFixed(1);
  console.log(`❌ HYBRID WORSE by -${worse}%\n`);
  console.log(`Cooldown hurts performance even with hybrid.`);
  console.log(`Best: /realset 0.05 1.55 2.2 1.45 (REVERSAL + SKIP)`);
}

console.log('\n💡 KEY POINT: Circuit breaker protects you from bad markets where');
console.log('   even your best REVERSAL strategy fails (3+ consecutive losses).');
