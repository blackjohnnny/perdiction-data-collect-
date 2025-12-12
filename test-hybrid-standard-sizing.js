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

console.log('🔬 HYBRID STRATEGY WITH STANDARD DYNAMIC POSITION SIZING\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const rounds = db.prepare(`
  SELECT epoch, lock_timestamp, ema_signal, ema_gap,
         t20s_bull_wei, t20s_bear_wei, winner, winner_payout_multiple, close_price
  FROM rounds
  WHERE t20s_bull_wei IS NOT NULL
    AND t20s_bear_wei IS NOT NULL
    AND winner IS NOT NULL
  ORDER BY epoch ASC
`).all();

let bankroll = 1.0;
let trades = [];
let consecutiveLosses = 0;
let cooldownUntilTimestamp = 0;
let cooldownTrades = [];
let normalTrades = [];
let lastTwoResults = [];
let peak = bankroll;
let maxDrawdown = 0;

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
    // Hybrid: BB 35/65 OR Momentum -0.5/+0.5
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

  // Standard dynamic position sizing (same for both normal and cooldown trades)
  let positionMultiplier = 1.0;

  // Momentum multiplier (only for normal trades with strong EMA gap)
  if (!isCooldownTrade && emaGap >= BASE_CONFIG.MIN_EMA_GAP) {
    positionMultiplier *= BASE_CONFIG.MOMENTUM_MULTIPLIER;
  }

  // Recovery multiplier (after 2 consecutive losses)
  if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
    positionMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
  }

  const betAmount = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * positionMultiplier;
  const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
  const won = (signal === 'BULL' && winner === 'bull') || (signal === 'BEAR' && winner === 'bear');
  const profit = won ? betAmount * (actualPayout - 1) : -betAmount;

  bankroll += profit;

  if (bankroll > peak) peak = bankroll;
  const drawdown = ((peak - bankroll) / peak) * 100;
  if (drawdown > maxDrawdown) maxDrawdown = drawdown;

  trades.push({
    epoch: r.epoch,
    signal,
    betAmount,
    won,
    profit,
    bankroll,
    isCooldown: isCooldownTrade,
    multiplier: positionMultiplier
  });

  if (isCooldownTrade) {
    cooldownTrades.push({ won, profit, betAmount });
  } else {
    normalTrades.push({ won, profit, betAmount });
  }

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

const cooldownWins = cooldownTrades.filter(t => t.won).length;
const cooldownLosses = cooldownTrades.filter(t => !t.won).length;
const cooldownWR = cooldownTrades.length > 0 ? (cooldownWins / cooldownTrades.length * 100).toFixed(1) : 0;

const normalWins = normalTrades.filter(t => t.won).length;
const normalLosses = normalTrades.filter(t => !t.won).length;
const normalWR = normalTrades.length > 0 ? (normalWins / normalTrades.length * 100).toFixed(1) : 0;

const roi = ((bankroll - 1.0) * 100).toFixed(1);

console.log('📊 RESULTS:\n');
console.log(`Strategy: Hybrid BB 35/65 OR Momentum -0.5/+0.5`);
console.log(`Position Sizing: Standard Dynamic (no cooldown multiplier)\n`);
console.log(`ROI: +${roi}%`);
console.log(`Win Rate: ${winRate}% (${wins}W / ${losses}L)`);
console.log(`Final Bankroll: ${bankroll.toFixed(2)} BNB`);
console.log(`Peak: ${peak.toFixed(2)} BNB`);
console.log(`Max Drawdown: ${maxDrawdown.toFixed(1)}%\n`);

console.log('─────────────────────────────────────────────────────────────────────────\n');

console.log(`Normal Trades: ${normalTrades.length} trades`);
console.log(`  Win Rate: ${normalWR}% (${normalWins}W / ${normalLosses}L)`);
console.log(`  Total Profit: ${normalTrades.reduce((sum, t) => sum + t.profit, 0).toFixed(2)} BNB\n`);

console.log(`Cooldown Trades: ${cooldownTrades.length} trades`);
console.log(`  Win Rate: ${cooldownWR}% (${cooldownWins}W / ${cooldownLosses}L)`);
console.log(`  Total Profit: ${cooldownTrades.reduce((sum, t) => sum + t.profit, 0).toFixed(2)} BNB\n`);

console.log('════════════════════════════════════════════════════════════════════════\n');

// Show position sizing breakdown
const withMomentum = trades.filter(t => !t.isCooldown && t.multiplier > 1.5);
const withRecovery = trades.filter(t => t.multiplier >= 1.5 && t.multiplier < 1.889);
const withBoth = trades.filter(t => t.multiplier > 2.5);
const base = trades.filter(t => t.multiplier === 1.0);

console.log('🎯 POSITION SIZING BREAKDOWN:\n');
console.log(`Base (1.0x): ${base.length} trades`);
console.log(`Recovery (1.5x): ${withRecovery.length} trades`);
console.log(`Momentum (1.889x): ${withMomentum.length - withBoth.length} trades`);
console.log(`Both (2.8335x): ${withBoth.length} trades`);

console.log('\n════════════════════════════════════════════════════════════════════════');
