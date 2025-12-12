import { initDatabase } from './db-init.js';

const db = initDatabase();

function runStrategy(hybridConfig) {
  // hybridConfig: 'none', 'trend_only', 'meanrev_only', 'ema_only', 'trend+meanrev', 'trend+ema', 'combo'

  const config = {
    EMA_GAP: 0.05,
    MAX_PAYOUT: 1.55,
    MOMENTUM_MULT: 2.2,
    RECOVERY_MULT: 1.5,
    CB_THRESHOLD: 3,
    CB_COOLDOWN_MIN: 45,
    HYBRID_CONFIG: hybridConfig,
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
  let contradictions = 0; // Track when strategies conflict

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

    if (inCooldown && config.HYBRID_CONFIG !== 'none') {
      let trendSignal = null, meanRevSignal = null, emaSignal = null;

      // Check what each strategy says
      const useTrend = ['trend_only', 'trend+meanrev', 'trend+ema', 'combo'].includes(config.HYBRID_CONFIG);
      const useMeanRev = ['meanrev_only', 'trend+meanrev', 'combo'].includes(config.HYBRID_CONFIG);
      const useEma = ['ema_only', 'trend+ema', 'combo'].includes(config.HYBRID_CONFIG);

      // 1. Trend Follow
      if (useTrend && cooldownHistory.length >= 2) {
        const last2 = cooldownHistory.slice(-2);
        const bullCount = last2.filter(w => w === 'bull').length;

        if (bullCount === 2 && bullPayout >= 1.5) {
          trendSignal = 'BULL';
        } else if (bullCount === 0 && bearPayout >= 1.5) {
          trendSignal = 'BEAR';
        }
      }

      // 2. Mean Reversion
      if (useMeanRev && cooldownHistory.length >= 3) {
        const last3 = cooldownHistory.slice(-3);
        const bullCount = last3.filter(w => w === 'bull').length;

        if (bullCount >= 3 && bearPayout >= 1.6) {
          meanRevSignal = 'BEAR';
        } else if (bullCount === 0 && bullPayout >= 1.6) {
          meanRevSignal = 'BULL';
        }
      }

      // 3. EMA Follow
      if (useEma) {
        const emaDir = r.ema_signal;
        if (emaDir === 'BULL' && bullPayout >= 1.5) {
          emaSignal = 'BULL';
        } else if (emaDir === 'BEAR' && bearPayout >= 1.5) {
          emaSignal = 'BEAR';
        }
      }

      // Check for contradictions
      if (trendSignal && meanRevSignal && trendSignal !== meanRevSignal) {
        contradictions++;
      }

      // Priority system
      if (trendSignal) {
        signal = trendSignal;
        isHybridTrade = true;
        hybridReason = 'trend';
      } else if (meanRevSignal) {
        signal = meanRevSignal;
        isHybridTrade = true;
        hybridReason = 'meanrev';
      } else if (emaSignal) {
        signal = emaSignal;
        isHybridTrade = true;
        hybridReason = 'ema';
      }

      cooldownHistory.push(r.winner);
      if (cooldownHistory.length > 5) cooldownHistory.shift();

    } else if (!inCooldown) {
      if (cooldownHistory.length > 0) {
        cooldownHistory = [];
      }

      // REVERSE CROWD base strategy
      const emaDir = r.ema_signal;
      if (emaDir === 'BULL' && bullPayout > bearPayout && bullPayout >= config.MAX_PAYOUT) {
        signal = 'BULL';
      } else if (emaDir === 'BEAR' && bearPayout > bullPayout && bearPayout >= config.MAX_PAYOUT) {
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

    if (bankroll <= 0) {
      return {
        bankroll: 0,
        busted: true,
        maxDrawdown: 100,
        normalTrades: normalTrades.length,
        normalWR: 0,
        hybridTrades: hybridTrades.length,
        hybridWR: 0,
        totalTrades: normalTrades.length + hybridTrades.length,
        overallWR: 0,
        contradictions: 0
      };
    }

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

  const trendTrades = hybridTrades.filter(t => t.reason === 'trend');
  const trendWins = trendTrades.filter(t => t.won).length;
  const meanRevTrades = hybridTrades.filter(t => t.reason === 'meanrev');
  const meanRevWins = meanRevTrades.filter(t => t.won).length;
  const emaTrades = hybridTrades.filter(t => t.reason === 'ema');
  const emaWins = emaTrades.filter(t => t.won).length;

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
    overallWR,
    busted: false,
    trendTrades: trendTrades.length,
    trendWins,
    meanRevTrades: meanRevTrades.length,
    meanRevWins,
    emaTrades: emaTrades.length,
    emaWins,
    contradictions
  };
}

console.log('🔬 TESTING HYBRID COMPONENTS\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const configs = [
  { name: 'SKIP (no hybrid)', config: 'none' },
  { name: 'Trend ONLY', config: 'trend_only' },
  { name: 'MeanRev ONLY', config: 'meanrev_only' },
  { name: 'EMA ONLY', config: 'ema_only' },
  { name: 'Trend + MeanRev', config: 'trend+meanrev' },
  { name: 'Trend + EMA', config: 'trend+ema' },
  { name: 'COMBO (all 3)', config: 'combo' }
];

const results = [];

for (const c of configs) {
  const result = runStrategy(c.config);
  results.push({
    name: c.name,
    ...result
  });
}

results.sort((a, b) => b.bankroll - a.bankroll);

console.log('📊 RESULTS:\n');
console.log('Strategy            │  Final   │    ROI    │  DD   │ H.Trades │ H.WR  │ Overall WR');
console.log('────────────────────┼──────────┼───────────┼───────┼──────────┼───────┼───────────');

results.forEach(r => {
  const roi = ((r.bankroll - 1) * 100).toFixed(0);
  const hybridInfo = r.hybridTrades > 0 ? `${String(r.hybridTrades).padStart(8)} │ ${r.hybridWR.toFixed(1).padStart(5)}%` : '       - │     - ';
  console.log(
    `${r.name.padEnd(19)} │ ${r.bankroll.toFixed(2).padStart(8)} │ ${('+' + roi + '%').padStart(9)} │ ${r.maxDrawdown.toFixed(1).padStart(5)}% │ ${hybridInfo} │ ${r.overallWR.toFixed(1).padStart(5)}%`
  );
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

// Detailed breakdown for COMBO
const combo = results.find(r => r.name === 'COMBO (all 3)');
if (combo && combo.hybridTrades > 0) {
  console.log('🔍 COMBO BREAKDOWN:\n');
  const trendWR = combo.trendTrades > 0 ? (combo.trendWins / combo.trendTrades * 100).toFixed(1) : 0;
  const meanRevWR = combo.meanRevTrades > 0 ? (combo.meanRevWins / combo.meanRevTrades * 100).toFixed(1) : 0;
  const emaWR = combo.emaTrades > 0 ? (combo.emaWins / combo.emaTrades * 100).toFixed(1) : 0;

  console.log(`  Trend Follow:    ${combo.trendTrades} trades, ${combo.trendWins} wins (${trendWR}% WR)`);
  console.log(`  Mean Reversion:  ${combo.meanRevTrades} trades, ${combo.meanRevWins} wins (${meanRevWR}% WR)`);
  console.log(`  EMA Fallback:    ${combo.emaTrades} trades, ${combo.emaWins} wins (${emaWR}% WR)`);
  console.log(`  Contradictions:  ${combo.contradictions} times (Trend vs MeanRev conflict)\n`);

  const contradictionRate = combo.hybridTrades > 0 ? (combo.contradictions / combo.hybridTrades * 100).toFixed(1) : 0;
  console.log(`  Contradiction Rate: ${contradictionRate}% of hybrid trades\n`);
}

console.log('════════════════════════════════════════════════════════════════════════════\n');

const winner = results[0];
console.log(`🏆 WINNER: ${winner.name}\n`);
console.log(`Final: ${winner.bankroll.toFixed(2)} BNB (+${((winner.bankroll-1)*100).toFixed(0)}%)`);
console.log(`Max DD: ${winner.maxDrawdown.toFixed(1)}%`);
console.log(`Overall WR: ${winner.overallWR.toFixed(1)}%\n`);

console.log('💡 RECOMMENDATION:\n');

if (winner.name === 'SKIP (no hybrid)') {
  console.log('Skip cooldown is best - hybrid adds noise, not value.');
} else if (winner.name.includes('ONLY')) {
  console.log(`Use ${winner.name} - simple and effective, no need for complexity.`);
} else {
  console.log(`Use ${winner.name} - combination provides best balance of trades and WR.`);
}

// Check if removing components improves results
const skip = results.find(r => r.name === 'SKIP (no hybrid)');
const bestHybrid = results.filter(r => r.name !== 'SKIP (no hybrid)')[0];

if (bestHybrid && skip) {
  const improvement = ((bestHybrid.bankroll / skip.bankroll - 1) * 100).toFixed(1);
  const ddChange = bestHybrid.maxDrawdown - skip.maxDrawdown;

  console.log(`\nHybrid improves returns by ${improvement}% but adds ${ddChange.toFixed(1)}% DD.`);

  if (improvement < 5) {
    console.log('⚠️ Hybrid barely helps - consider skipping for simplicity.');
  } else if (ddChange > 10) {
    console.log('⚠️ Hybrid adds significant DD - evaluate risk tolerance.');
  } else {
    console.log('✅ Hybrid worth the added complexity.');
  }
}
