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

function calculateFakeoutScore(rounds, currentIndex, signal, t20sBull, t20sBear) {
  let score = 0;
  const reasons = [];

  // 1. Trend weakening check (EMA gap decreasing)
  if (currentIndex > 0) {
    const currentGap = Math.abs(parseFloat(rounds[currentIndex].ema_gap) || 0);
    const previousGap = Math.abs(parseFloat(rounds[currentIndex - 1].ema_gap) || 0);

    if (previousGap > 0 && currentGap < previousGap * 0.8) {
      score++;
      reasons.push('Trend weakening');
    }
  }

  // 2. Crowd extreme (>80% on our side)
  const t20sTotal = t20sBull + t20sBear;
  if (t20sTotal > 0) {
    const bullPercent = (t20sBull / t20sTotal) * 100;
    const bearPercent = (t20sBear / t20sTotal) * 100;

    if ((signal === 'BULL' && bullPercent > 80) || (signal === 'BEAR' && bearPercent > 80)) {
      score++;
      reasons.push('Crowd extreme');
    }
  }

  // 3. Price overextended (top/bottom 20% of 14-round range)
  const lookback = 14;
  const startIdx = Math.max(0, currentIndex - lookback + 1);
  const recentRounds = rounds.slice(startIdx, currentIndex + 1);

  if (recentRounds.length >= lookback) {
    const prices = recentRounds.map(r => r.close_price);
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    const range = maxPrice - minPrice;
    const currentPrice = rounds[currentIndex].close_price;
    const position = ((currentPrice - minPrice) / range) * 100;

    if ((signal === 'BULL' && position < 20) || (signal === 'BEAR' && position > 80)) {
      score++;
      reasons.push('Price overextended');
    }
  }

  return { score, reasons };
}

function runStrategy(strategyName, useFakeout, fakeoutThreshold) {
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
  let skipped = 0;
  let fakeoutFiltered = 0;

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

      if (bb && bb.position < 35 && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BULL';
        isCooldownTrade = true;
      } else if (bb && bb.position > 65 && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BEAR';
        isCooldownTrade = true;
      } else if (momentum !== null && momentum < -0.5 && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BULL';
        isCooldownTrade = true;
      } else if (momentum !== null && momentum > 0.5 && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BEAR';
        isCooldownTrade = true;
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

    // Apply fakeout filter (only to normal trades, not cooldown trades)
    if (useFakeout && !isCooldownTrade) {
      const fakeout = calculateFakeoutScore(rounds, i, signal, t20sBull, t20sBear);
      if (fakeout.score >= fakeoutThreshold) {
        fakeoutFiltered++;
        continue;
      }
    }

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
        fakeoutFiltered
      };
    }

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    trades.push({
      won,
      isCooldown: isCooldownTrade
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

  const normalTrades = trades.filter(t => !t.isCooldown);
  const normalWins = normalTrades.filter(t => t.won).length;
  const normalWR = normalTrades.length > 0 ? (normalWins / normalTrades.length * 100).toFixed(1) : 0;

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
    normalTrades: normalTrades.length,
    normalWins,
    normalWR,
    busted: false,
    fakeoutFiltered
  };
}

console.log('🔬 CIRCUIT BREAKER + HYBRID: With vs Without Fakeout Filter\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const strategies = [
  { name: 'CB+Hybrid: No Fakeout', useFakeout: false, threshold: 0 },
  { name: 'CB+Hybrid: Fakeout LOOSE (3/3)', useFakeout: true, threshold: 3 },
  { name: 'CB+Hybrid: Fakeout NORMAL (2/3)', useFakeout: true, threshold: 2 },
  { name: 'CB+Hybrid: Fakeout STRICT (1/3)', useFakeout: true, threshold: 1 },
];

const results = [];

for (const strat of strategies) {
  console.log(`Testing: ${strat.name}...`);
  const result = runStrategy(strat.name, strat.useFakeout, strat.threshold);
  results.push(result);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('📊 RESULTS:\n');
console.log('Strategy                           │   ROI    │  WR   │ Final  │  DD   │ Trades │ Normal WR │ CD WR │ Filtered');
console.log('───────────────────────────────────┼──────────┼───────┼────────┼───────┼────────┼───────────┼───────┼─────────');

for (const r of results) {
  const name = r.strategyName.padEnd(33);
  const roi = r.busted ? '  BUST  ' : `+${r.roi}%`.padStart(8);
  const wr = `${r.winRate}%`.padStart(5);
  const final = r.finalBankroll.padStart(6);
  const dd = `${r.maxDrawdown}%`.padStart(5);
  const trades = r.totalTrades.toString().padStart(6);
  const normalWR = `${r.normalWR}%`.padStart(7);
  const cdWR = r.cooldownTrades > 0 ? `${r.cooldownWR}%`.padStart(5) : '  N/A';
  const filtered = r.fakeoutFiltered.toString().padStart(8);

  console.log(`${name} │ ${roi} │ ${wr} │ ${final} │ ${dd} │ ${trades} │ ${normalWR} │ ${cdWR} │ ${filtered}`);
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
console.log(`  Normal Trades: ${best.normalTrades} (${best.normalWR}% WR)`);
console.log(`  Cooldown Trades: ${best.cooldownTrades} (${best.cooldownWR}% WR)`);
console.log(`  Fakeout Filtered: ${best.fakeoutFiltered} trades`);

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

// Compare baseline vs best fakeout
const baseline = results[0];
const bestFakeout = results.slice(1).reduce((a, b) => parseFloat(a.roi) > parseFloat(b.roi) ? a : b);

console.log('📈 COMPARISON:\n');
console.log(`Baseline (No Fakeout):`);
console.log(`  ROI: +${baseline.roi}% | Final: ${baseline.finalBankroll} BNB | Trades: ${baseline.totalTrades}`);
console.log(`  Normal WR: ${baseline.normalWR}% | Cooldown WR: ${baseline.cooldownWR}%\n`);

console.log(`Best Fakeout (${bestFakeout.strategyName}):`);
console.log(`  ROI: +${bestFakeout.roi}% | Final: ${bestFakeout.finalBankroll} BNB | Trades: ${bestFakeout.totalTrades}`);
console.log(`  Normal WR: ${bestFakeout.normalWR}% | Cooldown WR: ${bestFakeout.cooldownWR}%`);
console.log(`  Filtered: ${bestFakeout.fakeoutFiltered} trades\n`);

const roiDiff = parseFloat(bestFakeout.roi) - parseFloat(baseline.roi);
const finalDiff = parseFloat(bestFakeout.finalBankroll) - parseFloat(baseline.finalBankroll);

console.log(`Difference:`);
console.log(`  ROI: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(1)}%`);
console.log(`  Final: ${finalDiff >= 0 ? '+' : ''}${finalDiff.toFixed(2)} BNB`);
console.log(`  Trades Avoided: ${bestFakeout.fakeoutFiltered}`);

console.log('\n🎯 RECOMMENDATION:\n');
if (roiDiff > 50) {
  console.log(`✅ KEEP FAKEOUT FILTER - Improves ROI by ${roiDiff.toFixed(1)}% (+${finalDiff.toFixed(2)} BNB)`);
  console.log(`   Use ${bestFakeout.strategyName.split(':')[1].trim()} setting`);
} else if (roiDiff > 0) {
  console.log(`⚠️ MARGINAL BENEFIT - Fakeout filter improves by ${roiDiff.toFixed(1)}% (+${finalDiff.toFixed(2)} BNB)`);
  console.log(`   Optional - user preference`);
} else {
  console.log(`❌ REMOVE FAKEOUT FILTER - Hurts performance by ${Math.abs(roiDiff).toFixed(1)}% (${finalDiff.toFixed(2)} BNB)`);
  console.log(`   Circuit breaker + hybrid already handles bad markets`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════');
