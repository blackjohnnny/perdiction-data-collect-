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
  MAX_BANKROLL: 50.0, // Stop compounding after hitting 50 BNB
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

function runStrategy(strategyName, cooldownBehavior) {
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
  let effectiveBankroll = 1.0; // For position sizing, capped at MAX_BANKROLL
  let trades = [];
  let consecutiveLosses = 0;
  let cooldownUntilTimestamp = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;
  let skipped = 0;

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
      if (cooldownBehavior === 'skip') {
        skipped++;
        continue;
      } else if (cooldownBehavior === 'bb_only') {
        const bb = calculateBollingerBands(rounds, i, 8);
        if (bb && bb.position < 30 && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BULL';
          isCooldownTrade = true;
        } else if (bb && bb.position > 70 && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BEAR';
          isCooldownTrade = true;
        }
      } else if (cooldownBehavior === 'hybrid') {
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

    // Cap effective bankroll for position sizing
    effectiveBankroll = Math.min(bankroll, BASE_CONFIG.MAX_BANKROLL);

    // Standard dynamic position sizing
    let positionMultiplier = 1.0;

    // Momentum multiplier (only for normal trades with strong EMA gap)
    if (!isCooldownTrade && emaGap >= BASE_CONFIG.MIN_EMA_GAP) {
      positionMultiplier *= BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    // Recovery multiplier (after 2 consecutive losses)
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
        skipped
      };
    }

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    trades.push({
      won,
      isCooldown: isCooldownTrade,
      betAmount,
      profit,
      bankroll
    });

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    // Circuit breaker logic
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
    busted: false,
    skipped,
    trades
  };
}

console.log('🔬 REALISTIC BACKTEST: Capped Compounding at 50 BNB\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const strategies = [
  { name: 'CB: Skip Cooldown', behavior: 'skip' },
  { name: 'CB: BB 30/70 Only', behavior: 'bb_only' },
  { name: 'CB: Hybrid (BB 35/65 OR Mom -0.5/0.5)', behavior: 'hybrid' }
];

const results = [];

for (const strat of strategies) {
  console.log(`Testing: ${strat.name}...`);
  const result = runStrategy(strat.name, strat.behavior);
  results.push(result);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('📊 RESULTS:\n');
console.log('Strategy                                  │   ROI    │  WR   │ Final  │  Peak  │  DD   │ Trades │ CD Trades │ CD WR');
console.log('──────────────────────────────────────────┼──────────┼───────┼────────┼────────┼───────┼────────┼───────────┼──────');

for (const r of results) {
  const name = r.strategyName.padEnd(40);
  const roi = r.busted ? '  BUST  ' : `+${r.roi}%`.padStart(8);
  const wr = `${r.winRate}%`.padStart(5);
  const final = r.finalBankroll.padStart(6);
  const peak = r.peak.padStart(6);
  const dd = `${r.maxDrawdown}%`.padStart(5);
  const trades = r.totalTrades.toString().padStart(6);
  const cdTrades = r.cooldownTrades.toString().padStart(9);
  const cdWR = r.cooldownTrades > 0 ? `${r.cooldownWR}%`.padStart(5) : '  N/A';

  console.log(`${name} │ ${roi} │ ${wr} │ ${final} │ ${peak} │ ${dd} │ ${trades} │ ${cdTrades} │ ${cdWR}`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

// Find best
const best = results.reduce((a, b) => parseFloat(a.roi) > parseFloat(b.roi) ? a : b);

console.log('🏆 WINNER:\n');
console.log(`${best.strategyName}`);
console.log(`  ROI: +${best.roi}%`);
console.log(`  Win Rate: ${best.winRate}% (${best.wins}W / ${best.losses}L)`);
console.log(`  Final: ${best.finalBankroll} BNB (from 1 BNB start)`);
console.log(`  Peak: ${best.peak} BNB`);
console.log(`  Max DD: ${best.maxDrawdown}%`);
if (best.cooldownTrades > 0) {
  console.log(`  Cooldown: ${best.cooldownWR}% WR (${best.cooldownWins}W / ${best.cooldownLosses}L) - ${best.cooldownTrades} trades`);
}
console.log(`  Skipped: ${best.skipped} rounds`);

console.log('\n════════════════════════════════════════════════════════════════════════════');
