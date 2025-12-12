import { initDatabase } from './db-init.js';

const db = initDatabase();

function runStrategy(baseStrategy, hybridMode) {
  // baseStrategy: 'follow' or 'reversal'
  // hybridMode: 'none' or 'combo'

  const config = {
    EMA_GAP: 0.05,
    MAX_PAYOUT: 1.55,
    MOMENTUM_MULT: 2.2,
    RECOVERY_MULT: 1.5,
    CB_THRESHOLD: 3,
    CB_COOLDOWN_MIN: 45,
    BASE_STRATEGY: baseStrategy,
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

      // 1. Trend Follow
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

      // 2. Mean Reversion
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

      const emaSignal = r.ema_signal;

      if (config.BASE_STRATEGY === 'follow') {
        // FOLLOW CROWD: Bet WITH EMA
        if (emaSignal === 'BULL' && bullPayout >= config.MAX_PAYOUT) {
          signal = 'BULL';
        } else if (emaSignal === 'BEAR' && bearPayout >= config.MAX_PAYOUT) {
          signal = 'BEAR';
        }
      } else {
        // REVERSAL/CONTRARIAN: Bet AGAINST EMA
        if (emaSignal === 'BULL' && bearPayout >= config.MAX_PAYOUT) {
          signal = 'BEAR';
        } else if (emaSignal === 'BEAR' && bullPayout >= config.MAX_PAYOUT) {
          signal = 'BULL';
        }
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
        bustRound: i,
        maxDrawdown: 100,
        normalTrades: normalTrades.length,
        normalWR: 0,
        hybridTrades: hybridTrades.length,
        hybridWR: 0,
        totalTrades: normalTrades.length + hybridTrades.length,
        overallWR: 0
      };
    }

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
    overallWR,
    busted: false
  };
}

console.log('🔬 FOLLOW vs REVERSAL - ULTIMATE COMPARISON\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

console.log('Testing 4 configurations:\n');

const followSkip = runStrategy('follow', 'none');
const followCombo = runStrategy('follow', 'combo');
const reversalSkip = runStrategy('reversal', 'none');
const reversalCombo = runStrategy('reversal', 'combo');

console.log('1️⃣  FOLLOW CROWD + SKIP COOLDOWN\n');
console.log('   Strategy: Bet WITH EMA (when EMA=BULL, bet BULL if payout ≥1.55x)');
console.log(`   Final: ${followSkip.bankroll.toFixed(2)} BNB (+${((followSkip.bankroll-1)*100).toFixed(1)}%)`);
console.log(`   Max DD: ${followSkip.maxDrawdown.toFixed(1)}%`);
console.log(`   Trades: ${followSkip.normalTrades}, WR: ${followSkip.normalWR.toFixed(1)}%\n`);

console.log('2️⃣  FOLLOW CROWD + COMBO HYBRID\n');
console.log('   Strategy: Bet WITH EMA + Hybrid during cooldown');
console.log(`   Final: ${followCombo.bankroll.toFixed(2)} BNB (+${((followCombo.bankroll-1)*100).toFixed(1)}%)`);
console.log(`   Max DD: ${followCombo.maxDrawdown.toFixed(1)}%`);
console.log(`   Normal: ${followCombo.normalTrades} trades, ${followCombo.normalWR.toFixed(1)}% WR`);
console.log(`   Hybrid: ${followCombo.hybridTrades} trades, ${followCombo.hybridWR.toFixed(1)}% WR`);
console.log(`   Overall: ${followCombo.totalTrades} trades, ${followCombo.overallWR.toFixed(1)}% WR\n`);

console.log('3️⃣  REVERSAL (AGAINST CROWD) + SKIP COOLDOWN\n');
console.log('   Strategy: Bet AGAINST EMA (when EMA=BULL, bet BEAR if payout ≥1.55x)');
console.log(`   Final: ${reversalSkip.bankroll.toFixed(2)} BNB (+${((reversalSkip.bankroll-1)*100).toFixed(1)}%)`);
console.log(`   Max DD: ${reversalSkip.maxDrawdown.toFixed(1)}%`);
console.log(`   Trades: ${reversalSkip.normalTrades}, WR: ${reversalSkip.normalWR.toFixed(1)}%\n`);

console.log('4️⃣  REVERSAL (AGAINST CROWD) + COMBO HYBRID\n');
console.log('   Strategy: Bet AGAINST EMA + Hybrid during cooldown');
console.log(`   Final: ${reversalCombo.bankroll.toFixed(2)} BNB (+${((reversalCombo.bankroll-1)*100).toFixed(1)}%)`);
console.log(`   Max DD: ${reversalCombo.maxDrawdown.toFixed(1)}%`);
console.log(`   Normal: ${reversalCombo.normalTrades} trades, ${reversalCombo.normalWR.toFixed(1)}% WR`);
console.log(`   Hybrid: ${reversalCombo.hybridTrades} trades, ${reversalCombo.hybridWR.toFixed(1)}% WR`);
console.log(`   Overall: ${reversalCombo.totalTrades} trades, ${reversalCombo.overallWR.toFixed(1)}% WR\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');

const results = [
  { name: 'FOLLOW + SKIP', bankroll: followSkip.bankroll, dd: followSkip.maxDrawdown, wr: followSkip.overallWR },
  { name: 'FOLLOW + COMBO', bankroll: followCombo.bankroll, dd: followCombo.maxDrawdown, wr: followCombo.overallWR },
  { name: 'REVERSAL + SKIP', bankroll: reversalSkip.bankroll, dd: reversalSkip.maxDrawdown, wr: reversalSkip.overallWR },
  { name: 'REVERSAL + COMBO', bankroll: reversalCombo.bankroll, dd: reversalCombo.maxDrawdown, wr: reversalCombo.overallWR }
];

results.sort((a, b) => b.bankroll - a.bankroll);

console.log('🏆 FINAL RANKING:\n');
results.forEach((r, i) => {
  const roi = ((r.bankroll - 1) * 100).toFixed(1);
  console.log(`${i + 1}. ${r.name.padEnd(18)}: ${r.bankroll.toFixed(2).padStart(8)} BNB (+${roi.padStart(7)}%) | DD: ${r.dd.toFixed(1).padStart(5)}% | WR: ${r.wr.toFixed(1)}%`);
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const winner = results[0];
console.log(`🎯 ABSOLUTE WINNER: ${winner.name}\n`);

if (winner.name.includes('FOLLOW')) {
  console.log('✅ FOLLOW CROWD (bet WITH EMA) is better!\n');
  console.log('Why: EMA captures momentum. When price > EMA, it tends to stay bullish.');
  console.log('     High payout threshold (1.55x) filters noise, takes advantage of trends.\n');
} else {
  console.log('✅ REVERSAL/CONTRARIAN (bet AGAINST EMA) is better!\n');
  console.log('Why: High payouts indicate overreaction. Fading the crowd when odds are good');
  console.log('     captures mean reversion opportunities in manipulated/volatile markets.\n');
}

console.log('FINAL SETTINGS:');
console.log(`  /realset 0.05 1.55 2.2 1.45`);
console.log(`  Base: ${winner.name.includes('FOLLOW') ? 'FOLLOW CROWD' : 'REVERSAL (CONTRARIAN)'}`);
console.log(`  Hybrid: ${winner.name.includes('COMBO') ? 'COMBO (Trend→MeanRev→EMA)' : 'SKIP cooldown'}`);
console.log(`\n  Expected: ${winner.bankroll.toFixed(2)} BNB, ${winner.dd.toFixed(1)}% DD, ${winner.wr.toFixed(1)}% WR`);
