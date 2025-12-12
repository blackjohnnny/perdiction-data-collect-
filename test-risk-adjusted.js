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

function runStrategy(emaGap, maxPayout, momentumMult, reversalMult, minPay) {
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

    if (inCooldown) {
      const pricesForCalc = allPrices.slice(Math.max(0, i - 20), i + 1);
      const bb = calculateBollingerBands(pricesForCalc, 8);
      const momentum = calculateMomentum(pricesForCalc, 10);

      if (bb && bb.position < 35 && bullPayout >= 1.65) {
        signal = 'BULL';
        isCooldownTrade = true;
      } else if (bb && bb.position > 65 && bearPayout >= 1.65) {
        signal = 'BEAR';
        isCooldownTrade = true;
      } else if (momentum !== null && momentum < -0.5 && bullPayout >= 1.65) {
        signal = 'BULL';
        isCooldownTrade = true;
      } else if (momentum !== null && momentum > 0.5 && bearPayout >= 1.65) {
        signal = 'BEAR';
        isCooldownTrade = true;
      }
    } else if (!inCooldown) {
      if (emaSignal === 'BULL' && bearPayout >= maxPayout) {
        signal = 'BEAR';
      } else if (emaSignal === 'BEAR' && bullPayout >= maxPayout) {
        signal = 'BULL';
      }
    }

    if (!signal) continue;

    effectiveBankroll = Math.min(bankroll, MAX_BANKROLL);

    let positionMultiplier = 1.0;

    if (!isCooldownTrade && currentEmaGap >= emaGap) {
      positionMultiplier *= momentumMult;
    }

    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      positionMultiplier *= reversalMult;
    }

    const betAmount = effectiveBankroll * 0.045 * positionMultiplier;

    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = (signal === 'BULL' && winner === 'bull') || (signal === 'BEAR' && winner === 'bear');
    const profit = won ? betAmount * (actualPayout - 1) : -betAmount;

    bankroll += profit;

    if (bankroll <= 0) {
      return { roi: -100, finalBankroll: 0, busted: true };
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
  const roi = ((bankroll - 1.0) * 100).toFixed(1);

  return {
    roi,
    winRate,
    finalBankroll: bankroll.toFixed(2),
    peak: peak.toFixed(2),
    maxDrawdown: maxDrawdown.toFixed(1),
    busted: false,
  };
}

console.log('🛡️ RISK-ADJUSTED: Finding best returns with acceptable drawdown (<60%)\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const tests = [];

// Test various combinations with different emaGap and momentum
for (const gap of [0.05, 0.08, 0.10, 0.12, 0.15]) {
  for (const mom of [1.5, 1.7, 1.889, 2.0, 2.2]) {
    tests.push({ emaGap: gap, momentum: mom });
  }
}

const results = [];

for (const t of tests) {
  const result = runStrategy(t.emaGap, 1.5, t.momentum, 1.5, 1.45);
  results.push({ ...t, ...result, riskScore: parseFloat(result.roi) / parseFloat(result.maxDrawdown) });
}

console.log('📊 ALL RESULTS (sorted by risk-adjusted return):\n');
console.log('emaGap │ Mom  │   ROI    │  DD   │ Final  │ Risk Score');
console.log('───────┼──────┼──────────┼───────┼────────┼───────────');

// Sort by risk score (ROI / DD)
results.sort((a, b) => b.riskScore - a.riskScore);

for (const r of results.slice(0, 15)) { // Show top 15
  const gap = r.emaGap.toFixed(2);
  const mom = r.momentum.toFixed(1).padStart(4);
  const roi = `+${r.roi}%`.padStart(8);
  const dd = `${r.maxDrawdown}%`.padStart(5);
  const final = r.finalBankroll.padStart(6);
  const score = r.riskScore.toFixed(2).padStart(10);

  console.log(` ${gap}  │ ${mom} │ ${roi} │ ${dd} │ ${final} │ ${score}`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

// Filter by acceptable drawdown (<60%)
const acceptable = results.filter(r => parseFloat(r.maxDrawdown) < 60);
const bestSafe = acceptable.reduce((a, b) => parseFloat(a.roi) > parseFloat(b.roi) ? a : b);

console.log('🏆 BEST WITH DRAWDOWN <60%:\n');
console.log(`  emaGap: ${bestSafe.emaGap}`);
console.log(`  momentum: ${bestSafe.momentum}x`);
console.log(`  maxPayout: 1.5x`);
console.log(`  minPay: 1.45x\n`);

console.log('Performance:');
console.log(`  ROI: +${bestSafe.roi}%`);
console.log(`  Final: ${bestSafe.finalBankroll} BNB`);
console.log(`  Max DD: ${bestSafe.maxDrawdown}% ✅ (acceptable)`);
console.log(`  Risk Score: ${bestSafe.riskScore.toFixed(2)} (ROI/DD)\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');

// Also show best overall risk-adjusted
const bestRiskAdjusted = results[0];

console.log('💎 BEST RISK-ADJUSTED (highest ROI/DD ratio):\n');
console.log(`  emaGap: ${bestRiskAdjusted.emaGap}`);
console.log(`  momentum: ${bestRiskAdjusted.momentum}x`);
console.log(`  maxPayout: 1.5x`);
console.log(`  minPay: 1.45x\n`);

console.log('Performance:');
console.log(`  ROI: +${bestRiskAdjusted.roi}%`);
console.log(`  Final: ${bestRiskAdjusted.finalBankroll} BNB`);
console.log(`  Max DD: ${bestRiskAdjusted.maxDrawdown}%`);
console.log(`  Risk Score: ${bestRiskAdjusted.riskScore.toFixed(2)} (highest efficiency)\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('✅ RECOMMENDED COMMAND (Best returns with DD <60%):\n');
console.log(`/realset ${bestSafe.emaGap} 1.5 ${bestSafe.momentum} 1.45\n`);

console.log('Alternative: Best risk-adjusted (if you want highest efficiency):\n');
console.log(`/realset ${bestRiskAdjusted.emaGap} 1.5 ${bestRiskAdjusted.momentum} 1.45\n`);

console.log('════════════════════════════════════════════════════════════════════════════');
