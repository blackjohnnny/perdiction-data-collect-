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

function runStrategy(emaGap, maxPayout, momentumMult, reversalMult, minPay, useHybrid = true, hybridMinPayout = 1.65) {
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

  let normalTradesWithMomentum = 0;
  let normalTradesBase = 0;

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
      if (emaSignal === 'BULL' && bearPayout >= maxPayout) {
        signal = 'BEAR';
      } else if (emaSignal === 'BEAR' && bullPayout >= maxPayout) {
        signal = 'BULL';
      }
    }

    if (!signal) continue;

    effectiveBankroll = Math.min(bankroll, MAX_BANKROLL);

    let positionMultiplier = 1.0;
    let usedMomentumMult = false;

    if (!isCooldownTrade && currentEmaGap >= emaGap) {
      positionMultiplier *= momentumMult;
      usedMomentumMult = true;
      normalTradesWithMomentum++;
    } else if (!isCooldownTrade) {
      normalTradesBase++;
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

  const roi = ((bankroll - 1.0) * 100).toFixed(1);

  return {
    roi,
    winRate,
    finalBankroll: bankroll.toFixed(2),
    peak: peak.toFixed(2),
    maxDrawdown: maxDrawdown.toFixed(1),
    totalTrades: trades.length,
    normalTradesWithMomentum,
    normalTradesBase,
    busted: false,
  };
}

console.log('🔬 FINE-TUNING: emaGap and momentum multiplier\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

// Test fine-tuned values
const tests = [
  // Current best
  { emaGap: 0.15, maxPayout: 1.5, momentum: 1.889, name: 'Current Best' },

  // Lower emaGap (triggers more often)
  { emaGap: 0.05, maxPayout: 1.5, momentum: 1.889, name: 'Lower Gap 0.05' },
  { emaGap: 0.08, maxPayout: 1.5, momentum: 1.889, name: 'Lower Gap 0.08' },
  { emaGap: 0.10, maxPayout: 1.5, momentum: 1.889, name: 'Lower Gap 0.10' },
  { emaGap: 0.12, maxPayout: 1.5, momentum: 1.889, name: 'Lower Gap 0.12' },

  // Higher emaGap (more selective)
  { emaGap: 0.18, maxPayout: 1.5, momentum: 1.889, name: 'Higher Gap 0.18' },
  { emaGap: 0.20, maxPayout: 1.5, momentum: 1.889, name: 'Higher Gap 0.20' },

  // Lower momentum multiplier (less aggressive)
  { emaGap: 0.15, maxPayout: 1.5, momentum: 1.5, name: 'Lower Mom 1.5x' },
  { emaGap: 0.15, maxPayout: 1.5, momentum: 1.7, name: 'Lower Mom 1.7x' },
  { emaGap: 0.15, maxPayout: 1.5, momentum: 2.0, name: 'Higher Mom 2.0x' },
  { emaGap: 0.15, maxPayout: 1.5, momentum: 2.2, name: 'Higher Mom 2.2x' },

  // Combined optimizations
  { emaGap: 0.10, maxPayout: 1.5, momentum: 1.7, name: 'Combo: Gap 0.10, Mom 1.7x' },
  { emaGap: 0.12, maxPayout: 1.5, momentum: 1.7, name: 'Combo: Gap 0.12, Mom 1.7x' },
  { emaGap: 0.08, maxPayout: 1.5, momentum: 1.5, name: 'Combo: Gap 0.08, Mom 1.5x' },
];

const results = [];

for (const t of tests) {
  console.log(`Testing: ${t.name} (emaGap=${t.emaGap}, momentum=${t.momentum}x)...`);
  const result = runStrategy(t.emaGap, t.maxPayout, t.momentum, 1.5, 1.45, true, 1.65);
  results.push({ ...t, ...result });
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('📊 RESULTS:\n');
console.log('Configuration                    │   ROI    │  WR   │ Final  │  DD   │ Mom Trades │ Base Trades');
console.log('─────────────────────────────────┼──────────┼───────┼────────┼───────┼────────────┼────────────');

for (const r of results) {
  const name = r.name.padEnd(31);
  const roi = r.busted ? '  BUST  ' : `+${r.roi}%`.padStart(8);
  const wr = `${r.winRate}%`.padStart(5);
  const final = r.finalBankroll.padStart(6);
  const dd = `${r.maxDrawdown}%`.padStart(5);
  const momTrades = r.normalTradesWithMomentum.toString().padStart(10);
  const baseTrades = r.normalTradesBase.toString().padStart(11);

  console.log(`${name} │ ${roi} │ ${wr} │ ${final} │ ${dd} │ ${momTrades} │ ${baseTrades}`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const best = results.reduce((a, b) => {
  if (a.busted && !b.busted) return b;
  if (!a.busted && b.busted) return a;
  if (a.busted && b.busted) return a;
  return parseFloat(a.roi) > parseFloat(b.roi) ? a : b;
});

console.log('🏆 OPTIMAL PARAMETERS:\n');
console.log(`${best.name}`);
console.log(`  emaGap: ${best.emaGap} (${best.normalTradesWithMomentum} trades got momentum multiplier)`);
console.log(`  momentum: ${best.momentum}x`);
console.log(`  maxPayout: ${best.maxPayout}x`);
console.log(`\nPerformance:`);
console.log(`  ROI: +${best.roi}%`);
console.log(`  Final: ${best.finalBankroll} BNB`);
console.log(`  Win Rate: ${best.winRate}%`);
console.log(`  Max DD: ${best.maxDrawdown}%\n`);

console.log('✅ OPTIMIZED COMMAND:\n');
console.log(`/realset ${best.emaGap} ${best.maxPayout} ${best.momentum} ${best.minPay || 1.45}\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');

// Analysis
const currentBest = results.find(r => r.name === 'Current Best');
const improvement = parseFloat(best.finalBankroll) - parseFloat(currentBest.finalBankroll);

if (improvement > 10) {
  console.log(`💡 IMPROVEMENT FOUND: +${improvement.toFixed(2)} BNB better than current settings!`);
} else if (improvement > 0) {
  console.log(`⚡ MARGINAL IMPROVEMENT: +${improvement.toFixed(2)} BNB (${(improvement / parseFloat(currentBest.finalBankroll) * 100).toFixed(1)}% better)`);
} else {
  console.log(`✅ CURRENT SETTINGS ARE OPTIMAL (within ${Math.abs(improvement).toFixed(2)} BNB)`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════');
