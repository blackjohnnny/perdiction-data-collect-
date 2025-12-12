import { initDatabase } from './db-init.js';

const db = initDatabase();

function runStrategy(crowdMode, hybridMode) {
  // crowdMode: 'follow_crowd' or 'reverse_crowd'
  // 'follow_crowd' = bet LOWER payout (side crowd is betting on)
  // 'reverse_crowd' = bet HIGHER payout (side crowd is NOT betting on)

  const config = {
    EMA_GAP: 0.05,
    MAX_PAYOUT: 1.55,
    MOMENTUM_MULT: 2.2,
    RECOVERY_MULT: 1.5,
    CB_THRESHOLD: 3,
    CB_COOLDOWN_MIN: 45,
    CROWD_MODE: crowdMode,
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

      if (config.CROWD_MODE === 'follow_crowd') {
        // FOLLOW CROWD: Bet on the side with LOWER payout (more money)
        // Lower payout = crowd is betting there = follow crowd
        if (emaSignal === 'BULL') {
          // EMA bullish, check which side has lower payout
          if (bullPayout < bearPayout && bullPayout >= config.MAX_PAYOUT) {
            signal = 'BULL'; // Crowd betting bull (lower payout), follow them
          }
        } else if (emaSignal === 'BEAR') {
          if (bearPayout < bullPayout && bearPayout >= config.MAX_PAYOUT) {
            signal = 'BEAR'; // Crowd betting bear (lower payout), follow them
          }
        }
      } else {
        // REVERSE CROWD: Bet on the side with HIGHER payout (less money)
        // Higher payout = crowd is NOT betting there = fade crowd
        if (emaSignal === 'BULL') {
          // EMA bullish, check which side has higher payout
          if (bullPayout > bearPayout && bullPayout >= config.MAX_PAYOUT) {
            signal = 'BULL'; // Crowd betting bear (bull has high payout), fade them
          }
        } else if (emaSignal === 'BEAR') {
          if (bearPayout > bullPayout && bearPayout >= config.MAX_PAYOUT) {
            signal = 'BEAR'; // Crowd betting bull (bear has high payout), fade them
          }
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

console.log('🔬 CROWD MODES COMPARISON\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

console.log('📋 DEFINITIONS:\n');
console.log('FOLLOW CROWD MODE:');
console.log('  - Bet on side with LOWER payout (where crowd put more money)');
console.log('  - Example: Bull payout=1.3x, Bear payout=3.5x → Bet BULL (crowd is there)\n');
console.log('REVERSE CROWD MODE:');
console.log('  - Bet on side with HIGHER payout (where crowd put less money)');
console.log('  - Example: Bull payout=1.3x, Bear payout=3.5x → Bet BEAR (fade crowd)\n');
console.log('Both use EMA for direction filter (EMA=BULL → only consider bull bets, etc)\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const followSkip = runStrategy('follow_crowd', 'none');
const followCombo = runStrategy('follow_crowd', 'combo');
const reverseSkip = runStrategy('reverse_crowd', 'none');
const reverseCombo = runStrategy('reverse_crowd', 'combo');

console.log('1️⃣  FOLLOW CROWD + SKIP COOLDOWN\n');
console.log('   (Bet with crowd on lower payout side)');
console.log(`   Final: ${followSkip.bankroll.toFixed(2)} BNB (+${((followSkip.bankroll-1)*100).toFixed(1)}%)`);
console.log(`   Max DD: ${followSkip.maxDrawdown.toFixed(1)}%`);
console.log(`   Trades: ${followSkip.normalTrades}, WR: ${followSkip.normalWR.toFixed(1)}%`);
console.log(`   ${followSkip.busted ? '💀 BUSTED' : ''}\n`);

console.log('2️⃣  FOLLOW CROWD + COMBO HYBRID\n');
console.log('   (Bet with crowd + hybrid during cooldown)');
console.log(`   Final: ${followCombo.bankroll.toFixed(2)} BNB (+${((followCombo.bankroll-1)*100).toFixed(1)}%)`);
console.log(`   Max DD: ${followCombo.maxDrawdown.toFixed(1)}%`);
console.log(`   Normal: ${followCombo.normalTrades} trades, ${followCombo.normalWR.toFixed(1)}% WR`);
console.log(`   Hybrid: ${followCombo.hybridTrades} trades, ${followCombo.hybridWR.toFixed(1)}% WR`);
console.log(`   Overall: ${followCombo.totalTrades} trades, ${followCombo.overallWR.toFixed(1)}% WR`);
console.log(`   ${followCombo.busted ? '💀 BUSTED' : ''}\n`);

console.log('3️⃣  REVERSE CROWD + SKIP COOLDOWN\n');
console.log('   (Bet against crowd on higher payout side)');
console.log(`   Final: ${reverseSkip.bankroll.toFixed(2)} BNB (+${((reverseSkip.bankroll-1)*100).toFixed(1)}%)`);
console.log(`   Max DD: ${reverseSkip.maxDrawdown.toFixed(1)}%`);
console.log(`   Trades: ${reverseSkip.normalTrades}, WR: ${reverseSkip.normalWR.toFixed(1)}%`);
console.log(`   ${reverseSkip.busted ? '💀 BUSTED' : ''}\n`);

console.log('4️⃣  REVERSE CROWD + COMBO HYBRID\n');
console.log('   (Bet against crowd + hybrid during cooldown)');
console.log(`   Final: ${reverseCombo.bankroll.toFixed(2)} BNB (+${((reverseCombo.bankroll-1)*100).toFixed(1)}%)`);
console.log(`   Max DD: ${reverseCombo.maxDrawdown.toFixed(1)}%`);
console.log(`   Normal: ${reverseCombo.normalTrades} trades, ${reverseCombo.normalWR.toFixed(1)}% WR`);
console.log(`   Hybrid: ${reverseCombo.hybridTrades} trades, ${reverseCombo.hybridWR.toFixed(1)}% WR`);
console.log(`   Overall: ${reverseCombo.totalTrades} trades, ${reverseCombo.overallWR.toFixed(1)}% WR`);
console.log(`   ${reverseCombo.busted ? '💀 BUSTED' : ''}\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');

const results = [
  { name: 'FOLLOW CROWD + SKIP', bankroll: followSkip.bankroll, dd: followSkip.maxDrawdown, wr: followSkip.overallWR, busted: followSkip.busted },
  { name: 'FOLLOW CROWD + COMBO', bankroll: followCombo.bankroll, dd: followCombo.maxDrawdown, wr: followCombo.overallWR, busted: followCombo.busted },
  { name: 'REVERSE CROWD + SKIP', bankroll: reverseSkip.bankroll, dd: reverseSkip.maxDrawdown, wr: reverseSkip.overallWR, busted: reverseSkip.busted },
  { name: 'REVERSE CROWD + COMBO', bankroll: reverseCombo.bankroll, dd: reverseCombo.maxDrawdown, wr: reverseCombo.overallWR, busted: reverseCombo.busted }
];

results.sort((a, b) => b.bankroll - a.bankroll);

console.log('🏆 FINAL RANKING:\n');
results.forEach((r, i) => {
  const roi = ((r.bankroll - 1) * 100).toFixed(1);
  const bustMark = r.busted ? ' 💀 BUSTED' : '';
  console.log(`${i + 1}. ${r.name.padEnd(23)}: ${r.bankroll.toFixed(2).padStart(8)} BNB (+${roi.padStart(7)}%) | DD: ${r.dd.toFixed(1).padStart(5)}% | WR: ${r.wr.toFixed(1)}%${bustMark}`);
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const winner = results[0];
if (!winner.busted) {
  console.log(`🎯 WINNER: ${winner.name}\n`);
  console.log(`FINAL SETTINGS: /realset 0.05 1.55 2.2 1.45\n`);

  if (winner.name.includes('FOLLOW')) {
    console.log('Strategy: FOLLOW CROWD (bet with the herd on lower payout side)');
  } else {
    console.log('Strategy: REVERSE CROWD (fade the herd on higher payout side)');
  }

  if (winner.name.includes('COMBO')) {
    console.log('Hybrid: COMBO (Trend→MeanRev→EMA during cooldown)');
  } else {
    console.log('Hybrid: SKIP cooldown');
  }

  console.log(`\nExpected: ${winner.bankroll.toFixed(2)} BNB, ${winner.dd.toFixed(1)}% DD, ${winner.wr.toFixed(1)}% WR`);
}
