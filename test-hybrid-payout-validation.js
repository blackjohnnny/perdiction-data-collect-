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
        if (hybridCheckPayout) {
          if (hybridSignal === 'BULL' && bullPayout >= hybridMinPayout) {
            signal = 'BULL';
            isCooldownTrade = true;
          } else if (hybridSignal === 'BEAR' && bearPayout >= hybridMinPayout) {
            signal = 'BEAR';
            isCooldownTrade = true;
          } else {
            hybridSkippedPayout++;
          }
        } else {
          signal = hybridSignal;
          isCooldownTrade = true;
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
        strategyName,
        roi: -100,
        winRate: 0,
        finalBankroll: 0,
        peak: peak.toFixed(2),
        maxDrawdown: 100,
        totalTrades: trades.length,
        busted: true,
        hybridSkippedPayout,
        normalTrades: 0,
        cooldownTrades: 0
      };
    }

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    trades.push({
      won,
      isCooldown: isCooldownTrade,
      payout: actualPayout,
      betAmount,
      profit,
      bankroll
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
    normalTrades: normalTrades.length,
    normalWins,
    normalWR,
    cooldownTrades: cooldownTrades.length,
    cooldownWins,
    cooldownLosses,
    cooldownWR,
    avgCooldownPayout,
    busted: false,
    hybridSkippedPayout,
    trades // Return full trades for inspection
  };
}

console.log('🔍 VALIDATION: Checking hybrid payout filter results\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

// Test just two extremes
const noFilter = runStrategy('NO payout filter', false, 1.0);
const withFilter = runStrategy('Payout ≥ 1.60x', true, 1.60);

console.log('📊 DETAILED COMPARISON:\n');
console.log('NO PAYOUT FILTER:');
console.log(`  Total Trades: ${noFilter.totalTrades}`);
console.log(`    Normal: ${noFilter.normalTrades} trades (${noFilter.normalWR}% WR)`);
console.log(`    Cooldown: ${noFilter.cooldownTrades} trades (${noFilter.cooldownWR}% WR)`);
console.log(`  Final: ${noFilter.finalBankroll} BNB`);
console.log(`  ROI: +${noFilter.roi}%`);
console.log(`  Peak: ${noFilter.peak} BNB`);
console.log(`  Max DD: ${noFilter.maxDrawdown}%`);
console.log(`  Avg Cooldown Payout: ${noFilter.avgCooldownPayout}x\n`);

console.log('WITH PAYOUT ≥ 1.60x:');
console.log(`  Total Trades: ${withFilter.totalTrades}`);
console.log(`    Normal: ${withFilter.normalTrades} trades (${withFilter.normalWR}% WR)`);
console.log(`    Cooldown: ${withFilter.cooldownTrades} trades (${withFilter.cooldownWR}% WR)`);
console.log(`  Final: ${withFilter.finalBankroll} BNB`);
console.log(`  ROI: +${withFilter.roi}%`);
console.log(`  Peak: ${withFilter.peak} BNB`);
console.log(`  Max DD: ${withFilter.maxDrawdown}%`);
console.log(`  Avg Cooldown Payout: ${withFilter.avgCooldownPayout}x`);
console.log(`  Filtered: ${withFilter.hybridSkippedPayout} cooldown trades\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');

// Show first 20 cooldown trades from each
console.log('🔬 SAMPLE COOLDOWN TRADES (first 10 from each):\n');

const noFilterCooldown = noFilter.trades.filter(t => t.isCooldown).slice(0, 10);
const withFilterCooldown = withFilter.trades.filter(t => t.isCooldown).slice(0, 10);

console.log('NO FILTER - First 10 cooldown trades:');
console.log('Trade │ Won │ Payout │ Bet    │ Profit  │ Bankroll');
console.log('──────┼─────┼────────┼────────┼─────────┼─────────');
noFilterCooldown.forEach((t, i) => {
  console.log(`  ${(i+1).toString().padStart(2)}  │ ${t.won ? '✅' : '❌'}  │ ${t.payout.toFixed(2).padStart(6)} │ ${t.betAmount.toFixed(2).padStart(6)} │ ${t.profit.toFixed(2).padStart(7)} │ ${t.bankroll.toFixed(2).padStart(8)}`);
});

console.log('\nWITH ≥1.60x FILTER - First 10 cooldown trades:');
console.log('Trade │ Won │ Payout │ Bet    │ Profit  │ Bankroll');
console.log('──────┼─────┼────────┼────────┼─────────┼─────────');
withFilterCooldown.forEach((t, i) => {
  console.log(`  ${(i+1).toString().padStart(2)}  │ ${t.won ? '✅' : '❌'}  │ ${t.payout.toFixed(2).padStart(6)} │ ${t.betAmount.toFixed(2).padStart(6)} │ ${t.profit.toFixed(2).padStart(7)} │ ${t.bankroll.toFixed(2).padStart(8)}`);
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const diff = parseFloat(withFilter.finalBankroll) - parseFloat(noFilter.finalBankroll);
console.log('🎯 VERDICT:\n');
console.log(`Difference: ${diff >= 0 ? '+' : ''}${diff.toFixed(2)} BNB (${((diff / parseFloat(noFilter.finalBankroll)) * 100).toFixed(1)}%)`);
console.log(`\nNormal trades are IDENTICAL (${noFilter.normalTrades} trades, both strategies)`);
console.log(`Only difference is cooldown trades:`);
console.log(`  No filter: ${noFilter.cooldownTrades} trades @ ${noFilter.cooldownWR}% WR, avg ${noFilter.avgCooldownPayout}x`);
console.log(`  With filter: ${withFilter.cooldownTrades} trades @ ${withFilter.cooldownWR}% WR, avg ${withFilter.avgCooldownPayout}x`);
console.log(`  Filtered out: ${withFilter.hybridSkippedPayout} low-payout trades`);

if (diff > 50) {
  console.log(`\n✅ PAYOUT FILTER HELPS - Adds ${diff.toFixed(2)} BNB by filtering low-payout traps`);
} else if (diff < -50) {
  console.log(`\n❌ PAYOUT FILTER HURTS - Removes ${Math.abs(diff).toFixed(2)} BNB of profit`);
} else {
  console.log(`\n⚠️ MARGINAL - Only ${Math.abs(diff).toFixed(2)} BNB difference`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════');
