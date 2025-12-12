import { initDatabase } from './db-init.js';

const db = initDatabase();

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  MIN_EMA_GAP: 0.15,
  CIRCUIT_BREAKER_LOSSES: 3,
  COOLDOWN_MINUTES: 45,
  MAX_BANKROLL: 50.0,
};

function calculateBollingerBands(rounds, currentIndex, period = 8, stdDevMultiplier = 2.0) {
  const startIdx = Math.max(0, currentIndex - period + 1);
  const recentRounds = rounds.slice(startIdx, currentIndex + 1);
  if (recentRounds.length < period) return null;

  const prices = recentRounds.map(r => r.close_price);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / prices.length;
  const stdDev = Math.sqrt(variance);

  const upper = avg + (stdDevMultiplier * stdDev);
  const lower = avg - (stdDevMultiplier * stdDev);
  const currentPrice = recentRounds[recentRounds.length - 1].close_price;
  const position = ((currentPrice - lower) / (upper - lower)) * 100;

  return { upper, lower, avg, position, currentPrice };
}

function calculateMomentum(rounds, currentIndex, period = 10) {
  const startIdx = Math.max(0, currentIndex - period);
  const recentRounds = rounds.slice(startIdx, currentIndex + 1);
  if (recentRounds.length < 2) return null;

  const oldPrice = recentRounds[0].close_price;
  const currentPrice = recentRounds[recentRounds.length - 1].close_price;
  const momentum = ((currentPrice - oldPrice) / oldPrice) * 100;
  return momentum;
}

function runStrategy(strategyName, hybridCheckPayout, hybridMinPayout = 1.0) {
  const rounds = db.prepare(`
    SELECT epoch, lock_timestamp, ema_signal, ema_gap,
           t20s_bull_wei, t20s_bear_wei, winner, close_price
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
  let cooldownUntilTimestamp = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;
  let hybridSkippedPayout = 0;

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

    const inCooldown = r.lock_timestamp < cooldownUntilTimestamp;

    let signal = null;
    let isCooldownTrade = false;

    if (inCooldown) {
      // Hybrid mean reversion
      const bb = calculateBollingerBands(rounds, i, 8);
      const momentum = calculateMomentum(rounds, i, 10);

      // Generate signal based on BB/Momentum
      let hybridSignal = null;

      if (bb && bb.position < 35) {
        hybridSignal = 'BULL';
      } else if (bb && bb.position > 65) {
        hybridSignal = 'BEAR';
      } else if (momentum !== null && momentum < -0.5) {
        hybridSignal = 'BULL';
      } else if (momentum !== null && momentum > 0.5) {
        hybridSignal = 'BEAR';
      }

      // If hybrid signal exists, check payout (if enabled)
      if (hybridSignal) {
        if (hybridCheckPayout) {
          // Check payout threshold
          if (hybridSignal === 'BULL' && bullPayout >= hybridMinPayout) {
            signal = 'BULL';
            isCooldownTrade = true;
          } else if (hybridSignal === 'BEAR' && bearPayout >= hybridMinPayout) {
            signal = 'BEAR';
            isCooldownTrade = true;
          } else {
            // Signal exists but payout too low
            hybridSkippedPayout++;
          }
        } else {
          // No payout check - take all signals
          signal = hybridSignal;
          isCooldownTrade = true;
        }
      }
    } else {
      // Normal contrarian logic (ALWAYS check payout)
      if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BEAR';
      } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BULL';
      }
    }

    if (!signal) continue;

    effectiveBankroll = Math.min(bankroll, BASE_CONFIG.MAX_BANKROLL);

    let positionMultiplier = 1.0;

    if (!isCooldownTrade && emaGap >= BASE_CONFIG.MIN_EMA_GAP) {
      positionMultiplier *= BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      positionMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betAmount = effectiveBankroll * BASE_CONFIG.BASE_POSITION_SIZE * positionMultiplier;

    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = (signal === 'BULL' && winner === 'bull') || (signal === 'BEAR' && winner === 'bear');
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
        hybridSkippedPayout
      };
    }

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    trades.push({
      won,
      isCooldown: isCooldownTrade,
      payout: actualPayout
    });

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    if (won) {
      consecutiveLosses = 0;
    } else {
      consecutiveLosses++;
      if (consecutiveLosses >= BASE_CONFIG.CIRCUIT_BREAKER_LOSSES) {
        cooldownUntilTimestamp = r.lock_timestamp + (BASE_CONFIG.COOLDOWN_MINUTES * 60);
        consecutiveLosses = 0;
      }
    }
  }

  const wins = trades.filter(t => t.won).length;
  const losses = trades.filter(t => !t.won).length;
  const winRate = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : 0;

  const cooldownTrades = trades.filter(t => t.isCooldown);
  const cooldownWins = cooldownTrades.filter(t => t.won).length;
  const cooldownLosses = cooldownTrades.filter(t => !t.won).length;
  const cooldownWR = cooldownTrades.length > 0 ? (cooldownWins / cooldownTrades.length * 100).toFixed(1) : 0;

  const avgCooldownPayout = cooldownTrades.length > 0
    ? (cooldownTrades.reduce((sum, t) => sum + t.payout, 0) / cooldownTrades.length).toFixed(3)
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
    cooldownTrades: cooldownTrades.length,
    cooldownWins,
    cooldownLosses,
    cooldownWR,
    avgCooldownPayout,
    busted: false,
    hybridSkippedPayout
  };
}

console.log('🔬 HYBRID PAYOUT FILTER TEST: Does it help or hurt?\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const strategies = [
  { name: 'Hybrid: NO payout filter', checkPayout: false, minPayout: 1.0 },
  { name: 'Hybrid: Payout ≥ 1.30x', checkPayout: true, minPayout: 1.30 },
  { name: 'Hybrid: Payout ≥ 1.40x', checkPayout: true, minPayout: 1.40 },
  { name: 'Hybrid: Payout ≥ 1.45x', checkPayout: true, minPayout: 1.45 },
  { name: 'Hybrid: Payout ≥ 1.50x', checkPayout: true, minPayout: 1.50 },
  { name: 'Hybrid: Payout ≥ 1.60x', checkPayout: true, minPayout: 1.60 },
];

const results = [];

for (const strat of strategies) {
  console.log(`Testing: ${strat.name}...`);
  const result = runStrategy(strat.name, strat.checkPayout, strat.minPayout);
  results.push(result);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('📊 RESULTS:\n');
console.log('Strategy                      │   ROI    │  WR   │ Final  │  DD   │ CD Trades │ CD WR │ Avg Payout │ Skipped');
console.log('──────────────────────────────┼──────────┼───────┼────────┼───────┼───────────┼───────┼────────────┼────────');

for (const r of results) {
  const name = r.strategyName.padEnd(28);
  const roi = r.busted ? '  BUST  ' : `+${r.roi}%`.padStart(8);
  const wr = `${r.winRate}%`.padStart(5);
  const final = r.finalBankroll.padStart(6);
  const dd = `${r.maxDrawdown}%`.padStart(5);
  const cdTrades = r.cooldownTrades.toString().padStart(9);
  const cdWR = r.cooldownTrades > 0 ? `${r.cooldownWR}%`.padStart(5) : '  N/A';
  const avgPayout = r.avgCooldownPayout.toString().padStart(10);
  const skipped = r.hybridSkippedPayout.toString().padStart(7);

  console.log(`${name} │ ${roi} │ ${wr} │ ${final} │ ${dd} │ ${cdTrades} │ ${cdWR} │ ${avgPayout} │ ${skipped}`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

// Find best
const best = results.reduce((a, b) => parseFloat(a.roi) > parseFloat(b.roi) ? a : b);

console.log('🏆 BEST PERFORMER:\n');
console.log(`${best.strategyName}`);
console.log(`  ROI: +${best.roi}%`);
console.log(`  Win Rate: ${best.winRate}% (${best.wins}W / ${best.losses}L)`);
console.log(`  Final: ${best.finalBankroll} BNB`);
console.log(`  Max DD: ${best.maxDrawdown}%`);
console.log(`  Cooldown: ${best.cooldownTrades} trades, ${best.cooldownWR}% WR`);
console.log(`  Avg Cooldown Payout: ${best.avgCooldownPayout}x`);
console.log(`  Skipped due to payout: ${best.hybridSkippedPayout} trades`);

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

// Compare no filter vs best filter
const noFilter = results[0];
const bestFilter = results.slice(1).reduce((a, b) => parseFloat(a.roi) > parseFloat(b.roi) ? a : b);

console.log('📈 COMPARISON:\n');
console.log(`NO Payout Filter:`);
console.log(`  ROI: +${noFilter.roi}%`);
console.log(`  Final: ${noFilter.finalBankroll} BNB`);
console.log(`  Cooldown: ${noFilter.cooldownTrades} trades (${noFilter.cooldownWR}% WR)`);
console.log(`  Avg Payout: ${noFilter.avgCooldownPayout}x\n`);

console.log(`BEST Payout Filter (${bestFilter.strategyName}):`);
console.log(`  ROI: +${bestFilter.roi}%`);
console.log(`  Final: ${bestFilter.finalBankroll} BNB`);
console.log(`  Cooldown: ${bestFilter.cooldownTrades} trades (${bestFilter.cooldownWR}% WR)`);
console.log(`  Avg Payout: ${bestFilter.avgCooldownPayout}x`);
console.log(`  Filtered: ${bestFilter.hybridSkippedPayout} trades\n`);

const roiDiff = parseFloat(noFilter.roi) - parseFloat(bestFilter.roi);
const finalDiff = parseFloat(noFilter.finalBankroll) - parseFloat(bestFilter.finalBankroll);

console.log(`Difference (No Filter vs Best Filter):`);
console.log(`  ROI: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(1)}%`);
console.log(`  Final: ${finalDiff >= 0 ? '+' : ''}${finalDiff.toFixed(2)} BNB`);
console.log(`  Trades: +${noFilter.cooldownTrades - bestFilter.cooldownTrades} more trades`);

console.log('\n🎯 RECOMMENDATION:\n');
if (roiDiff > 50) {
  console.log(`✅ REMOVE PAYOUT FILTER - Improves ROI by ${roiDiff.toFixed(1)}% (+${finalDiff.toFixed(2)} BNB)`);
  console.log(`   Payout filtering removes profitable trades unnecessarily`);
} else if (roiDiff < -50) {
  console.log(`✅ KEEP PAYOUT FILTER - Improves ROI by ${Math.abs(roiDiff).toFixed(1)}% (+${Math.abs(finalDiff).toFixed(2)} BNB)`);
  console.log(`   Use ${bestFilter.strategyName} setting`);
} else {
  console.log(`⚠️ MARGINAL DIFFERENCE - Only ${Math.abs(roiDiff).toFixed(1)}% difference`);
  console.log(`   Payout filter doesn't significantly help or hurt`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════');
