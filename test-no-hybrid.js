import { initDatabase } from './db-init.js';

const db = initDatabase();

const config = {
  EMA_GAP: 0.05,
  MAX_PAYOUT: 1.55,
  MOMENTUM_MULT: 2.2,
  RECOVERY_MULT: 1.5,
  CB_THRESHOLD: 3,
  CB_COOLDOWN_MIN: 45,
  HYBRID_ENABLED: false, // SKIP cooldown entirely
};

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
const MAX_BANKROLL = 50.0;
let consecutiveLosses = 0;
let cooldownUntilTimestamp = 0;
let lastTwoResults = [];
let peak = bankroll;
let maxDrawdown = 0;
let trades = [];

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];

  const inCooldown = r.lock_timestamp < cooldownUntilTimestamp;

  // SKIP during cooldown
  if (inCooldown) continue;

  const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
  const totalAmount = bullAmount + bearAmount;

  if (totalAmount === 0) continue;

  const bullPayout = totalAmount / bullAmount;
  const bearPayout = totalAmount / bearAmount;

  const emaSignal = r.ema_signal;
  let signal = null;

  // FOLLOW EMA
  if (emaSignal === 'BULL' && bullPayout >= config.MAX_PAYOUT) {
    signal = 'BULL';
  } else if (emaSignal === 'BEAR' && bearPayout >= config.MAX_PAYOUT) {
    signal = 'BEAR';
  }

  if (!signal) continue;

  const effectiveBankroll = Math.min(bankroll, MAX_BANKROLL);
  let positionMultiplier = 1.0;

  // Momentum multiplier
  const currentEmaGap = r.ema_gap || 0;
  if (currentEmaGap >= config.EMA_GAP) {
    positionMultiplier *= config.MOMENTUM_MULT;
  }

  // Recovery multiplier
  if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
    positionMultiplier *= config.RECOVERY_MULT;
  }

  const betAmount = effectiveBankroll * 0.045 * positionMultiplier;
  const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
  const won = (signal === 'BULL' && r.winner === 'bull') || (signal === 'BEAR' && r.winner === 'bear');
  const profit = won ? betAmount * (actualPayout - 1) : -betAmount;

  bankroll += profit;

  if (bankroll <= 0) break;

  if (bankroll > peak) peak = bankroll;
  const drawdown = ((peak - bankroll) / peak) * 100;
  if (drawdown > maxDrawdown) maxDrawdown = drawdown;

  trades.push({ won });
  lastTwoResults.push(won);
  if (lastTwoResults.length > 2) lastTwoResults.shift();

  if (won) {
    consecutiveLosses = 0;
  } else {
    consecutiveLosses++;
    if (consecutiveLosses >= config.CB_THRESHOLD) {
      cooldownUntilTimestamp = r.lock_timestamp + (config.CB_COOLDOWN_MIN * 60);
      consecutiveLosses = 0;
    }
  }
}

const wins = trades.filter(t => t.won).length;
const winRate = (wins / trades.length * 100).toFixed(1);
const roi = ((bankroll - 1.0) * 100).toFixed(1);

console.log('🔬 Circuit Breaker with NO HYBRID (skip cooldown):\\n');
console.log(`Final: ${bankroll.toFixed(2)} BNB`);
console.log(`ROI: +${roi}%`);
console.log(`Win Rate: ${winRate}%`);
console.log(`Max DD: ${maxDrawdown.toFixed(1)}%`);
console.log(`Total Trades: ${trades.length}`);
console.log(`\\nCompare to WITH hybrid (20% cooldown WR dragging down performance)`);
