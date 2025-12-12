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

function runStrategy(config) {
  const rounds = db.prepare(`
    SELECT epoch, lock_timestamp, ema_signal, ema_gap,
           lock_bull_wei, lock_bear_wei, winner, close_price
    FROM rounds
    WHERE lock_bull_wei IS NOT NULL
      AND lock_bear_wei IS NOT NULL
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

    const emaGap = parseFloat(r.ema_gap) || 0;

    const lockBull = parseFloat(r.lock_bull_wei || 0) / 1e18;
    const lockBear = parseFloat(r.lock_bear_wei || 0) / 1e18;
    const lockTotal = lockBull + lockBear;
    if (lockTotal === 0) continue;

    const bullPayout = (lockTotal * 0.97) / lockBull;
    const bearPayout = (lockTotal * 0.97) / lockBear;
    const winner = r.winner ? r.winner.toLowerCase() : '';

    const inCooldown = r.lock_timestamp < cooldownUntilTimestamp;

    let signal = null;
    let isCooldownTrade = false;
    let reason = '';

    if (inCooldown && config.HYBRID_ENABLED) {
      // Hybrid mean reversion
      const pricesForCalc = allPrices.slice(Math.max(0, i - 20), i + 1);
      const bb = calculateBollingerBands(pricesForCalc, config.HYBRID_BB_PERIOD);
      const momentum = calculateMomentum(pricesForCalc, config.HYBRID_MOMENTUM_PERIOD);

      let hybridSignal = null;

      if (bb && bb.position < config.HYBRID_BB_LOWER) {
        hybridSignal = 'BULL';
        reason = `BB oversold (${bb.position.toFixed(1)}%)`;
      } else if (bb && bb.position > config.HYBRID_BB_UPPER) {
        hybridSignal = 'BEAR';
        reason = `BB overbought (${bb.position.toFixed(1)}%)`;
      } else if (momentum !== null && momentum < config.HYBRID_MOMENTUM_BULL_THRESH) {
        hybridSignal = 'BULL';
        reason = `Momentum down (${momentum.toFixed(2)}%)`;
      } else if (momentum !== null && momentum > config.HYBRID_MOMENTUM_BEAR_THRESH) {
        hybridSignal = 'BEAR';
        reason = `Momentum up (${momentum.toFixed(2)}%)`;
      }

      if (hybridSignal) {
        if (hybridSignal === 'BULL' && bullPayout >= config.HYBRID_MIN_PAYOUT) {
          signal = 'BULL';
          isCooldownTrade = true;
        } else if (hybridSignal === 'BEAR' && bearPayout >= config.HYBRID_MIN_PAYOUT) {
          signal = 'BEAR';
          isCooldownTrade = true;
        }
      }
    } else if (!inCooldown) {
      // Normal strategy (REVERSE_CROWD = contrarian)
      if (emaSignal === 'BULL' && bearPayout >= config.MIN_PAYOUT) {
        signal = 'BEAR';
        reason = 'EMA BULL, bet BEAR (contrarian)';
      } else if (emaSignal === 'BEAR' && bullPayout >= config.MIN_PAYOUT) {
        signal = 'BULL';
        reason = 'EMA BEAR, bet BULL (contrarian)';
      }
    }

    if (!signal) continue;

    effectiveBankroll = Math.min(bankroll, MAX_BANKROLL);

    let positionMultiplier = 1.0;

    if (!isCooldownTrade && emaGap >= config.MIN_EMA_GAP) {
      positionMultiplier *= config.MOMENTUM_MULTIPLIER;
    }

    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      positionMultiplier *= config.RECOVERY_MULTIPLIER;
    }

    const betAmount = effectiveBankroll * config.BASE_POSITION_SIZE * positionMultiplier;

    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = (signal === 'BULL' && winner === 'bull') || (signal === 'BEAR' && winner === 'bear');
    const profit = won ? betAmount * (actualPayout - 1) : -betAmount;

    bankroll += profit;

    if (bankroll <= 0) {
      return {
        configName: config.NAME,
        roi: -100,
        finalBankroll: 0,
        busted: true,
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
      if (consecutiveLosses >= config.CB_LOSS_THRESHOLD) {
        cooldownUntilTimestamp = r.lock_timestamp + (config.CB_COOLDOWN_MINUTES * 60);
        consecutiveLosses = 0;
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

  const avgCooldownPayout = cooldownTrades.length > 0
    ? (cooldownTrades.reduce((sum, t) => sum + t.payout, 0) / cooldownTrades.length).toFixed(3)
    : 0;

  const roi = ((bankroll - 1.0) * 100).toFixed(1);

  return {
    configName: config.NAME,
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
    avgCooldownPayout,
    busted: false,
  };
}

console.log('🎯 FINAL OPTIMAL SETTINGS TEST\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

// Test configurations
const configs = [
  {
    NAME: 'REVERSE_CROWD Only (No Hybrid)',
    BASE_POSITION_SIZE: 0.045,
    MOMENTUM_MULTIPLIER: 1.889,
    RECOVERY_MULTIPLIER: 1.5,
    MIN_PAYOUT: 1.45,
    MIN_EMA_GAP: 0.15,
    CB_LOSS_THRESHOLD: 3,
    CB_COOLDOWN_MINUTES: 45,
    HYBRID_ENABLED: false,
  },
  {
    NAME: 'REVERSE_CROWD + Hybrid (1.65x)',
    BASE_POSITION_SIZE: 0.045,
    MOMENTUM_MULTIPLIER: 1.889,
    RECOVERY_MULTIPLIER: 1.5,
    MIN_PAYOUT: 1.45,
    MIN_EMA_GAP: 0.15,
    CB_LOSS_THRESHOLD: 3,
    CB_COOLDOWN_MINUTES: 45,
    HYBRID_ENABLED: true,
    HYBRID_MIN_PAYOUT: 1.65,
    HYBRID_BB_PERIOD: 8,
    HYBRID_BB_LOWER: 35,
    HYBRID_BB_UPPER: 65,
    HYBRID_MOMENTUM_PERIOD: 10,
    HYBRID_MOMENTUM_BULL_THRESH: -0.5,
    HYBRID_MOMENTUM_BEAR_THRESH: 0.5,
  },
  {
    NAME: 'REVERSE_CROWD + Hybrid (1.60x)',
    BASE_POSITION_SIZE: 0.045,
    MOMENTUM_MULTIPLIER: 1.889,
    RECOVERY_MULTIPLIER: 1.5,
    MIN_PAYOUT: 1.45,
    MIN_EMA_GAP: 0.15,
    CB_LOSS_THRESHOLD: 3,
    CB_COOLDOWN_MINUTES: 45,
    HYBRID_ENABLED: true,
    HYBRID_MIN_PAYOUT: 1.60,
    HYBRID_BB_PERIOD: 8,
    HYBRID_BB_LOWER: 35,
    HYBRID_BB_UPPER: 65,
    HYBRID_MOMENTUM_PERIOD: 10,
    HYBRID_MOMENTUM_BULL_THRESH: -0.5,
    HYBRID_MOMENTUM_BEAR_THRESH: 0.5,
  },
];

const results = [];

for (const config of configs) {
  console.log(`Testing: ${config.NAME}...`);
  const result = runStrategy(config);
  results.push(result);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('📊 RESULTS:\n');
console.log('Configuration                         │   ROI    │  WR   │ Final  │  DD   │ Normal │ Cooldown │ CD WR');
console.log('──────────────────────────────────────┼──────────┼───────┼────────┼───────┼────────┼──────────┼──────');

for (const r of results) {
  const name = r.configName.padEnd(36);
  const roi = `+${r.roi}%`.padStart(8);
  const wr = `${r.winRate}%`.padStart(5);
  const final = r.finalBankroll.padStart(6);
  const dd = `${r.maxDrawdown}%`.padStart(5);
  const normal = `${r.normalTrades}`.padStart(6);
  const cooldown = `${r.cooldownTrades}`.padStart(8);
  const cdWR = r.cooldownTrades > 0 ? `${r.cooldownWR}%`.padStart(5) : '  N/A';

  console.log(`${name} │ ${roi} │ ${wr} │ ${final} │ ${dd} │ ${normal} │ ${cooldown} │ ${cdWR}`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const best = results.reduce((a, b) => parseFloat(a.roi) > parseFloat(b.roi) ? a : b);

console.log('🏆 OPTIMAL CONFIGURATION:\n');
console.log(`${best.configName}\n`);
console.log(`Performance:`);
console.log(`  ROI: +${best.roi}%`);
console.log(`  Final Bankroll: ${best.finalBankroll} BNB (from 1 BNB)`);
console.log(`  Win Rate: ${best.winRate}%`);
console.log(`  Max Drawdown: ${best.maxDrawdown}%\n`);

console.log(`Trading Stats:`);
console.log(`  Total Trades: ${best.totalTrades}`);
console.log(`  Normal Trades: ${best.normalTrades} (${best.normalWR}% WR)`);
console.log(`  Cooldown Trades: ${best.cooldownTrades} (${best.cooldownWR}% WR)`);
if (best.avgCooldownPayout > 0) {
  console.log(`  Avg Cooldown Payout: ${best.avgCooldownPayout}x`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════\n');
console.log('⚙️ OPTIMAL SETTINGS:\n');

const optimalConfig = configs.find(c => c.NAME === best.configName);

console.log('## NORMAL TRADING (REVERSE_CROWD):');
console.log(`  BASE_POSITION_SIZE: ${optimalConfig.BASE_POSITION_SIZE} (4.5% of bankroll)`);
console.log(`  MOMENTUM_MULTIPLIER: ${optimalConfig.MOMENTUM_MULTIPLIER}x (when ema_gap ≥ ${optimalConfig.MIN_EMA_GAP}%)`);
console.log(`  RECOVERY_MULTIPLIER: ${optimalConfig.RECOVERY_MULTIPLIER}x (after 2 losses)`);
console.log(`  MIN_PAYOUT: ${optimalConfig.MIN_PAYOUT}x`);
console.log(`  Strategy: Bet AGAINST EMA direction (contrarian)\n`);

console.log('## CIRCUIT BREAKER:');
console.log(`  LOSS_THRESHOLD: ${optimalConfig.CB_LOSS_THRESHOLD} consecutive losses`);
console.log(`  COOLDOWN_MINUTES: ${optimalConfig.CB_COOLDOWN_MINUTES} minutes\n`);

if (optimalConfig.HYBRID_ENABLED) {
  console.log('## HYBRID MEAN REVERSION (During Cooldown):');
  console.log(`  ENABLED: true`);
  console.log(`  MIN_PAYOUT: ${optimalConfig.HYBRID_MIN_PAYOUT}x (stricter than normal)`);
  console.log(`  BB_PERIOD: ${optimalConfig.HYBRID_BB_PERIOD} rounds`);
  console.log(`  BB_THRESHOLDS: ${optimalConfig.HYBRID_BB_LOWER}/${optimalConfig.HYBRID_BB_UPPER} (oversold/overbought)`);
  console.log(`  MOMENTUM_PERIOD: ${optimalConfig.HYBRID_MOMENTUM_PERIOD} rounds (~50 min)`);
  console.log(`  MOMENTUM_THRESHOLDS: ${optimalConfig.HYBRID_MOMENTUM_BULL_THRESH}%/${optimalConfig.HYBRID_MOMENTUM_BEAR_THRESH}%`);
  console.log(`  Logic: BB OR Momentum (either can trigger)`);
  console.log(`  Price Data: Contract close_price from settled rounds\n`);
} else {
  console.log('## HYBRID MEAN REVERSION (During Cooldown):');
  console.log(`  ENABLED: false (skip during cooldown)\n`);
}

console.log('## PAYOUT CALCULATION:');
console.log(`  Use: lock_bull_wei / lock_bear_wei (final amounts at lock)`);
console.log(`  Formula: (total * 0.97) / side_amount`);

console.log('\n════════════════════════════════════════════════════════════════════════════');
