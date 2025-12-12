import { initDatabase } from './db-init.js';

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0,
};

function calculateBollingerBands(rounds, currentIndex, period = 12, stdDevMultiplier = 2.0) {
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

  return { upper, lower, avg, position, currentPrice, stdDev };
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

    // BB settings
    bbPeriod = 8,
    bbStdDev = 2.0,
    bbLowerThreshold = 30,
    bbUpperThreshold = 70,

    // RSI settings
    rsiPeriod = 14,
    rsiOversold = 30,
    rsiOverbought = 70,

    // Combo settings
    requireBothIndicators = false,

    // Position sizing during cooldown
    cooldownPositionMultiplier = 1.0,

    // Confidence-based sizing
    useConfidenceSizing = false
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
    let confidence = 1.0; // For confidence-based position sizing

    if (inCooldown && (cooldownStrategy === 'bollinger' || cooldownStrategy === 'combo')) {
      const bb = calculateBollingerBands(rounds, i, bbPeriod, bbStdDev);
      let bbSignal = null;
      let bbConfidence = 0;

      if (bb) {
        if (bb.position < bbLowerThreshold && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
          bbSignal = 'BULL';
          // More extreme = higher confidence
          bbConfidence = (bbLowerThreshold - bb.position) / bbLowerThreshold;
        } else if (bb.position > bbUpperThreshold && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
          bbSignal = 'BEAR';
          bbConfidence = (bb.position - bbUpperThreshold) / (100 - bbUpperThreshold);
        }
      }

      if (cooldownStrategy === 'combo' && requireBothIndicators) {
        // Require BOTH BB and RSI to agree
        const rsi = calculateRSI(rounds, i, rsiPeriod);
        let rsiSignal = null;
        let rsiConfidence = 0;

        if (rsi !== null) {
          if (rsi < rsiOversold && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
            rsiSignal = 'BULL';
            rsiConfidence = (rsiOversold - rsi) / rsiOversold;
          } else if (rsi > rsiOverbought && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
            rsiSignal = 'BEAR';
            rsiConfidence = (rsi - rsiOverbought) / (100 - rsiOverbought);
          }
        }

        // Both must agree
        if (bbSignal === rsiSignal && bbSignal !== null) {
          signal = bbSignal;
          confidence = (bbConfidence + rsiConfidence) / 2;
        }
      } else {
        // Just use BB signal
        signal = bbSignal;
        confidence = bbConfidence;
      }
    } else if (inCooldown && cooldownStrategy === 'rsi') {
      const rsi = calculateRSI(rounds, i, rsiPeriod);
      if (rsi !== null) {
        if (rsi < rsiOversold && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BULL';
          confidence = (rsiOversold - rsi) / rsiOversold;
        } else if (rsi > rsiOverbought && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BEAR';
          confidence = (rsi - rsiOverbought) / (100 - rsiOverbought);
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

    // Position sizing
    let sizeMultiplier = 1.0;

    if (!inCooldown) {
      // Normal sizing
      const emaGap = parseFloat(r.ema_gap) || 0;
      if (Math.abs(emaGap) >= 0.15) sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
      if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
        sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
      }
    } else {
      // Cooldown sizing
      sizeMultiplier = cooldownPositionMultiplier;

      // Confidence-based sizing
      if (useConfidenceSizing) {
        sizeMultiplier *= (0.5 + confidence); // Scale between 0.5x and 1.5x based on confidence
      }
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

console.log('🚀 ULTIMATE OPTIMIZATION: PUSH TO THE LIMIT\n');
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
const cbSkip = runStrategy(rounds, { useCircuitBreaker: true, cooldownStrategy: 'skip' });
results.push({ name: 'Circuit Breaker (Skip)', ...cbSkip });

// Current best
const currentBest = runStrategy(rounds, {
  useCircuitBreaker: true,
  cooldownStrategy: 'bollinger',
  bbPeriod: 8,
  bbLowerThreshold: 30,
  bbUpperThreshold: 70
});
results.push({ name: 'Current Best (BB 8p 30/70)', ...currentBest });

console.log('\n🧪 TEST 1: DIFFERENT BB STANDARD DEVIATIONS\n');
console.log('─'.repeat(120));

for (const stdDev of [1.5, 1.75, 2.0, 2.25, 2.5]) {
  const result = runStrategy(rounds, {
    useCircuitBreaker: true,
    cooldownStrategy: 'bollinger',
    bbPeriod: 8,
    bbStdDev: stdDev,
    bbLowerThreshold: 30,
    bbUpperThreshold: 70
  });
  results.push({ name: `BB(8p, ${stdDev}σ) 30/70`, ...result });

  if (result.cooldownTrades > 0) {
    console.log(`BB ${stdDev}σ: ROI ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(0)}% | WR ${result.winRate.toFixed(1)}% | DD ${result.maxDrawdown.toFixed(1)}% | CD WR ${result.cooldownWR.toFixed(1)}% (${result.cooldownTrades} trades)`);
  }
}

console.log('\n🧪 TEST 2: COMBINE BB + RSI (BOTH MUST AGREE)\n');
console.log('─'.repeat(120));

const comboConfigs = [
  { bbThresh: [30, 70], rsiThresh: [30, 70] },
  { bbThresh: [30, 70], rsiThresh: [35, 65] },
  { bbThresh: [35, 65], rsiThresh: [30, 70] },
  { bbThresh: [35, 65], rsiThresh: [35, 65] },
  { bbThresh: [40, 60], rsiThresh: [40, 60] },
];

for (const cfg of comboConfigs) {
  const result = runStrategy(rounds, {
    useCircuitBreaker: true,
    cooldownStrategy: 'combo',
    requireBothIndicators: true,
    bbPeriod: 8,
    bbLowerThreshold: cfg.bbThresh[0],
    bbUpperThreshold: cfg.bbThresh[1],
    rsiPeriod: 14,
    rsiOversold: cfg.rsiThresh[0],
    rsiOverbought: cfg.rsiThresh[1]
  });
  results.push({ name: `BB+RSI: ${cfg.bbThresh[0]}/${cfg.bbThresh[1]} & RSI ${cfg.rsiThresh[0]}/${cfg.rsiThresh[1]}`, ...result });

  if (result.cooldownTrades > 0) {
    console.log(`BB ${cfg.bbThresh[0]}/${cfg.bbThresh[1]} + RSI ${cfg.rsiThresh[0]}/${cfg.rsiThresh[1]}: ROI ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(0)}% | CD WR ${result.cooldownWR.toFixed(1)}% (${result.cooldownTrades} trades)`);
  }
}

console.log('\n🧪 TEST 3: POSITION SIZING DURING COOLDOWN\n');
console.log('─'.repeat(120));

for (const multiplier of [0.5, 0.75, 1.0, 1.25, 1.5]) {
  const result = runStrategy(rounds, {
    useCircuitBreaker: true,
    cooldownStrategy: 'bollinger',
    bbPeriod: 8,
    bbLowerThreshold: 30,
    bbUpperThreshold: 70,
    cooldownPositionMultiplier: multiplier
  });
  results.push({ name: `BB 30/70 (CD Size: ${multiplier}x)`, ...result });

  if (result.cooldownTrades > 0) {
    console.log(`CD Position ${multiplier}x: ROI ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(0)}% | WR ${result.winRate.toFixed(1)}% | DD ${result.maxDrawdown.toFixed(1)}% | Final ${result.bankroll.toFixed(2)} BNB`);
  }
}

console.log('\n🧪 TEST 4: CONFIDENCE-BASED SIZING\n');
console.log('─'.repeat(120));

const withConfidence = runStrategy(rounds, {
  useCircuitBreaker: true,
  cooldownStrategy: 'bollinger',
  bbPeriod: 8,
  bbLowerThreshold: 30,
  bbUpperThreshold: 70,
  useConfidenceSizing: true
});
results.push({ name: 'BB 30/70 (Confidence Sizing)', ...withConfidence });

console.log(`Without Confidence: ROI ${currentBest.roi >= 0 ? '+' : ''}${currentBest.roi.toFixed(0)}% | CD WR ${currentBest.cooldownWR.toFixed(1)}%`);
console.log(`WITH Confidence:    ROI ${withConfidence.roi >= 0 ? '+' : ''}${withConfidence.roi.toFixed(0)}% | CD WR ${withConfidence.cooldownWR.toFixed(1)}%`);
console.log(`Improvement:        ${withConfidence.roi - currentBest.roi >= 0 ? '+' : ''}${(withConfidence.roi - currentBest.roi).toFixed(1)}%`);

console.log('\n🧪 TEST 5: DIFFERENT BB PERIODS WITH OPTIMAL THRESHOLDS\n');
console.log('─'.repeat(120));

for (const period of [6, 7, 8, 9, 10]) {
  for (const thresholds of [[25, 75], [30, 70], [35, 65]]) {
    const result = runStrategy(rounds, {
      useCircuitBreaker: true,
      cooldownStrategy: 'bollinger',
      bbPeriod: period,
      bbLowerThreshold: thresholds[0],
      bbUpperThreshold: thresholds[1]
    });

    if (result.cooldownTrades >= 20 && result.roi > 550) {
      results.push({ name: `BB(${period}p) ${thresholds[0]}/${thresholds[1]}`, ...result });
      console.log(`BB(${period}p) ${thresholds[0]}/${thresholds[1]}: ROI ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(0)}% | WR ${result.winRate.toFixed(1)}% | CD WR ${result.cooldownWR.toFixed(1)}% (${result.cooldownTrades} trades)`);
    }
  }
}

console.log('\n' + '═'.repeat(120));
console.log('\n🏆 FINAL TOP 10:\n');
console.log('─'.repeat(120));

const top10 = results.sort((a, b) => b.roi - a.roi).slice(0, 10);

console.log('Rank │ Strategy                                           │   ROI    │ Win Rate │ Final  │ MaxDD  │ CD WR');
console.log('─'.repeat(120));

for (let i = 0; i < top10.length; i++) {
  const r = top10[i];
  const rank = String(i + 1).padStart(2);
  const name = r.name.padEnd(50);
  const roi = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(0)}%`.padStart(8);
  const wr = `${r.winRate.toFixed(1)}%`.padStart(8);
  const final = `${r.bankroll.toFixed(2)}`.padStart(6);
  const dd = `${r.maxDrawdown.toFixed(1)}%`.padStart(6);
  const cdWR = r.cooldownTrades > 0 ? `${r.cooldownWR.toFixed(1)}%`.padStart(6) : '   -  ';

  console.log(`${rank}   │ ${name} │ ${roi} │ ${wr} │ ${final} │ ${dd} │ ${cdWR}`);
}

console.log('\n' + '═'.repeat(120));
console.log('\n🎯 ULTIMATE CHAMPION:\n');
console.log('─'.repeat(120));

const champion = top10[0];

console.log(`\n${champion.name}\n`);
console.log(`   ROI: ${champion.roi >= 0 ? '+' : ''}${champion.roi.toFixed(1)}%`);
console.log(`   Win Rate: ${champion.winRate.toFixed(1)}% (${champion.wins}W / ${champion.losses}L)`);
console.log(`   Peak: ${champion.peak.toFixed(2)} BNB | Final: ${champion.bankroll.toFixed(2)} BNB`);
console.log(`   Max Drawdown: ${champion.maxDrawdown.toFixed(1)}%`);
if (champion.cooldownTrades > 0) {
  console.log(`   Cooldown Performance: ${champion.cooldownWR.toFixed(1)}% WR (${champion.cooldownWins}W/${champion.cooldownLosses}L) - ${champion.cooldownTrades} trades`);
}

console.log(`\n   Improvement over Skip: ${champion.roi - cbSkip.roi >= 0 ? '+' : ''}${(champion.roi - cbSkip.roi).toFixed(1)}% ROI`);
console.log(`   Improvement over Current Best: ${champion.roi - currentBest.roi >= 0 ? '+' : ''}${(champion.roi - currentBest.roi).toFixed(1)}% ROI`);

console.log('\n' + '═'.repeat(120));

db.close();
