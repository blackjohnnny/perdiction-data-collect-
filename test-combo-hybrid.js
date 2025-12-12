import { initDatabase } from './db-init.js';

const db = initDatabase();

function runStrategy(hybridMode) {
  // hybridMode: 'none', 'trend_only', 'ema_only', 'combo'

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
    let hybridReason = '';

    if (inCooldown && config.HYBRID_MODE !== 'none') {
      // COMBO STRATEGY (priority order):

      // 1. TREND FOLLOW: If last 2 cooldown rounds same direction (62.2% WR)
      if (cooldownHistory.length >= 2) {
        const last2 = cooldownHistory.slice(-2);
        const bullCount = last2.filter(w => w === 'bull').length;

        if (bullCount === 2 && bullPayout >= 1.5) {
          signal = 'BULL';
          isHybridTrade = true;
          hybridReason = 'trend_follow';
        } else if (bullCount === 0 && bearPayout >= 1.5) {
          signal = 'BEAR';
          isHybridTrade = true;
          hybridReason = 'trend_follow';
        }
      }

      // 2. MEAN REVERSION: If last 3+ same direction, FADE (55% WR)
      if (!signal && config.HYBRID_MODE === 'combo' && cooldownHistory.length >= 3) {
        const last3 = cooldownHistory.slice(-3);
        const bullCount = last3.filter(w => w === 'bull').length;

        if (bullCount >= 3 && bearPayout >= 1.6) {
          signal = 'BEAR';
          isHybridTrade = true;
          hybridReason = 'mean_reversion';
        } else if (bullCount === 0 && bullPayout >= 1.6) {
          signal = 'BULL';
          isHybridTrade = true;
          hybridReason = 'mean_reversion';
        }
      }

      // 3. EMA FOLLOW: Fallback to EMA (56.5% WR)
      if (!signal && (config.HYBRID_MODE === 'ema_only' || config.HYBRID_MODE === 'combo')) {
        const emaSignal = r.ema_signal;
        if (emaSignal === 'BULL' && bullPayout >= 1.5) {
          signal = 'BULL';
          isHybridTrade = true;
          hybridReason = 'ema_follow';
        } else if (emaSignal === 'BEAR' && bearPayout >= 1.5) {
          signal = 'BEAR';
          isHybridTrade = true;
          hybridReason = 'ema_follow';
        }
      }

      cooldownHistory.push(r.winner);
      if (cooldownHistory.length > 5) cooldownHistory.shift();

    } else if (!inCooldown) {
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
      hybridTrades.push({ won, payout: actualPayout, reason: hybridReason });
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

  const trendTrades = hybridTrades.filter(t => t.reason === 'trend_follow');
  const trendWins = trendTrades.filter(t => t.won).length;
  const meanRevTrades = hybridTrades.filter(t => t.reason === 'mean_reversion');
  const meanRevWins = meanRevTrades.filter(t => t.won).length;
  const emaTrades = hybridTrades.filter(t => t.reason === 'ema_follow');
  const emaWins = emaTrades.filter(t => t.won).length;

  return {
    bankroll,
    maxDrawdown,
    normalTrades: normalTrades.length,
    normalWR,
    hybridTrades: hybridTrades.length,
    hybridWR,
    trendTrades: trendTrades.length,
    trendWins,
    meanRevTrades: meanRevTrades.length,
    meanRevWins,
    emaTrades: emaTrades.length,
    emaWins
  };
}

console.log('🔬 TESTING ALL HYBRID MODES\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const noHybrid = runStrategy('none');
const trendOnly = runStrategy('trend_only');
const emaOnly = runStrategy('ema_only');
const combo = runStrategy('combo');

console.log('1. NO HYBRID (skip cooldown):\n');
console.log(`   Final: ${noHybrid.bankroll.toFixed(2)} BNB (+${((noHybrid.bankroll-1)*100).toFixed(1)}%)`);
console.log(`   Max DD: ${noHybrid.maxDrawdown.toFixed(1)}%`);
console.log(`   Trades: ${noHybrid.normalTrades} (${noHybrid.normalWR.toFixed(1)}% WR)\n`);

console.log('2. TREND FOLLOW ONLY:\n');
console.log(`   Final: ${trendOnly.bankroll.toFixed(2)} BNB (+${((trendOnly.bankroll-1)*100).toFixed(1)}%)`);
console.log(`   Max DD: ${trendOnly.maxDrawdown.toFixed(1)}%`);
console.log(`   Normal: ${trendOnly.normalTrades} trades, ${trendOnly.normalWR.toFixed(1)}% WR`);
console.log(`   Hybrid: ${trendOnly.hybridTrades} trades, ${trendOnly.hybridWR.toFixed(1)}% WR\n`);

console.log('3. EMA FOLLOW ONLY:\n');
console.log(`   Final: ${emaOnly.bankroll.toFixed(2)} BNB (+${((emaOnly.bankroll-1)*100).toFixed(1)}%)`);
console.log(`   Max DD: ${emaOnly.maxDrawdown.toFixed(1)}%`);
console.log(`   Normal: ${emaOnly.normalTrades} trades, ${emaOnly.normalWR.toFixed(1)}% WR`);
console.log(`   Hybrid: ${emaOnly.hybridTrades} trades, ${emaOnly.hybridWR.toFixed(1)}% WR\n`);

console.log('4. COMBO (Trend → Mean Rev → EMA):\n');
console.log(`   Final: ${combo.bankroll.toFixed(2)} BNB (+${((combo.bankroll-1)*100).toFixed(1)}%)`);
console.log(`   Max DD: ${combo.maxDrawdown.toFixed(1)}%`);
console.log(`   Normal: ${combo.normalTrades} trades, ${combo.normalWR.toFixed(1)}% WR`);
console.log(`   Hybrid: ${combo.hybridTrades} trades, ${combo.hybridWR.toFixed(1)}% WR`);
console.log(`     - Trend Follow: ${combo.trendTrades} trades (${combo.trendWins}W)`);
console.log(`     - Mean Reversion: ${combo.meanRevTrades} trades (${combo.meanRevWins}W)`);
console.log(`     - EMA Follow: ${combo.emaTrades} trades (${combo.emaWins}W)\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');

const results = [
  { name: 'No Hybrid', bankroll: noHybrid.bankroll, dd: noHybrid.maxDrawdown },
  { name: 'Trend Only', bankroll: trendOnly.bankroll, dd: trendOnly.maxDrawdown },
  { name: 'EMA Only', bankroll: emaOnly.bankroll, dd: emaOnly.maxDrawdown },
  { name: 'Combo', bankroll: combo.bankroll, dd: combo.maxDrawdown }
];

results.sort((a, b) => b.bankroll - a.bankroll);

console.log('🏆 RANKING:\n');
results.forEach((r, i) => {
  const roi = ((r.bankroll - 1) * 100).toFixed(1);
  console.log(`${i + 1}. ${r.name.padEnd(15)}: ${r.bankroll.toFixed(2).padStart(8)} BNB (+${roi.padStart(6)}% ROI, ${r.dd.toFixed(1)}% DD)`);
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const best = results[0];
console.log(`✅ WINNER: ${best.name}\n`);
console.log(`Final Settings: /realset 0.05 1.55 2.2 1.45\n`);

if (best.name === 'Combo') {
  console.log(`Hybrid: COMBO Strategy (priority order)`);
  console.log(`  1. Trend Follow: Last 2 rounds same → continue (≥1.5x)`);
  console.log(`  2. Mean Reversion: Last 3+ same → fade (≥1.6x)`);
  console.log(`  3. EMA Follow: Use EMA signal fallback (≥1.5x)`);
} else if (best.name === 'Trend Only') {
  console.log(`Hybrid: Trend Follow only (last 2 rounds, ≥1.5x)`);
} else if (best.name === 'EMA Only') {
  console.log(`Hybrid: EMA Follow only (≥1.5x)`);
} else {
  console.log(`No hybrid - skip cooldowns`);
}
