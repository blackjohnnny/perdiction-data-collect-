import { initDatabase } from './db-init.js';

const db = initDatabase();

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  MIN_EMA_GAP: 0.15,
  REVERSAL_LOSSES: 3,           // Trigger reversal after 3 consecutive losses
  REVERSAL_COOLDOWN_MINUTES: 45, // Stay in reversal mode for 45 minutes
  MAX_BANKROLL: 50.0,
};

function runStrategy(strategyName, useReversalStrategy) {
  const rounds = db.prepare(`
    SELECT epoch, lock_timestamp, ema_signal, ema_gap,
           t20s_bull_wei, t20s_bear_wei, winner, close_price,
           winner_payout_multiple
    FROM rounds
    WHERE t20s_bull_wei IS NOT NULL
      AND t20s_bear_wei IS NOT NULL
      AND winner IS NOT NULL
      AND ema_signal IS NOT NULL
    ORDER BY epoch ASC
  `).all();

  let bankroll = 1.0;
  let effectiveBankroll = 1.0;
  let trades = [];
  let consecutiveLosses = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;

  // Reversal mode tracking
  let reversalModeUntilTimestamp = 0;
  let reversalModeTrades = 0;
  let reversalModeWins = 0;
  let reversalModeTriggered = 0;

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

    // Check if we're in reversal mode
    const inReversalMode = useReversalStrategy && r.lock_timestamp < reversalModeUntilTimestamp;

    // Generate base signal (contrarian EMA strategy)
    let baseSignal = null;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      baseSignal = 'BEAR';  // EMA says BULL, we contrarian bet BEAR
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      baseSignal = 'BULL';  // EMA says BEAR, we contrarian bet BULL
    }

    if (!baseSignal) continue;

    // Apply reversal logic if in reversal mode
    let actualSignal = baseSignal;
    let isReversalTrade = false;

    if (inReversalMode) {
      // REVERSE the signal: if strategy says BULL, we go BEAR (and vice versa)
      actualSignal = baseSignal === 'BULL' ? 'BEAR' : 'BULL';
      isReversalTrade = true;

      // Note: We DO NOT check payout for reversed signal
      // We take the same trades, just in opposite direction
    }

    effectiveBankroll = Math.min(bankroll, BASE_CONFIG.MAX_BANKROLL);

    let positionMultiplier = 1.0;

    if (emaGap >= BASE_CONFIG.MIN_EMA_GAP) {
      positionMultiplier *= BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      positionMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betAmount = effectiveBankroll * BASE_CONFIG.BASE_POSITION_SIZE * positionMultiplier;

    const actualPayout = actualSignal === 'BULL' ? bullPayout : bearPayout;
    const won = (actualSignal === 'BULL' && winner === 'bull') || (actualSignal === 'BEAR' && winner === 'bear');
    const profit = won ? betAmount * (actualPayout - 1) : -betAmount;

    bankroll += profit;

    if (bankroll <= 0) {
      return {
        strategyName,
        roi: -100,
        winRate: 0,
        finalBankroll: 0,
        peak: peak.toFixed(2),
        maxDrawdown: 100,
        totalTrades: trades.length,
        busted: true,
        reversalModeTrades,
        reversalModeWins,
        reversalModeTriggered
      };
    }

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    trades.push({
      won,
      isReversal: isReversalTrade,
      payout: actualPayout,
      signal: actualSignal,
      baseSignal: baseSignal
    });

    if (isReversalTrade) {
      reversalModeTrades++;
      if (won) reversalModeWins++;
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    if (won) {
      consecutiveLosses = 0;
    } else {
      consecutiveLosses++;

      // Trigger reversal mode after N consecutive losses
      if (useReversalStrategy && consecutiveLosses >= BASE_CONFIG.REVERSAL_LOSSES) {
        reversalModeUntilTimestamp = r.lock_timestamp + (BASE_CONFIG.REVERSAL_COOLDOWN_MINUTES * 60);
        reversalModeTriggered++;
        consecutiveLosses = 0; // Reset counter
      }
    }
  }

  const wins = trades.filter(t => t.won).length;
  const losses = trades.filter(t => !t.won).length;
  const winRate = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : 0;

  const reversalWR = reversalModeTrades > 0
    ? (reversalModeWins / reversalModeTrades * 100).toFixed(1)
    : 0;

  const normalTrades = trades.filter(t => !t.isReversal);
  const normalWins = normalTrades.filter(t => t.won).length;
  const normalWR = normalTrades.length > 0
    ? (normalWins / normalTrades.length * 100).toFixed(1)
    : 0;

  const roi = ((bankroll - 1.0) * 100).toFixed(1);

  return {
    strategyName,
    roi,
    winRate,
    finalBankroll: bankroll.toFixed(2),
    peak: peak.toFixed(2),
    maxDrawdown: maxDrawdown.toFixed(1),
    totalTrades: trades.length,
    wins,
    losses,
    reversalModeTrades,
    reversalModeWins,
    reversalModeTriggered,
    reversalWR,
    normalTrades: normalTrades.length,
    normalWins,
    normalWR,
    busted: false
  };
}

console.log('🔄 REVERSAL STRATEGY TEST: After 3 Losses, Reverse for 45 Minutes\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('Strategy Explanation:');
console.log('  - Normal: Follow contrarian EMA strategy (EMA says BULL → bet BEAR)');
console.log('  - After 3 consecutive losses: REVERSE trades for 45 minutes');
console.log('    * If strategy says BULL → Actually bet BEAR (opposite of opposite = follow EMA)');
console.log('    * If strategy says BEAR → Actually bet BULL (opposite of opposite = follow EMA)');
console.log('  - After 45 mins: Return to normal contrarian strategy\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const strategies = [
  { name: 'ORIGINAL (No Reversal)', useReversal: false },
  { name: 'WITH REVERSAL (3 losses → reverse 45 mins)', useReversal: true }
];

const results = [];

for (const strat of strategies) {
  console.log(`Testing: ${strat.name}...`);
  const result = runStrategy(strat.name, strat.useReversal);
  results.push(result);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('📊 RESULTS:\n');
console.log('Strategy                                          │   ROI    │  WR   │ Final  │  DD   │ Trades │ Normal WR │ Rev Trades │ Rev WR │ Triggers');
console.log('──────────────────────────────────────────────────┼──────────┼───────┼────────┼───────┼────────┼───────────┼────────────┼────────┼─────────');

for (const r of results) {
  const name = r.strategyName.padEnd(48);
  const roi = r.busted ? '  BUST  ' : `+${r.roi}%`.padStart(8);
  const wr = `${r.winRate}%`.padStart(5);
  const final = r.finalBankroll.padStart(6);
  const dd = `${r.maxDrawdown}%`.padStart(5);
  const trades = r.totalTrades.toString().padStart(6);
  const normalWR = r.normalWR ? `${r.normalWR}%`.padStart(9) : '    N/A  ';
  const revTrades = r.reversalModeTrades.toString().padStart(10);
  const revWR = r.reversalModeTrades > 0 ? `${r.reversalWR}%`.padStart(6) : '  N/A ';
  const triggers = r.reversalModeTriggered.toString().padStart(8);

  console.log(`${name} │ ${roi} │ ${wr} │ ${final} │ ${dd} │ ${trades} │ ${normalWR} │ ${revTrades} │ ${revWR} │ ${triggers}`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

// Compare
const original = results[0];
const reversal = results[1];

console.log('📈 DETAILED COMPARISON:\n');
console.log(`ORIGINAL (No Reversal):`);
console.log(`  ROI: +${original.roi}%`);
console.log(`  Final: ${original.finalBankroll} BNB`);
console.log(`  Win Rate: ${original.winRate}% (${original.wins}W / ${original.losses}L)`);
console.log(`  Max DD: ${original.maxDrawdown}%`);
console.log(`  Trades: ${original.totalTrades}\n`);

console.log(`WITH REVERSAL (After 3 losses → reverse 45 mins):`);
console.log(`  ROI: +${reversal.roi}%`);
console.log(`  Final: ${reversal.finalBankroll} BNB`);
console.log(`  Win Rate: ${reversal.winRate}% (${reversal.wins}W / ${reversal.losses}L)`);
console.log(`  Max DD: ${reversal.maxDrawdown}%`);
console.log(`  Trades: ${reversal.totalTrades}`);
console.log(`  ├─ Normal Trades: ${reversal.normalTrades} (WR: ${reversal.normalWR}%)`);
console.log(`  ├─ Reversal Trades: ${reversal.reversalModeTrades} (WR: ${reversal.reversalWR}%)`);
console.log(`  └─ Times Triggered: ${reversal.reversalModeTriggered}\n`);

const roiDiff = parseFloat(reversal.roi) - parseFloat(original.roi);
const finalDiff = parseFloat(reversal.finalBankroll) - parseFloat(original.finalBankroll);

console.log(`Difference (Reversal vs Original):`);
console.log(`  ROI: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(1)}%`);
console.log(`  Final: ${finalDiff >= 0 ? '+' : ''}${finalDiff.toFixed(2)} BNB`);

console.log('\n🎯 VERDICT:\n');
if (roiDiff > 100) {
  console.log(`✅ REVERSAL STRATEGY WINS! Improves ROI by ${roiDiff.toFixed(1)}% (+${finalDiff.toFixed(2)} BNB)`);
  console.log(`   Reversing after 3 losses helps recover from losing streaks`);
} else if (roiDiff < -100) {
  console.log(`❌ REVERSAL STRATEGY LOSES! Decreases ROI by ${Math.abs(roiDiff).toFixed(1)}% (${finalDiff.toFixed(2)} BNB)`);
  console.log(`   Stick with original strategy - reversing makes it worse`);
} else {
  console.log(`⚠️ MARGINAL DIFFERENCE - Only ${Math.abs(roiDiff).toFixed(1)}% difference`);
  console.log(`   Reversal strategy doesn't significantly help or hurt`);
}

console.log('\n💡 INSIGHTS:\n');
if (reversal.reversalModeTrades > 0) {
  const revWR = parseFloat(reversal.reversalWR);
  const normalWR = parseFloat(reversal.normalWR);

  console.log(`  Reversal Mode Win Rate: ${reversal.reversalWR}%`);
  console.log(`  Normal Mode Win Rate: ${reversal.normalWR}%`);
  console.log(`  Reversal Mode Performance: ${revWR > normalWR ? '✅ BETTER' : '❌ WORSE'} than normal`);
  console.log(`  Times Circuit Breaker Triggered: ${reversal.reversalModeTriggered}`);
  console.log(`  Average Reversal Trades per Trigger: ${(reversal.reversalModeTrades / reversal.reversalModeTriggered).toFixed(1)}`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════');
