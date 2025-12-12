import { initDatabase } from './db-init.js';

const db = initDatabase();

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  MIN_EMA_GAP: 0.15,
  REVERSAL_COOLDOWN_MINUTES: 45, // Stay in reversal mode for 45 minutes
  MAX_BANKROLL: 50.0,
};

function runStrategy(strategyName, useReversalStrategy, reversalLosses = 3) {
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
        roi: '-100.0',
        winRate: 0,
        finalBankroll: '0.00',
        peak: peak.toFixed(2),
        maxDrawdown: '100.0',
        totalTrades: trades.length,
        busted: true,
        reversalModeTrades,
        reversalModeWins,
        reversalModeTriggered,
        reversalWR: '0.0',
        normalTrades: 0,
        normalWins: 0,
        normalWR: '0.0',
        wins: 0,
        losses: 0
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
      if (useReversalStrategy && consecutiveLosses >= reversalLosses) {
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
    : '0.0';

  const normalTrades = trades.filter(t => !t.isReversal);
  const normalWins = normalTrades.filter(t => t.won).length;
  const normalWR = normalTrades.length > 0
    ? (normalWins / normalTrades.length * 100).toFixed(1)
    : '0.0';

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

console.log('🔄 REVERSAL STRATEGY TEST: Testing Different Loss Thresholds\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('Strategy Explanation:');
console.log('  - Normal: Follow contrarian EMA strategy (EMA says BULL → bet BEAR)');
console.log('  - After N consecutive losses: REVERSE trades for 45 minutes');
console.log('    * If strategy says BULL → Actually bet BEAR (opposite = follow EMA)');
console.log('    * If strategy says BEAR → Actually bet BULL (opposite = follow EMA)');
console.log('  - After 45 mins: Return to normal contrarian strategy\n');
console.log('  Testing thresholds: 1, 2, 3, 4, 5 consecutive losses\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const strategies = [
  { name: 'ORIGINAL (No Reversal)', useReversal: false, losses: 0 },
  { name: 'After 1 Loss → reverse', useReversal: true, losses: 1 },
  { name: 'After 2 Losses → reverse', useReversal: true, losses: 2 },
  { name: 'After 3 Losses → reverse', useReversal: true, losses: 3 },
  { name: 'After 4 Losses → reverse', useReversal: true, losses: 4 },
  { name: 'After 5 Losses → reverse', useReversal: true, losses: 5 }
];

const results = [];

for (const strat of strategies) {
  console.log(`Testing: ${strat.name}...`);
  const result = runStrategy(strat.name, strat.useReversal, strat.losses);
  results.push(result);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('📊 RESULTS:\n');
console.log('Strategy                       │   ROI    │  WR   │ Final  │  DD   │ Trades │ Normal WR │ Rev Trades │ Rev WR │ Triggers');
console.log('───────────────────────────────┼──────────┼───────┼────────┼───────┼────────┼───────────┼────────────┼────────┼─────────');

for (const r of results) {
  const name = r.strategyName.padEnd(29);
  const roi = r.busted ? '  BUST  ' : (r.roi.startsWith('-') ? `${r.roi}%` : `+${r.roi}%`).padStart(8);
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

// Find best performer
const original = results[0];
const bestOverall = results.reduce((best, current) => {
  const bestROI = parseFloat(best.roi);
  const currentROI = parseFloat(current.roi);
  return currentROI > bestROI ? current : best;
}, results[0]);

console.log('🏆 BEST PERFORMER:\n');
console.log(`Strategy: ${bestOverall.strategyName}`);
console.log(`  ROI: ${bestOverall.roi.startsWith('-') ? '' : '+'}${bestOverall.roi}%`);
console.log(`  Final: ${bestOverall.finalBankroll} BNB`);
console.log(`  Win Rate: ${bestOverall.winRate}% (${bestOverall.wins}W / ${bestOverall.losses}L)`);
console.log(`  Max DD: ${bestOverall.maxDrawdown}%`);

if (bestOverall.reversalModeTrades > 0) {
  console.log(`  ├─ Normal Trades: ${bestOverall.normalTrades} (WR: ${bestOverall.normalWR}%)`);
  console.log(`  ├─ Reversal Trades: ${bestOverall.reversalModeTrades} (WR: ${bestOverall.reversalWR}%)`);
  console.log(`  └─ Times Triggered: ${bestOverall.reversalModeTriggered}`);
}

console.log('\n📊 COMPARISON vs ORIGINAL:\n');

for (let i = 1; i < results.length; i++) {
  const r = results[i];
  const roiDiff = parseFloat(r.roi) - parseFloat(original.roi);
  const finalDiff = parseFloat(r.finalBankroll) - parseFloat(original.finalBankroll);

  console.log(`${r.strategyName}:`);
  console.log(`  ROI Difference: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(1)}%`);
  console.log(`  Final Difference: ${finalDiff >= 0 ? '+' : ''}${finalDiff.toFixed(2)} BNB`);

  if (r.reversalModeTrades > 0) {
    const revWR = parseFloat(r.reversalWR);
    const normalWR = parseFloat(r.normalWR);
    console.log(`  Reversal WR: ${r.reversalWR}% (${revWR > normalWR ? 'better' : 'worse'} than normal ${normalWR}%)`);
    console.log(`  Triggers: ${r.reversalModeTriggered} times (${r.reversalModeTrades} total reversal trades)`);
  }
  console.log('');
}

console.log('🎯 VERDICT:\n');
if (bestOverall === original) {
  console.log(`✅ ORIGINAL STRATEGY WINS - No reversal threshold beats it!`);
  console.log(`   All reversal strategies decrease performance significantly`);
} else {
  const roiDiff = parseFloat(bestOverall.roi) - parseFloat(original.roi);
  console.log(`✅ REVERSAL STRATEGY WINS! (${bestOverall.strategyName})`);
  console.log(`   Improves ROI by ${roiDiff.toFixed(1)}%`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════');
