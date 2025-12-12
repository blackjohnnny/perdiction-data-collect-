import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🚀 TESTING FASTER INDICATORS TO FIX EMA LAG\n');
console.log('═'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Testing on ${rounds.length} complete rounds\n`);
console.log('Problem: EMA 3/7 on 5min candles is too slow, causes entries right before reversals\n');
console.log('Solution: Use faster confirmation signals\n');
console.log('─'.repeat(100) + '\n');

function getPrice(r) {
  const lock = parseFloat(r.lock_price);
  return lock > 1000000 ? lock / 1e8 : lock;
}

// Simulate faster EMA (EMA 2/4 instead of 3/7)
function calculateFastEMA(rounds, index, shortPeriod = 2, longPeriod = 4) {
  if (index < longPeriod) return { signal: 'NEUTRAL', gap: 0 };

  const prices = rounds.slice(Math.max(0, index - longPeriod + 1), index + 1).map(r => getPrice(r));

  const shortEMA = prices.slice(-shortPeriod).reduce((a, b) => a + b, 0) / shortPeriod;
  const longEMA = prices.reduce((a, b) => a + b, 0) / longPeriod;

  const gap = ((shortEMA - longEMA) / longEMA) * 100;

  let signal = 'NEUTRAL';
  if (gap > 0.05) signal = 'BULL';
  else if (gap < -0.05) signal = 'BEAR';

  return { signal, gap };
}

// Price ROC (Rate of Change) - very responsive
function calculateROC(rounds, index, period = 2) {
  if (index < period) return 0;

  const currentPrice = getPrice(rounds[index]);
  const oldPrice = getPrice(rounds[index - period]);

  return ((currentPrice - oldPrice) / oldPrice) * 100;
}

// Check if EMA and faster indicator AGREE
function bothAgree(emaSignal, fasterSignal) {
  return emaSignal === fasterSignal && fasterSignal !== 'NEUTRAL';
}

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0
};

const strategies = [
  {
    name: 'Baseline (EMA 3/7 only)',
    useOriginalOnly: true
  },
  {
    name: 'EMA 3/7 + Faster EMA 2/4 must agree',
    useFastEMA: true,
    shortPeriod: 2,
    longPeriod: 4
  },
  {
    name: 'EMA 3/7 + Faster EMA 2/3 must agree',
    useFastEMA: true,
    shortPeriod: 2,
    longPeriod: 3
  },
  {
    name: 'EMA 3/7 + Price ROC (2 candles) must agree',
    useROC: true,
    rocPeriod: 2,
    rocThreshold: 0.05
  },
  {
    name: 'EMA 3/7 + Price ROC (1 candle) must agree',
    useROC: true,
    rocPeriod: 1,
    rocThreshold: 0.05
  },
  {
    name: 'EMA 3/7 + Price ROC (3 candles) must agree',
    useROC: true,
    rocPeriod: 3,
    rocThreshold: 0.1
  },
  {
    name: 'REPLACE EMA: Use only Fast EMA 2/4',
    useFastEMAOnly: true,
    shortPeriod: 2,
    longPeriod: 4
  },
  {
    name: 'REPLACE EMA: Use only Fast EMA 2/3',
    useFastEMAOnly: true,
    shortPeriod: 2,
    longPeriod: 3
  },
  {
    name: 'REPLACE EMA: Use only Price ROC (2 candles)',
    useROCOnly: true,
    rocPeriod: 2,
    rocThreshold: 0.05
  }
];

function runStrategy(config) {
  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let wins = 0;
  let losses = 0;
  let skipped = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    const emaGap = parseFloat(r.ema_gap);

    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    let signalToUse = emaSignal;
    let gapToUse = emaGap;

    // STRATEGY: Replace with faster indicators
    if (config.useFastEMAOnly) {
      const fastEMA = calculateFastEMA(rounds, i, config.shortPeriod, config.longPeriod);
      signalToUse = fastEMA.signal;
      gapToUse = fastEMA.gap;

      if (signalToUse === 'NEUTRAL') continue;
    }

    if (config.useROCOnly) {
      const roc = calculateROC(rounds, i, config.rocPeriod);
      if (Math.abs(roc) < config.rocThreshold) continue;

      signalToUse = roc > 0 ? 'BULL' : 'BEAR';
      gapToUse = roc;
    }

    let betSide = null;
    if (signalToUse === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BULL';
    } else if (signalToUse === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BEAR';
    }

    if (!betSide) continue;

    // STRATEGY: Require faster indicator agreement
    if (config.useFastEMA) {
      const fastEMA = calculateFastEMA(rounds, i, config.shortPeriod, config.longPeriod);
      if (!bothAgree(emaSignal, fastEMA.signal)) {
        skipped++;
        continue;
      }
    }

    if (config.useROC) {
      const roc = calculateROC(rounds, i, config.rocPeriod);
      const rocSignal = roc > config.rocThreshold ? 'BULL' : roc < -config.rocThreshold ? 'BEAR' : 'NEUTRAL';

      if (!bothAgree(emaSignal, rocSignal)) {
        skipped++;
        continue;
      }
    }

    // Calculate position size
    let sizeMultiplier = 1.0;
    const hasStrongSignal = Math.abs(gapToUse) >= 0.15;
    if (hasStrongSignal) {
      sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    const hasRecovery = lastTwoResults.length === 2 && lastTwoResults.every(r => !r);
    if (hasRecovery) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betSize = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    if (betSize > bankroll) continue;

    const actualPayout = betSide === 'BULL' ? bullPayout : bearPayout;
    const won = r.winner.toLowerCase() === betSide.toLowerCase();

    const profit = won ? betSize * (actualPayout - 1) : -betSize;
    bankroll += profit;

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    if (won) wins++;
    else losses++;
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = ((bankroll - BASE_CONFIG.STARTING_BANKROLL) / BASE_CONFIG.STARTING_BANKROLL) * 100;

  return {
    trades: totalTrades,
    wins,
    losses,
    winRate,
    roi,
    bankroll,
    skipped
  };
}

console.log('Running tests...\n');
console.log('═'.repeat(100) + '\n');

const results = strategies.map(strategy => ({
  ...strategy,
  ...runStrategy(strategy)
}));

// Sort by ROI
results.sort((a, b) => b.roi - a.roi);

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;

  console.log(`${rank} ${r.name}`);
  console.log(`   ${r.trades} trades | ${r.winRate.toFixed(1)}% WR | ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}% ROI | Final: ${r.bankroll.toFixed(3)} BNB`);
  if (r.skipped > 0) {
    console.log(`   Skipped: ${r.skipped} trades (EMA & faster indicator disagreed)`);
  }
  console.log();
}

console.log('═'.repeat(100) + '\n');

console.log('💡 RECOMMENDATION:\n');
const best = results[0];
const baseline = results.find(r => r.useOriginalOnly);

if (best.roi > baseline.roi) {
  const improvement = best.roi - baseline.roi;
  console.log(`  ✅ BEST SOLUTION: ${best.name}`);
  console.log(`  📈 Improvement: ${improvement.toFixed(2)}% ROI`);
  console.log(`  📊 Win Rate: ${best.winRate.toFixed(1)}% (vs ${baseline.winRate.toFixed(1)}% baseline)`);
  console.log(`  \n  This ${best.winRate > baseline.winRate ? 'INCREASES' : 'maintains'} win rate while improving profitability!`);
} else {
  console.log(`  ⚠️  No faster indicator improves performance`);
  console.log(`  📉 All attempts worse than baseline (${baseline.roi.toFixed(2)}% ROI)`);
  console.log(`\n  The problem may not be EMA lag, but something else...`);
}

console.log('\n' + '═'.repeat(100));

db.close();
