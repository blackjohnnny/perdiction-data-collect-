import { initDatabase } from './db-init.js';

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0,
};

function calculateBollingerBands(rounds, currentIndex, period = 12) {
  const startIdx = Math.max(0, currentIndex - period + 1);
  const recentRounds = rounds.slice(startIdx, currentIndex + 1);

  if (recentRounds.length < period) return null;

  const prices = recentRounds.map(r => r.close_price);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / prices.length;
  const stdDev = Math.sqrt(variance);

  const upper = avg + (2 * stdDev);
  const lower = avg - (2 * stdDev);
  const currentPrice = recentRounds[recentRounds.length - 1].close_price;

  const position = ((currentPrice - lower) / (upper - lower)) * 100;

  return { upper, lower, avg, position, currentPrice };
}

function calculateRSI(rounds, currentIndex, period = 14) {
  const startIdx = Math.max(0, currentIndex - period);
  const recentRounds = rounds.slice(startIdx, currentIndex + 1);

  if (recentRounds.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i < recentRounds.length; i++) {
    const change = recentRounds[i].close_price - recentRounds[i - 1].close_price;
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  return rsi;
}

function runStrategy(rounds, config) {
  const {
    useCircuitBreaker = false,
    cooldownStrategy = 'skip',
    bbPeriod = 12,
    bbLowerThreshold = 20,
    bbUpperThreshold = 80,
    rsiPeriod = 14,
    rsiOversold = 30,
    rsiOverbought = 70
  } = config;

  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let wins = 0, losses = 0, skipped = 0;
  let consecutiveLosses = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;
  let cooldownUntilTimestamp = 0;
  let cbTriggered = 0;

  let cooldownTrades = 0;
  let cooldownWins = 0;
  let cooldownLosses = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const inCooldown = useCircuitBreaker && r.lock_timestamp < cooldownUntilTimestamp;

    if (inCooldown && cooldownStrategy === 'skip') {
      skipped++;
      continue;
    }

    const t20sBull = parseFloat(r.t20s_bull_wei || 0) / 1e18;
    const t20sBear = parseFloat(r.t20s_bear_wei || 0) / 1e18;
    const t20sTotal = t20sBull + t20sBear;
    if (t20sTotal === 0) continue;

    const bullPayout = (t20sTotal * 0.97) / t20sBull;
    const bearPayout = (t20sTotal * 0.97) / t20sBear;

    let signal = null;

    if (inCooldown && cooldownStrategy === 'bollinger') {
      const bb = calculateBollingerBands(rounds, i, bbPeriod);
      if (bb) {
        if (bb.position < bbLowerThreshold && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BULL';
        } else if (bb.position > bbUpperThreshold && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BEAR';
        }
      }
    } else if (inCooldown && cooldownStrategy === 'rsi') {
      const rsi = calculateRSI(rounds, i, rsiPeriod);
      if (rsi !== null) {
        if (rsi < rsiOversold && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BULL';
        } else if (rsi > rsiOverbought && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BEAR';
        }
      }
    } else {
      // NORMAL CONTRARIAN
      if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BULL';
      } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BEAR';
      }
    }

    if (!signal) {
      if (inCooldown) skipped++;
      continue;
    }

    let sizeMultiplier = 1.0;
    const emaGap = parseFloat(r.ema_gap) || 0;
    if (Math.abs(emaGap) >= 0.15) sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betAmount = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    const winner = r.winner ? r.winner.toLowerCase() : '';
    const won = (signal === 'BULL' && winner === 'bull') || (signal === 'BEAR' && winner === 'bear');

    if (won) {
      const actualPayout = parseFloat(r.winner_payout_multiple);
      const profit = betAmount * (actualPayout - 1);
      bankroll += profit;
      wins++;
      if (inCooldown) cooldownWins++;
      if (!inCooldown) consecutiveLosses = 0;
    } else {
      bankroll -= betAmount;
      losses++;
      if (inCooldown) cooldownLosses++;

      if (!inCooldown) {
        consecutiveLosses++;
        if (useCircuitBreaker && consecutiveLosses >= 3) {
          cooldownUntilTimestamp = r.lock_timestamp + (45 * 60);
          cbTriggered++;
          consecutiveLosses = 0;
        }
      }
    }

    if (inCooldown) cooldownTrades++;

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    if (bankroll > peak) peak = bankroll;
    const drawdown = ((peak - bankroll) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const roi = ((bankroll - BASE_CONFIG.STARTING_BANKROLL) / BASE_CONFIG.STARTING_BANKROLL) * 100;
  const cooldownWR = cooldownTrades > 0 ? (cooldownWins / cooldownTrades * 100) : 0;

  return {
    roi, winRate, trades: totalTrades, wins, losses, maxDrawdown, bankroll, peak,
    skipped, cbTriggered, cooldownTrades, cooldownWins, cooldownLosses, cooldownWR
  };
}

console.log('🔬 COMPREHENSIVE MEAN REVERSION OPTIMIZATION\n');
console.log('═'.repeat(120));
console.log('\nTesting MANY different threshold combinations for Bollinger Bands and RSI\n');
console.log('═'.repeat(120));

const db = initDatabase('./prediction.db');
const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`\n📊 Total rounds: ${rounds.length}\n`);
console.log('═'.repeat(120));

const results = [];

// Baseline
const baseline = runStrategy(rounds, { useCircuitBreaker: false });
results.push({ name: 'BASELINE (No CB)', ...baseline });

// Circuit Breaker (Skip)
const cbSkip = runStrategy(rounds, { useCircuitBreaker: true, cooldownStrategy: 'skip' });
results.push({ name: 'Circuit Breaker (Skip)', ...cbSkip });

console.log('\n🧪 TESTING BOLLINGER BANDS (Different thresholds & periods):\n');
console.log('─'.repeat(120));

// Test Bollinger Bands with various thresholds
const bbThresholds = [
  { lower: 15, upper: 85 },
  { lower: 20, upper: 80 },
  { lower: 25, upper: 75 },
  { lower: 30, upper: 70 },
  { lower: 35, upper: 65 },
  { lower: 40, upper: 60 },
  { lower: 45, upper: 55 },
];

const bbPeriods = [8, 10, 12, 15, 18, 20];

console.log('Config                                    │ Win Rate │   ROI    │ Final  │ MaxDD  │ CD WR  │ CD Trades');
console.log('─'.repeat(120));

for (const period of bbPeriods) {
  for (const thresh of bbThresholds) {
    const result = runStrategy(rounds, {
      useCircuitBreaker: true,
      cooldownStrategy: 'bollinger',
      bbPeriod: period,
      bbLowerThreshold: thresh.lower,
      bbUpperThreshold: thresh.upper
    });

    const name = `BB(${period}p) <${thresh.lower}% / >${thresh.upper}%`;
    results.push({ name, ...result });

    if (result.cooldownTrades > 0) {
      console.log(
        `${name.padEnd(41)} │ ${result.winRate.toFixed(1)}%`.padStart(9) + ' │ ' +
        `${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(0)}%`.padStart(8) + ' │ ' +
        `${result.bankroll.toFixed(2)}`.padStart(6) + ' │ ' +
        `${result.maxDrawdown.toFixed(1)}%`.padStart(6) + ' │ ' +
        `${result.cooldownWR.toFixed(1)}%`.padStart(6) + ' │ ' +
        `${result.cooldownTrades}`.padStart(9)
      );
    }
  }
}

console.log('\n═'.repeat(120));
console.log('\n🧪 TESTING RSI (Different thresholds & periods):\n');
console.log('─'.repeat(120));

// Test RSI with various thresholds
const rsiThresholds = [
  { oversold: 20, overbought: 80 },
  { oversold: 25, overbought: 75 },
  { oversold: 30, overbought: 70 },
  { oversold: 35, overbought: 65 },
  { oversold: 40, overbought: 60 },
  { oversold: 45, overbought: 55 },
];

const rsiPeriods = [8, 10, 12, 14, 16, 18, 20];

console.log('Config                                    │ Win Rate │   ROI    │ Final  │ MaxDD  │ CD WR  │ CD Trades');
console.log('─'.repeat(120));

for (const period of rsiPeriods) {
  for (const thresh of rsiThresholds) {
    const result = runStrategy(rounds, {
      useCircuitBreaker: true,
      cooldownStrategy: 'rsi',
      rsiPeriod: period,
      rsiOversold: thresh.oversold,
      rsiOverbought: thresh.overbought
    });

    const name = `RSI(${period}p) <${thresh.oversold} / >${thresh.overbought}`;
    results.push({ name, ...result });

    if (result.cooldownTrades > 0) {
      console.log(
        `${name.padEnd(41)} │ ${result.winRate.toFixed(1)}%`.padStart(9) + ' │ ' +
        `${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(0)}%`.padStart(8) + ' │ ' +
        `${result.bankroll.toFixed(2)}`.padStart(6) + ' │ ' +
        `${result.maxDrawdown.toFixed(1)}%`.padStart(6) + ' │ ' +
        `${result.cooldownWR.toFixed(1)}%`.padStart(6) + ' │ ' +
        `${result.cooldownTrades}`.padStart(9)
      );
    }
  }
}

console.log('\n' + '═'.repeat(120));
console.log('\n🏆 TOP 10 BY ROI:\n');
console.log('─'.repeat(120));

const top10ROI = results.sort((a, b) => b.roi - a.roi).slice(0, 10);

console.log('Rank │ Strategy                                      │ Win Rate │   ROI    │ Final  │ MaxDD  │ CD WR');
console.log('─'.repeat(120));

for (let i = 0; i < top10ROI.length; i++) {
  const r = top10ROI[i];
  const rank = String(i + 1).padStart(2);
  const name = r.name.padEnd(45);
  const wr = `${r.winRate.toFixed(1)}%`.padStart(8);
  const roi = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(0)}%`.padStart(8);
  const final = `${r.bankroll.toFixed(2)}`.padStart(6);
  const dd = `${r.maxDrawdown.toFixed(1)}%`.padStart(6);
  const cdWR = r.cooldownTrades > 0 ? `${r.cooldownWR.toFixed(1)}%`.padStart(6) : '   -  ';

  console.log(`${rank}   │ ${name} │ ${wr} │ ${roi} │ ${final} │ ${dd} │ ${cdWR}`);
}

console.log('\n' + '═'.repeat(120));
console.log('\n🎯 BEST COOLDOWN WIN RATE:\n');
console.log('─'.repeat(120));

const withCooldown = results.filter(r => r.cooldownTrades >= 5); // At least 5 cooldown trades
const bestCooldownWR = withCooldown.sort((a, b) => b.cooldownWR - a.cooldownWR).slice(0, 5);

if (bestCooldownWR.length > 0) {
  console.log('\nTop 5 by Cooldown Win Rate (min 5 cooldown trades):\n');

  for (let i = 0; i < bestCooldownWR.length; i++) {
    const r = bestCooldownWR[i];
    console.log(`${i + 1}. ${r.name}`);
    console.log(`   Cooldown WR: ${r.cooldownWR.toFixed(1)}% (${r.cooldownWins}W/${r.cooldownLosses}L) - ${r.cooldownTrades} trades`);
    console.log(`   Overall: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(0)}% ROI | ${r.winRate.toFixed(1)}% WR | ${r.maxDrawdown.toFixed(1)}% DD`);
    console.log();
  }
} else {
  console.log('\n❌ No strategies had >= 5 cooldown trades\n');
}

console.log('═'.repeat(120));
console.log('\n💡 FINAL ANALYSIS:\n');
console.log('─'.repeat(120));

const best = top10ROI[0];

console.log(`\nCircuit Breaker (Skip): ${cbSkip.roi >= 0 ? '+' : ''}${cbSkip.roi.toFixed(0)}% ROI | ${cbSkip.winRate.toFixed(1)}% WR | ${cbSkip.maxDrawdown.toFixed(1)}% DD`);
console.log(`Best Strategy:          ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(0)}% ROI | ${best.winRate.toFixed(1)}% WR | ${best.maxDrawdown.toFixed(1)}% DD`);
console.log(`                        ${best.name}`);

if (best.cooldownTrades > 0) {
  console.log(`                        Cooldown: ${best.cooldownWR.toFixed(1)}% WR (${best.cooldownTrades} trades)`);
}

if (best.roi > cbSkip.roi) {
  console.log(`\n✅ MEAN REVERSION BEATS SKIPPING BY ${(best.roi - cbSkip.roi).toFixed(1)}%!`);
} else {
  console.log(`\n❌ Skipping is still best (beats mean reversion by ${(cbSkip.roi - best.roi).toFixed(1)}%)`);
}

console.log('\n' + '═'.repeat(120));

db.close();
