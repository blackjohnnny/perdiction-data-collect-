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

  // Position as percentage (0-100)
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
    cooldownStrategy = 'skip', // 'skip', 'bollinger', 'rsi'
    bbPeriod = 12,
    rsiPeriod = 14
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

    // If in cooldown and strategy is 'skip', skip the trade
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

    // Determine strategy based on cooldown status
    if (inCooldown && cooldownStrategy === 'bollinger') {
      // BOLLINGER BANDS MEAN REVERSION
      const bb = calculateBollingerBands(rounds, i, bbPeriod);
      if (bb) {
        // Oversold (price near lower band) -> Buy (BULL)
        if (bb.position < 20 && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BULL';
        }
        // Overbought (price near upper band) -> Sell (BEAR)
        else if (bb.position > 80 && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BEAR';
        }
      }
    } else if (inCooldown && cooldownStrategy === 'rsi') {
      // RSI MEAN REVERSION
      const rsi = calculateRSI(rounds, i, rsiPeriod);
      if (rsi !== null) {
        // Oversold (RSI < 30) -> Buy (BULL)
        if (rsi < 30 && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BULL';
        }
        // Overbought (RSI > 70) -> Sell (BEAR)
        else if (rsi > 70 && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BEAR';
        }
      }
    } else {
      // NORMAL CONTRARIAN STRATEGY
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

    // Position sizing
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
    skipped, cbTriggered,
    cooldownTrades, cooldownWins, cooldownLosses, cooldownWR
  };
}

console.log('🔥 CIRCUIT BREAKER + MEAN REVERSION DURING COOLDOWN\n');
console.log('═'.repeat(120));
console.log('\nIdea: Use MEAN REVERSION (Bollinger Bands, RSI) during cooldown instead of skipping!\n');
console.log('═'.repeat(120));

const db = initDatabase('./prediction.db');
const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`\n📊 Total rounds: ${rounds.length}\n`);
console.log('═'.repeat(120));

// Test different mean reversion configurations
const strategies = [
  { name: 'BASELINE (No Circuit Breaker)', useCircuitBreaker: false },
  { name: 'Circuit Breaker (Skip)', useCircuitBreaker: true, cooldownStrategy: 'skip' },
];

// Test Bollinger Bands with different periods
for (const period of [8, 10, 12, 15, 18]) {
  strategies.push({
    name: `CB + Bollinger Bands (${period} periods)`,
    useCircuitBreaker: true,
    cooldownStrategy: 'bollinger',
    bbPeriod: period
  });
}

// Test RSI with different periods
for (const period of [10, 12, 14, 16, 18]) {
  strategies.push({
    name: `CB + RSI (${period} periods)`,
    useCircuitBreaker: true,
    cooldownStrategy: 'rsi',
    rsiPeriod: period
  });
}

console.log('\n🧪 TESTING STRATEGIES:\n');
console.log('─'.repeat(120));

console.log('Strategy                              │ Win Rate │   ROI    │  Peak  │ Final  │ MaxDD  │ Trades │ CD WR  │ CD Trades');
console.log('─'.repeat(120));

const results = [];

for (const strat of strategies) {
  const result = runStrategy(rounds, strat);
  results.push({ name: strat.name, ...result });

  const name = strat.name.padEnd(37);
  const wr = `${result.winRate.toFixed(1)}%`.padStart(8);
  const roi = `${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(0)}%`.padStart(8);
  const peak = `${result.peak.toFixed(2)}`.padStart(6);
  const final = `${result.bankroll.toFixed(2)}`.padStart(6);
  const dd = `${result.maxDrawdown.toFixed(1)}%`.padStart(6);
  const trades = String(result.trades).padStart(6);
  const cdWR = result.cooldownTrades > 0 ? `${result.cooldownWR.toFixed(1)}%`.padStart(6) : '   -  ';
  const cdTrades = result.cooldownTrades > 0 ? String(result.cooldownTrades).padStart(9) : '     -   ';

  console.log(`${name} │ ${wr} │ ${roi} │ ${peak} │ ${final} │ ${dd} │ ${trades} │ ${cdWR} │ ${cdTrades}`);
}

console.log('\n' + '═'.repeat(120));
console.log('\n🏆 TOP 5 BY ROI:\n');
console.log('─'.repeat(120));

const topByROI = results.sort((a, b) => b.roi - a.roi).slice(0, 5);

for (let i = 0; i < topByROI.length; i++) {
  const r = topByROI[i];
  console.log(`${i + 1}. ${r.name}`);
  console.log(`   ROI: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}% | WR: ${r.winRate.toFixed(1)}% | MaxDD: ${r.maxDrawdown.toFixed(1)}%`);
  console.log(`   Peak: ${r.peak.toFixed(2)} BNB | Final: ${r.bankroll.toFixed(2)} BNB`);
  if (r.cooldownTrades > 0) {
    console.log(`   Cooldown: ${r.cooldownWR.toFixed(1)}% WR (${r.cooldownWins}W/${r.cooldownLosses}L) - ${r.cooldownTrades} trades`);
  }
  console.log();
}

console.log('═'.repeat(120));
console.log('\n🎯 BEST COOLDOWN STRATEGY:\n');
console.log('─'.repeat(120));

const withCooldownStrats = results.filter(r => r.cooldownTrades > 0);
const bestCooldown = withCooldownStrats.sort((a, b) => b.cooldownWR - a.cooldownWR)[0];

if (bestCooldown) {
  console.log(`\nBest Cooldown Performance: ${bestCooldown.name}`);
  console.log(`   Cooldown Win Rate: ${bestCooldown.cooldownWR.toFixed(1)}% (${bestCooldown.cooldownWins}W/${bestCooldown.cooldownLosses}L)`);
  console.log(`   Overall ROI: ${bestCooldown.roi >= 0 ? '+' : ''}${bestCooldown.roi.toFixed(1)}%`);
  console.log(`   Overall Win Rate: ${bestCooldown.winRate.toFixed(1)}%`);
}

console.log('\n' + '═'.repeat(120));
console.log('\n💡 ANALYSIS:\n');

const cbSkip = results.find(r => r.name === 'Circuit Breaker (Skip)');
const bestOverall = topByROI[0];

console.log(`Circuit Breaker (Skip):  ${cbSkip.roi >= 0 ? '+' : ''}${cbSkip.roi.toFixed(0)}% ROI | ${cbSkip.winRate.toFixed(1)}% WR | ${cbSkip.maxDrawdown.toFixed(1)}% DD`);
console.log(`Best Overall:            ${bestOverall.roi >= 0 ? '+' : ''}${bestOverall.roi.toFixed(0)}% ROI | ${bestOverall.winRate.toFixed(1)}% WR | ${bestOverall.maxDrawdown.toFixed(1)}% DD`);

if (bestOverall.roi > cbSkip.roi) {
  console.log(`\n✅ Mean Reversion during cooldown WORKS!`);
  console.log(`   Improvement: ${bestOverall.roi - cbSkip.roi >= 0 ? '+' : ''}${(bestOverall.roi - cbSkip.roi).toFixed(1)}% ROI`);
} else {
  console.log(`\n❌ Mean Reversion during cooldown doesn't beat skipping`);
  console.log(`   Difference: ${bestOverall.roi - cbSkip.roi >= 0 ? '+' : ''}${(bestOverall.roi - cbSkip.roi).toFixed(1)}% ROI`);
}

console.log('\n' + '═'.repeat(120));

db.close();
