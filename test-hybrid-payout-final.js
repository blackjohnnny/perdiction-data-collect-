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

function runStrategy(hybridMinPayout) {
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

      if (hybridSignal) {
        if (hybridSignal === 'BULL' && bullPayout >= hybridMinPayout) {
          signal = 'BULL';
          isCooldownTrade = true;
        } else if (hybridSignal === 'BEAR' && bearPayout >= hybridMinPayout) {
          signal = 'BEAR';
          isCooldownTrade = true;
        } else {
          hybridSkippedPayout++;
        }
      }
    } else {
      // Normal contrarian logic
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
        hybridMinPayout,
        roi: -100,
        winRate: 0,
        finalBankroll: 0,
        peak: peak.toFixed(2),
        maxDrawdown: 100,
        totalTrades: trades.length,
        busted: true,
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

  const normalTrades = trades.filter(t => !t.isCooldown);
  const normalWins = normalTrades.filter(t => t.won).length;
  const normalWR = normalTrades.length > 0 ? (normalWins / normalTrades.length * 100).toFixed(1) : 0;

  const cooldownTrades = trades.filter(t => t.isCooldown);
  const cooldownWins = cooldownTrades.filter(t => t.won).length;
  const cooldownWR = cooldownTrades.length > 0 ? (cooldownWins / cooldownTrades.length * 100).toFixed(1) : 0;

  const avgCooldownPayout = cooldownTrades.length > 0
    ? (cooldownTrades.reduce((sum, t) => sum + t.payout, 0) / cooldownTrades.length).toFixed(3)
    : 0;

  // Calculate total profit from cooldown trades
  const cooldownProfit = cooldownTrades.reduce((sum, t, idx) => {
    // Simplified: just track if they contribute positively
    return sum + (t.won ? 1 : -1);
  }, 0);

  const roi = ((bankroll - 1.0) * 100).toFixed(1);

  return {
    hybridMinPayout: hybridMinPayout.toFixed(2),
    roi,
    winRate,
    finalBankroll: bankroll.toFixed(2),
    peak: peak.toFixed(2),
    maxDrawdown: maxDrawdown.toFixed(1),
    totalTrades: trades.length,
    wins,
    losses,
    normalTrades: normalTrades.length,
    normalWins,
    normalWR,
    cooldownTrades: cooldownTrades.length,
    cooldownWins,
    cooldownWR,
    avgCooldownPayout,
    hybridSkippedPayout,
    busted: false,
  };
}

console.log('🎯 FINAL TEST: Finding Optimal Hybrid Payout Threshold\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const thresholds = [1.35, 1.40, 1.45, 1.50, 1.55, 1.60, 1.65, 1.70];
const results = [];

for (const threshold of thresholds) {
  console.log(`Testing: ${threshold.toFixed(2)}x...`);
  const result = runStrategy(threshold);
  results.push(result);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('📊 COMPLETE RESULTS:\n');
console.log('Threshold │   ROI    │  WR   │ Final  │  DD   │ Total │ CD Trades │ CD WR │ Avg CD $ │ Filtered');
console.log('──────────┼──────────┼───────┼────────┼───────┼───────┼───────────┼───────┼──────────┼─────────');

for (const r of results) {
  const thresh = r.hybridMinPayout.padStart(5);
  const roi = `+${r.roi}%`.padStart(8);
  const wr = `${r.winRate}%`.padStart(5);
  const final = r.finalBankroll.padStart(6);
  const dd = `${r.maxDrawdown}%`.padStart(5);
  const total = r.totalTrades.toString().padStart(5);
  const cd = r.cooldownTrades.toString().padStart(9);
  const cdWR = r.cooldownTrades > 0 ? `${r.cooldownWR}%`.padStart(5) : '  N/A';
  const avgPayout = r.avgCooldownPayout.toString().padStart(8);
  const filtered = r.hybridSkippedPayout.toString().padStart(8);

  console.log(`${thresh}x   │ ${roi} │ ${wr} │ ${final} │ ${dd} │ ${total} │ ${cd} │ ${cdWR} │ ${avgPayout} │ ${filtered}`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

// Find best by ROI
const bestROI = results.reduce((a, b) => parseFloat(a.roi) > parseFloat(b.roi) ? a : b);

// Find best by risk-adjusted (ROI / MaxDD)
const bestRiskAdjusted = results.reduce((a, b) => {
  const aScore = parseFloat(a.roi) / parseFloat(a.maxDrawdown);
  const bScore = parseFloat(b.roi) / parseFloat(b.maxDrawdown);
  return aScore > bScore ? a : b;
});

console.log('🏆 BEST BY RAW ROI:\n');
console.log(`Threshold: ${bestROI.hybridMinPayout}x`);
console.log(`  ROI: +${bestROI.roi}%`);
console.log(`  Final: ${bestROI.finalBankroll} BNB`);
console.log(`  Win Rate: ${bestROI.winRate}%`);
console.log(`  Max DD: ${bestROI.maxDrawdown}%`);
console.log(`  Cooldown: ${bestROI.cooldownTrades} trades @ ${bestROI.cooldownWR}% WR`);
console.log(`  Avg Cooldown Payout: ${bestROI.avgCooldownPayout}x`);
console.log(`  Filtered: ${bestROI.hybridSkippedPayout} trades\n`);

console.log('🛡️ BEST RISK-ADJUSTED (ROI/DD):\n');
console.log(`Threshold: ${bestRiskAdjusted.hybridMinPayout}x`);
console.log(`  ROI: +${bestRiskAdjusted.roi}%`);
console.log(`  Final: ${bestRiskAdjusted.finalBankroll} BNB`);
console.log(`  Win Rate: ${bestRiskAdjusted.winRate}%`);
console.log(`  Max DD: ${bestRiskAdjusted.maxDrawdown}%`);
console.log(`  Risk Score: ${(parseFloat(bestRiskAdjusted.roi) / parseFloat(bestRiskAdjusted.maxDrawdown)).toFixed(2)}`);
console.log(`  Cooldown: ${bestRiskAdjusted.cooldownTrades} trades @ ${bestRiskAdjusted.cooldownWR}% WR`);
console.log(`  Avg Cooldown Payout: ${bestRiskAdjusted.avgCooldownPayout}x\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');

// Analyze the sweet spot
const top3 = results.sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi)).slice(0, 3);

console.log('📈 TOP 3 PERFORMERS:\n');
top3.forEach((r, i) => {
  console.log(`${i + 1}. ${r.hybridMinPayout}x → ${r.finalBankroll} BNB (ROI: +${r.roi}%, DD: ${r.maxDrawdown}%)`);
  console.log(`   CD: ${r.cooldownTrades} trades @ ${r.cooldownWR}% WR, avg ${r.avgCooldownPayout}x payout\n`);
});

console.log('════════════════════════════════════════════════════════════════════════════\n');

console.log('🎯 FINAL RECOMMENDATION:\n');

// Logic: Pick the one with best ROI that also has reasonable trade count
const reasonable = results.filter(r => r.cooldownTrades >= 50); // At least 50 cooldown trades for statistical significance
const recommended = reasonable.reduce((a, b) => parseFloat(a.roi) > parseFloat(b.roi) ? a : b);

console.log(`✅ USE HYBRID_MIN_PAYOUT = ${recommended.hybridMinPayout}x\n`);
console.log(`Reasoning:`);
console.log(`  - Highest ROI among statistically significant thresholds (≥50 cooldown trades)`);
console.log(`  - Final: ${recommended.finalBankroll} BNB (vs 1 BNB start)`);
console.log(`  - Cooldown trades: ${recommended.cooldownTrades} @ ${recommended.cooldownWR}% WR`);
console.log(`  - Avg payout: ${recommended.avgCooldownPayout}x (filters low-value traps)`);
console.log(`  - Max drawdown: ${recommended.maxDrawdown}%`);
console.log(`  - Filters out: ${recommended.hybridSkippedPayout} low-payout manipulated trades`);

console.log('\n════════════════════════════════════════════════════════════════════════════');
