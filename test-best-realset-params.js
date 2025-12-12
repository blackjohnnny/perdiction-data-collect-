import { initDatabase } from './db-init.js';

const db = initDatabase();

function calculateBollingerBands(prices, period = 8, stdDevMultiplier = 2.0) {
  if (prices.length < period) return null;

  const recentPrices = prices.slice(-period);
  const avg = recentPrices.reduce((a, b) => a + b, 0) / period;
  const variance = recentPrices.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = avg + (stdDevMultiplier * stdDev);
  const lower = avg - (stdDevMultiplier * stdDev);
  const currentPrice = prices[prices.length - 1];
  const position = ((currentPrice - lower) / (upper - lower)) * 100;

  return { upper, lower, avg, position, currentPrice };
}

function calculateMomentum(prices, period = 10) {
  if (prices.length < period + 1) return null;

  const oldPrice = prices[prices.length - period - 1];
  const currentPrice = prices[prices.length - 1];
  const momentum = ((currentPrice - oldPrice) / oldPrice) * 100;
  return momentum;
}

function runStrategy(emaGap, maxPayout, momentumMult, reversalMult, minPay, useHybrid = false, hybridMinPayout = 1.65) {
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
  let effectiveBankroll = 1.0;
  const MAX_BANKROLL = 50.0;
  let trades = [];
  let consecutiveLosses = 0;
  let cooldownUntilTimestamp = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;

  const allPrices = rounds.map(r => parseFloat(r.close_price));

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const currentEmaGap = parseFloat(r.ema_gap) || 0;

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

    if (inCooldown && useHybrid) {
      // Hybrid mean reversion
      const pricesForCalc = allPrices.slice(Math.max(0, i - 20), i + 1);
      const bb = calculateBollingerBands(pricesForCalc, 8);
      const momentum = calculateMomentum(pricesForCalc, 10);

      if (bb && bb.position < 35 && bullPayout >= hybridMinPayout) {
        signal = 'BULL';
        isCooldownTrade = true;
      } else if (bb && bb.position > 65 && bearPayout >= hybridMinPayout) {
        signal = 'BEAR';
        isCooldownTrade = true;
      } else if (momentum !== null && momentum < -0.5 && bullPayout >= hybridMinPayout) {
        signal = 'BULL';
        isCooldownTrade = true;
      } else if (momentum !== null && momentum > 0.5 && bearPayout >= hybridMinPayout) {
        signal = 'BEAR';
        isCooldownTrade = true;
      }
    } else if (!inCooldown) {
      // Normal REVERSE_CROWD (contrarian)
      if (emaSignal === 'BULL' && bearPayout >= maxPayout) {
        signal = 'BEAR';
      } else if (emaSignal === 'BEAR' && bullPayout >= maxPayout) {
        signal = 'BULL';
      }
    }

    if (!signal) continue;

    effectiveBankroll = Math.min(bankroll, MAX_BANKROLL);

    let positionMultiplier = 1.0;

    // Momentum multiplier (only for normal trades)
    if (!isCooldownTrade && currentEmaGap >= emaGap) {
      positionMultiplier *= momentumMult;
    }

    // Recovery multiplier (after 2 consecutive losses)
    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      positionMultiplier *= reversalMult;
    }

    const betAmount = effectiveBankroll * 0.045 * positionMultiplier;

    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = (signal === 'BULL' && winner === 'bull') || (signal === 'BEAR' && winner === 'bear');
    const profit = won ? betAmount * (actualPayout - 1) : -betAmount;

    bankroll += profit;

    if (bankroll <= 0) {
      return {
        roi: -100,
        finalBankroll: 0,
        busted: true,
      };
    }

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    trades.push({ won, isCooldown: isCooldownTrade });

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    if (won) {
      consecutiveLosses = 0;
    } else {
      consecutiveLosses++;
      if (consecutiveLosses >= 3) {
        cooldownUntilTimestamp = r.lock_timestamp + (45 * 60);
        consecutiveLosses = 0;
      }
    }
  }

  const wins = trades.filter(t => t.won).length;
  const winRate = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : 0;

  const cooldownTrades = trades.filter(t => t.isCooldown);
  const cooldownWins = cooldownTrades.filter(t => t.won).length;
  const cooldownWR = cooldownTrades.length > 0 ? (cooldownWins / cooldownTrades.length * 100).toFixed(1) : 0;

  const roi = ((bankroll - 1.0) * 100).toFixed(1);

  return {
    roi,
    winRate,
    finalBankroll: bankroll.toFixed(2),
    peak: peak.toFixed(2),
    maxDrawdown: maxDrawdown.toFixed(1),
    totalTrades: trades.length,
    cooldownTrades: cooldownTrades.length,
    cooldownWR,
    busted: false,
  };
}

console.log('🎯 TESTING BEST /realset PARAMETERS\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

// Test different parameter combinations
const tests = [
  { emaGap: 0.15, maxPayout: 1.45, momentum: 1.889, reversal: 1.5, minPay: 1.45, hybrid: false },
  { emaGap: 0.15, maxPayout: 1.45, momentum: 1.889, reversal: 1.5, minPay: 1.45, hybrid: true, hybridPay: 1.65 },
  { emaGap: 0.15, maxPayout: 1.45, momentum: 1.889, reversal: 1.5, minPay: 1.45, hybrid: true, hybridPay: 1.60 },
  { emaGap: 0.10, maxPayout: 1.45, momentum: 1.889, reversal: 1.5, minPay: 1.45, hybrid: true, hybridPay: 1.65 },
  { emaGap: 0.20, maxPayout: 1.45, momentum: 1.889, reversal: 1.5, minPay: 1.45, hybrid: true, hybridPay: 1.65 },
  { emaGap: 0.15, maxPayout: 1.50, momentum: 1.889, reversal: 1.5, minPay: 1.45, hybrid: true, hybridPay: 1.65 },
  { emaGap: 0.15, maxPayout: 1.40, momentum: 1.889, reversal: 1.5, minPay: 1.45, hybrid: true, hybridPay: 1.65 },
];

const results = [];

for (const t of tests) {
  const name = t.hybrid
    ? `/realset ${t.emaGap} ${t.maxPayout} ${t.momentum} ${t.reversal} ${t.minPay} +Hybrid(${t.hybridPay}x)`
    : `/realset ${t.emaGap} ${t.maxPayout} ${t.momentum} ${t.reversal} ${t.minPay}`;

  console.log(`Testing: ${name}...`);
  const result = runStrategy(t.emaGap, t.maxPayout, t.momentum, t.reversal, t.minPay, t.hybrid, t.hybridPay || 1.65);
  results.push({ name, ...result, params: t });
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('📊 RESULTS:\n');
console.log('Configuration                                              │   ROI    │  WR   │ Final  │  DD   │ CD WR');
console.log('───────────────────────────────────────────────────────────┼──────────┼───────┼────────┼───────┼──────');

for (const r of results) {
  const name = r.name.padEnd(57);
  const roi = r.busted ? '  BUST  ' : `+${r.roi}%`.padStart(8);
  const wr = `${r.winRate}%`.padStart(5);
  const final = r.finalBankroll.padStart(6);
  const dd = `${r.maxDrawdown}%`.padStart(5);
  const cdWR = r.cooldownTrades > 0 ? `${r.cooldownWR}%`.padStart(5) : '  N/A';

  console.log(`${name} │ ${roi} │ ${wr} │ ${final} │ ${dd} │ ${cdWR}`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const best = results.reduce((a, b) => {
  if (a.busted && !b.busted) return b;
  if (!a.busted && b.busted) return a;
  if (a.busted && b.busted) return a;
  return parseFloat(a.roi) > parseFloat(b.roi) ? a : b;
});

console.log('🏆 BEST CONFIGURATION:\n');
console.log(`Command: ${best.name.replace(' +Hybrid', '')}\n`);

if (best.params.hybrid) {
  console.log('Circuit Breaker + Hybrid Settings:');
  console.log(`  Loss Threshold: 3`);
  console.log(`  Cooldown: 45 minutes`);
  console.log(`  Hybrid Min Payout: ${best.params.hybridPay}x`);
  console.log(`  BB Thresholds: 35/65`);
  console.log(`  Momentum Thresholds: -0.5/+0.5\n`);
}

console.log('Performance:');
console.log(`  ROI: +${best.roi}%`);
console.log(`  Final: ${best.finalBankroll} BNB (from 1 BNB)`);
console.log(`  Win Rate: ${best.winRate}%`);
console.log(`  Max Drawdown: ${best.maxDrawdown}%`);
if (best.cooldownTrades > 0) {
  console.log(`  Cooldown: ${best.cooldownTrades} trades @ ${best.cooldownWR}% WR`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('✅ COPY THIS COMMAND:\n');
console.log(`/realset ${best.params.emaGap} ${best.params.maxPayout} ${best.params.momentum} ${best.params.reversal} ${best.params.minPay}\n`);

if (best.params.hybrid) {
  console.log('Plus enable Circuit Breaker + Hybrid with:');
  console.log(`  Hybrid Min Payout: ${best.params.hybridPay}x`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════');
