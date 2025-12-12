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

function calculateVolatility(rounds, currentIndex, period = 12) {
  const startIdx = Math.max(0, currentIndex - period + 1);
  const recentRounds = rounds.slice(startIdx, currentIndex + 1);
  if (recentRounds.length < period) return null;

  const prices = recentRounds.map(r => r.close_price);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / prices.length;
  const volatility = Math.sqrt(variance) / avg * 100;

  return volatility;
}

function runStrategy(rounds, config) {
  const {
    useCircuitBreaker = false,
    cooldownStrategy = 'skip',

    // BB settings
    bbPeriod = 8,
    bbLowerThreshold = 30,
    bbUpperThreshold = 70,

    // Position sizing
    cooldownPositionMultiplier = 1.0,

    // Momentum settings
    momentumPeriod = 10,
    momentumBullThreshold = -1.0, // Negative momentum = oversold
    momentumBearThreshold = 1.0,   // Positive momentum = overbought

    // Adaptive settings
    useAdaptiveThresholds = false,
  } = config;

  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let wins = 0, losses = 0, skipped = 0;
  let consecutiveLosses = 0;
  let lastTwoResults = [];
  let peak = bankroll;
  let maxDrawdown = 0;
  let cooldownUntilTimestamp = 0;
  let cbTriggered = 0;
  let cooldownTrades = 0, cooldownWins = 0, cooldownLosses = 0;

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
      let lowerThresh = bbLowerThreshold;
      let upperThresh = bbUpperThreshold;

      // Adaptive thresholds based on volatility
      if (useAdaptiveThresholds) {
        const volatility = calculateVolatility(rounds, i, 12);
        if (volatility !== null) {
          // High volatility = wider thresholds (more trades)
          // Low volatility = tighter thresholds (fewer trades)
          if (volatility > 1.5) {
            lowerThresh += 10;
            upperThresh -= 10;
          } else if (volatility < 0.5) {
            lowerThresh -= 10;
            upperThresh += 10;
          }
        }
      }

      const bb = calculateBollingerBands(rounds, i, bbPeriod);
      if (bb) {
        if (bb.position < lowerThresh && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BULL';
        } else if (bb.position > upperThresh && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BEAR';
        }
      }
    } else if (inCooldown && cooldownStrategy === 'momentum') {
      const momentum = calculateMomentum(rounds, i, momentumPeriod);
      if (momentum !== null) {
        // Negative momentum (falling) = buy (expect reversal up)
        if (momentum < momentumBullThreshold && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BULL';
        }
        // Positive momentum (rising) = sell (expect reversal down)
        else if (momentum > momentumBearThreshold && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
          signal = 'BEAR';
        }
      }
    } else if (inCooldown && cooldownStrategy === 'hybrid') {
      // Hybrid: Use BOTH BB and Momentum (either can trigger)
      const bb = calculateBollingerBands(rounds, i, bbPeriod);
      const momentum = calculateMomentum(rounds, i, momentumPeriod);

      if (bb && bb.position < bbLowerThreshold && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BULL';
      } else if (bb && bb.position > bbUpperThreshold && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BEAR';
      } else if (momentum !== null && momentum < momentumBullThreshold && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BULL';
      } else if (momentum !== null && momentum > momentumBearThreshold && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BEAR';
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
      const emaGap = parseFloat(r.ema_gap) || 0;
      if (Math.abs(emaGap) >= 0.15) sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
      if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
        sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
      }
    } else {
      sizeMultiplier = cooldownPositionMultiplier;
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

console.log('🔥 EXTREME OPTIMIZATION: LESS STRICT + NEW FILTERS\n');
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

// Current champion
const champion = runStrategy(rounds, {
  useCircuitBreaker: true,
  cooldownStrategy: 'bollinger',
  bbPeriod: 8,
  bbLowerThreshold: 30,
  bbUpperThreshold: 70,
  cooldownPositionMultiplier: 1.5
});
results.push({ name: 'Current Champion (BB 30/70, 1.5x)', ...champion });

console.log('\n🧪 TEST 1: LESS STRICT BB THRESHOLDS (More Trades)\n');
console.log('─'.repeat(120));

const lessStrictThresholds = [
  [35, 65], [40, 60], [45, 55], [50, 50]
];

for (const [lower, upper] of lessStrictThresholds) {
  for (const sizeMultiplier of [1.0, 1.25, 1.5, 1.75, 2.0]) {
    const result = runStrategy(rounds, {
      useCircuitBreaker: true,
      cooldownStrategy: 'bollinger',
      bbPeriod: 8,
      bbLowerThreshold: lower,
      bbUpperThreshold: upper,
      cooldownPositionMultiplier: sizeMultiplier
    });

    if (result.cooldownTrades >= 20) {
      results.push({ name: `BB ${lower}/${upper} (${sizeMultiplier}x)`, ...result });

      if (result.roi > 550) {
        console.log(`BB ${lower}/${upper} (${sizeMultiplier}x): ROI ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(0)}% | CD WR ${result.cooldownWR.toFixed(1)}% (${result.cooldownTrades}t) | Final ${result.bankroll.toFixed(2)} BNB`);
      }
    }
  }
}

console.log('\n🧪 TEST 2: MOMENTUM-BASED MEAN REVERSION\n');
console.log('─'.repeat(120));

const momentumConfigs = [
  { period: 8, bullThresh: -0.5, bearThresh: 0.5 },
  { period: 8, bullThresh: -1.0, bearThresh: 1.0 },
  { period: 8, bullThresh: -1.5, bearThresh: 1.5 },
  { period: 10, bullThresh: -0.5, bearThresh: 0.5 },
  { period: 10, bullThresh: -1.0, bearThresh: 1.0 },
  { period: 10, bullThresh: -1.5, bearThresh: 1.5 },
  { period: 12, bullThresh: -1.0, bearThresh: 1.0 },
  { period: 12, bullThresh: -2.0, bearThresh: 2.0 },
];

for (const cfg of momentumConfigs) {
  for (const sizeMultiplier of [1.0, 1.5, 2.0]) {
    const result = runStrategy(rounds, {
      useCircuitBreaker: true,
      cooldownStrategy: 'momentum',
      momentumPeriod: cfg.period,
      momentumBullThreshold: cfg.bullThresh,
      momentumBearThreshold: cfg.bearThresh,
      cooldownPositionMultiplier: sizeMultiplier
    });

    if (result.cooldownTrades >= 10) {
      results.push({ name: `Momentum(${cfg.period}p) ${cfg.bullThresh}/${cfg.bearThresh} (${sizeMultiplier}x)`, ...result });

      if (result.roi > 500) {
        console.log(`Mom(${cfg.period}p) ${cfg.bullThresh}/${cfg.bearThresh} (${sizeMultiplier}x): ROI ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(0)}% | CD WR ${result.cooldownWR.toFixed(1)}% (${result.cooldownTrades}t) | Final ${result.bankroll.toFixed(2)} BNB`);
      }
    }
  }
}

console.log('\n🧪 TEST 3: HYBRID (BB OR Momentum - Either Can Trigger)\n');
console.log('─'.repeat(120));

const hybridConfigs = [
  { bbThresh: [30, 70], momThresh: [-1.0, 1.0], size: 1.5 },
  { bbThresh: [35, 65], momThresh: [-1.0, 1.0], size: 1.5 },
  { bbThresh: [40, 60], momThresh: [-1.0, 1.0], size: 1.5 },
  { bbThresh: [30, 70], momThresh: [-0.5, 0.5], size: 1.5 },
  { bbThresh: [30, 70], momThresh: [-1.5, 1.5], size: 1.5 },
  { bbThresh: [35, 65], momThresh: [-0.5, 0.5], size: 1.75 },
  { bbThresh: [35, 65], momThresh: [-1.0, 1.0], size: 1.75 },
  { bbThresh: [40, 60], momThresh: [-1.0, 1.0], size: 2.0 },
];

for (const cfg of hybridConfigs) {
  const result = runStrategy(rounds, {
    useCircuitBreaker: true,
    cooldownStrategy: 'hybrid',
    bbPeriod: 8,
    bbLowerThreshold: cfg.bbThresh[0],
    bbUpperThreshold: cfg.bbThresh[1],
    momentumPeriod: 10,
    momentumBullThreshold: cfg.momThresh[0],
    momentumBearThreshold: cfg.momThresh[1],
    cooldownPositionMultiplier: cfg.size
  });

  results.push({ name: `Hybrid: BB ${cfg.bbThresh[0]}/${cfg.bbThresh[1]} OR Mom ${cfg.momThresh[0]}/${cfg.momThresh[1]} (${cfg.size}x)`, ...result });

  if (result.cooldownTrades >= 20 && result.roi > 550) {
    console.log(`BB ${cfg.bbThresh[0]}/${cfg.bbThresh[1]} OR Mom ${cfg.momThresh[0]}/${cfg.momThresh[1]} (${cfg.size}x): ROI ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(0)}% | CD WR ${result.cooldownWR.toFixed(1)}% (${result.cooldownTrades}t)`);
  }
}

console.log('\n🧪 TEST 4: ADAPTIVE BB THRESHOLDS (Based on Volatility)\n');
console.log('─'.repeat(120));

for (const baseThresh of [[30, 70], [35, 65], [40, 60]]) {
  for (const sizeMultiplier of [1.5, 1.75, 2.0]) {
    const result = runStrategy(rounds, {
      useCircuitBreaker: true,
      cooldownStrategy: 'bollinger',
      bbPeriod: 8,
      bbLowerThreshold: baseThresh[0],
      bbUpperThreshold: baseThresh[1],
      cooldownPositionMultiplier: sizeMultiplier,
      useAdaptiveThresholds: true
    });

    results.push({ name: `Adaptive BB ${baseThresh[0]}/${baseThresh[1]} (${sizeMultiplier}x)`, ...result });

    if (result.cooldownTrades >= 20 && result.roi > 550) {
      console.log(`Adaptive BB ${baseThresh[0]}/${baseThresh[1]} (${sizeMultiplier}x): ROI ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(0)}% | CD WR ${result.cooldownWR.toFixed(1)}% (${result.cooldownTrades}t)`);
    }
  }
}

console.log('\n' + '═'.repeat(120));
console.log('\n🏆 FINAL TOP 15:\n');
console.log('─'.repeat(120));

const top15 = results.sort((a, b) => b.roi - a.roi).slice(0, 15);

console.log('Rank │ Strategy                                                         │   ROI    │  WR   │ Final  │  DD   │ CD WR │ CD T');
console.log('─'.repeat(120));

for (let i = 0; i < top15.length; i++) {
  const r = top15[i];
  const rank = String(i + 1).padStart(2);
  const name = r.name.padEnd(64);
  const roi = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(0)}%`.padStart(8);
  const wr = `${r.winRate.toFixed(1)}%`.padStart(6);
  const final = `${r.bankroll.toFixed(2)}`.padStart(6);
  const dd = `${r.maxDrawdown.toFixed(1)}%`.padStart(6);
  const cdWR = r.cooldownTrades > 0 ? `${r.cooldownWR.toFixed(1)}%`.padStart(6) : '   -  ';
  const cdT = r.cooldownTrades > 0 ? String(r.cooldownTrades).padStart(4) : '  - ';

  console.log(`${rank}   │ ${name} │ ${roi} │ ${wr} │ ${final} │ ${dd} │ ${cdWR} │ ${cdT}`);
}

console.log('\n' + '═'.repeat(120));
console.log('\n🎯 NEW CHAMPION:\n');
console.log('─'.repeat(120));

const newChampion = top15[0];

console.log(`\n${newChampion.name}\n`);
console.log(`   ROI: ${newChampion.roi >= 0 ? '+' : ''}${newChampion.roi.toFixed(1)}%`);
console.log(`   Win Rate: ${newChampion.winRate.toFixed(1)}% (${newChampion.wins}W / ${newChampion.losses}L)`);
console.log(`   Peak: ${newChampion.peak.toFixed(2)} BNB | Final: ${newChampion.bankroll.toFixed(2)} BNB`);
console.log(`   Max Drawdown: ${newChampion.maxDrawdown.toFixed(1)}%`);
if (newChampion.cooldownTrades > 0) {
  console.log(`   Cooldown: ${newChampion.cooldownWR.toFixed(1)}% WR (${newChampion.cooldownWins}W/${newChampion.cooldownLosses}L) - ${newChampion.cooldownTrades} trades`);
}

console.log(`\n   Improvement over Previous Champion: ${newChampion.roi - champion.roi >= 0 ? '+' : ''}${(newChampion.roi - champion.roi).toFixed(1)}% ROI`);
console.log(`   Final Bankroll: ${newChampion.bankroll.toFixed(2)} BNB (vs ${champion.bankroll.toFixed(2)} BNB)`);

console.log('\n' + '═'.repeat(120));

db.close();
