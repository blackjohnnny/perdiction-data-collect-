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

function runFullStrategy(config) {
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
  let cbTriggeredCount = 0;

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

    if (inCooldown && config.HYBRID_ENABLED) {
      // HYBRID: BB ONLY (momentum removed - 38% WR was dragging down performance)
      const pricesForCalc = allPrices.slice(Math.max(0, i - 20), i + 1);
      const bb = calculateBollingerBands(pricesForCalc, config.HYBRID_BB_PERIOD);

      if (bb && bb.position < config.HYBRID_BB_LOWER && bullPayout >= config.HYBRID_MIN_PAYOUT) {
        signal = 'BULL';
        isCooldownTrade = true;
      } else if (bb && bb.position > config.HYBRID_BB_UPPER && bearPayout >= config.HYBRID_MIN_PAYOUT) {
        signal = 'BEAR';
        isCooldownTrade = true;
      }
    } else if (!inCooldown) {
      // NORMAL EMA FOLLOW TRADING
      if (emaSignal === 'BULL' && bullPayout >= config.MAX_PAYOUT) {
        signal = 'BULL';
      } else if (emaSignal === 'BEAR' && bearPayout >= config.MAX_PAYOUT) {
        signal = 'BEAR';
      }
    }

    if (!signal) continue;

    effectiveBankroll = Math.min(bankroll, MAX_BANKROLL);

    let positionMultiplier = 1.0;

    // Momentum multiplier (only for normal trades)
    if (!isCooldownTrade && currentEmaGap >= config.EMA_GAP) {
      positionMultiplier *= config.MOMENTUM_MULT;
    }

    // Recovery multiplier (both normal and cooldown)
    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      positionMultiplier *= config.RECOVERY_MULT;
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
        bustRound: i,
      };
    }

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    trades.push({ won, isCooldown: isCooldownTrade, payout: actualPayout });

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    if (won) {
      consecutiveLosses = 0;
    } else {
      consecutiveLosses++;
      if (consecutiveLosses >= config.CB_THRESHOLD) {
        cooldownUntilTimestamp = r.lock_timestamp + (config.CB_COOLDOWN_MIN * 60);
        consecutiveLosses = 0;
        cbTriggeredCount++;
      }
    }
  }

  const wins = trades.filter(t => t.won).length;
  const winRate = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : 0;

  const normalTrades = trades.filter(t => !t.isCooldown);
  const normalWins = normalTrades.filter(t => t.won).length;
  const normalWR = normalTrades.length > 0 ? (normalWins / normalTrades.length * 100).toFixed(1) : 0;

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
    normalTrades: normalTrades.length,
    normalWR,
    cooldownTrades: cooldownTrades.length,
    cooldownWR,
    cbTriggeredCount,
    busted: false,
  };
}

console.log('🔬 COMPREHENSIVE TEST: All parameter combinations with Circuit Breaker + Hybrid\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const configs = [];

// Test matrix:
// emaGap: 0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20
// maxPayout: 1.40, 1.45, 1.50, 1.55
// momentum: 1.5, 1.7, 1.889, 2.0, 2.2
// hybridPayout: 1.60, 1.65, 1.70

console.log('Generating test configurations...\n');

let testCount = 0;

for (const emaGap of [0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20]) {
  for (const maxPayout of [1.40, 1.45, 1.50, 1.55]) {
    for (const momentum of [1.5, 1.7, 1.889, 2.0, 2.2]) {
      for (const hybridPay of [1.60, 1.65, 1.70]) {
        configs.push({
          EMA_GAP: emaGap,
          MAX_PAYOUT: maxPayout,
          MOMENTUM_MULT: momentum,
          RECOVERY_MULT: 1.5,
          CB_THRESHOLD: 3,
          CB_COOLDOWN_MIN: 45,
          HYBRID_ENABLED: true,
          HYBRID_MIN_PAYOUT: hybridPay,
          HYBRID_BB_PERIOD: 8,
          HYBRID_BB_LOWER: 35,
          HYBRID_BB_UPPER: 65,
          HYBRID_MOMENTUM_PERIOD: 10,
          HYBRID_MOMENTUM_BULL: -0.5,
          HYBRID_MOMENTUM_BEAR: 0.5,
        });
        testCount++;
      }
    }
  }
}

console.log(`Total configurations to test: ${testCount}\n`);
console.log('Running tests (this may take a minute)...\n');

const results = [];
let completed = 0;

for (const config of configs) {
  const result = runFullStrategy(config);
  results.push({ config, ...result });

  completed++;
  if (completed % 50 === 0) {
    console.log(`Progress: ${completed}/${testCount} (${((completed/testCount)*100).toFixed(1)}%)`);
  }
}

console.log(`\nCompleted: ${testCount}/${testCount}\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');

// Sort by final bankroll
results.sort((a, b) => parseFloat(b.finalBankroll) - parseFloat(a.finalBankroll));

console.log('📊 TOP 20 CONFIGURATIONS (by final bankroll):\n');
console.log('Rank │ emaGap │ maxPay │ Mom  │ HybPay │   ROI    │ Final  │  DD   │ Normal │ CD WR │ CB');
console.log('─────┼────────┼────────┼──────┼────────┼──────────┼────────┼───────┼────────┼───────┼───');

for (let i = 0; i < Math.min(20, results.length); i++) {
  const r = results[i];
  const rank = (i + 1).toString().padStart(4);
  const gap = r.config.EMA_GAP.toFixed(2);
  const maxPay = r.config.MAX_PAYOUT.toFixed(2);
  const mom = r.config.MOMENTUM_MULT.toFixed(1).padStart(4);
  const hybPay = r.config.HYBRID_MIN_PAYOUT.toFixed(2);
  const roi = `+${r.roi}%`.padStart(8);
  const final = r.finalBankroll.padStart(6);
  const dd = `${r.maxDrawdown}%`.padStart(5);
  const normalWR = `${r.normalWR}%`.padStart(5);
  const cdWR = r.cooldownTrades > 0 ? `${r.cooldownWR}%`.padStart(5) : '  N/A';
  const cb = r.cbTriggeredCount.toString().padStart(2);

  console.log(`${rank} │  ${gap}  │  ${maxPay}  │ ${mom} │  ${hybPay}  │ ${roi} │ ${final} │ ${dd} │ ${normalWR} │ ${cdWR} │ ${cb}`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

// Best overall
const best = results[0];

console.log('🏆 ABSOLUTE BEST CONFIGURATION:\n');
console.log(`Parameters:`);
console.log(`  emaGap: ${best.config.EMA_GAP}`);
console.log(`  maxPayout: ${best.config.MAX_PAYOUT}x`);
console.log(`  momentum: ${best.config.MOMENTUM_MULT}x`);
console.log(`  recovery: ${best.config.RECOVERY_MULT}x`);
console.log(`  hybridPayout: ${best.config.HYBRID_MIN_PAYOUT}x\n`);

console.log(`Performance:`);
console.log(`  Final: ${best.finalBankroll} BNB (from 1 BNB)`);
console.log(`  ROI: +${best.roi}%`);
console.log(`  Win Rate: ${best.winRate}%`);
console.log(`  Max DD: ${best.maxDrawdown}%\n`);

console.log(`Trading Stats:`);
console.log(`  Total Trades: ${best.totalTrades}`);
console.log(`  Normal: ${best.normalTrades} trades (${best.normalWR}% WR)`);
console.log(`  Cooldown: ${best.cooldownTrades} trades (${best.cooldownWR}% WR)`);
console.log(`  Circuit Breaker Triggered: ${best.cbTriggeredCount} times\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');

// Best with acceptable DD (<65%)
const acceptable = results.filter(r => parseFloat(r.maxDrawdown) < 65);
const bestSafe = acceptable[0];

if (bestSafe) {
  console.log('🛡️ BEST WITH DD <65% (Safer):\n');
  console.log(`Parameters:`);
  console.log(`  emaGap: ${bestSafe.config.EMA_GAP}`);
  console.log(`  maxPayout: ${bestSafe.config.MAX_PAYOUT}x`);
  console.log(`  momentum: ${bestSafe.config.MOMENTUM_MULT}x`);
  console.log(`  hybridPayout: ${bestSafe.config.HYBRID_MIN_PAYOUT}x\n`);

  console.log(`Performance:`);
  console.log(`  Final: ${bestSafe.finalBankroll} BNB`);
  console.log(`  ROI: +${bestSafe.roi}%`);
  console.log(`  Max DD: ${bestSafe.maxDrawdown}% ✅\n`);
}

console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('✅ FINAL COMMAND (ABSOLUTE BEST):\n');
console.log(`/realset ${best.config.EMA_GAP} ${best.config.MAX_PAYOUT} ${best.config.MOMENTUM_MULT} 1.45\n`);
console.log(`Circuit Breaker: 3 losses, 45 min cooldown`);
console.log(`Hybrid Min Payout: ${best.config.HYBRID_MIN_PAYOUT}x\n`);

if (bestSafe && bestSafe !== best) {
  console.log('Alternative (Safer - DD <65%):\n');
  console.log(`/realset ${bestSafe.config.EMA_GAP} ${bestSafe.config.MAX_PAYOUT} ${bestSafe.config.MOMENTUM_MULT} 1.45\n`);
  console.log(`Hybrid Min Payout: ${bestSafe.config.HYBRID_MIN_PAYOUT}x\n`);
}

console.log('════════════════════════════════════════════════════════════════════════════');
