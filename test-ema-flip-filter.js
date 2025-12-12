import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🔍 TESTING EMA FLIP FILTERS\n');
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
console.log('─'.repeat(100) + '\n');

function getPrice(r) {
  const lock = parseFloat(r.lock_price);
  return lock > 1000000 ? lock / 1e8 : lock;
}

// Check how long EMA has been in current direction
function getEMAStability(rounds, index, currentSignal) {
  let candles = 0;
  for (let i = index; i >= 0; i--) {
    if (!rounds[i].ema_signal || rounds[i].ema_signal === 'NEUTRAL') break;
    if (rounds[i].ema_signal === currentSignal) {
      candles++;
    } else {
      break;
    }
  }
  return candles;
}

// Check price trend strength (linear regression R²)
function getPriceTrendStrength(rounds, index, lookback = 5) {
  const startIdx = Math.max(0, index - lookback + 1);
  const priceWindow = rounds.slice(startIdx, index + 1).map(r => getPrice(r));

  if (priceWindow.length < 3) return { r2: 0, slope: 0 };

  const n = priceWindow.length;
  const x = Array.from({ length: n }, (_, i) => i);
  const y = priceWindow;

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  // Calculate R²
  const yMean = sumY / n;
  const ssTotal = y.reduce((sum, yi) => sum + Math.pow(yi - yMean, 2), 0);
  const ssResidual = y.reduce((sum, yi, i) => sum + Math.pow(yi - (slope * x[i] + intercept), 2), 0);
  const r2 = 1 - (ssResidual / ssTotal);

  return { r2, slope };
}

// Test different strategies
const strategies = [
  {
    name: 'Baseline',
    skipRecentFlip: 0,
    requireStability: 0,
    requireTrendStrength: 0
  },
  {
    name: 'Skip if flipped in last 1 candle',
    skipRecentFlip: 1,
    requireStability: 2
  },
  {
    name: 'Skip if flipped in last 2 candles',
    skipRecentFlip: 2,
    requireStability: 3
  },
  {
    name: 'Require 3+ candles stable',
    requireStability: 3
  },
  {
    name: 'Require 4+ candles stable',
    requireStability: 4
  },
  {
    name: 'Require 5+ candles stable',
    requireStability: 5
  },
  {
    name: 'Require strong price trend (R² > 0.5)',
    requireTrendStrength: 0.5
  },
  {
    name: 'Require strong price trend (R² > 0.7)',
    requireTrendStrength: 0.7
  },
  {
    name: 'Combo: 3+ candles stable + R² > 0.5',
    requireStability: 3,
    requireTrendStrength: 0.5
  },
  {
    name: 'Combo: 4+ candles stable + R² > 0.5',
    requireStability: 4,
    requireTrendStrength: 0.5
  }
];

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0
};

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

    let betSide = null;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BULL';
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BEAR';
    }

    if (!betSide) continue;

    // FILTER: Check EMA stability
    const emaStability = getEMAStability(rounds, i, emaSignal);

    if (config.skipRecentFlip && emaStability <= config.skipRecentFlip) {
      skipped++;
      continue;
    }

    if (config.requireStability && emaStability < config.requireStability) {
      skipped++;
      continue;
    }

    // FILTER: Check price trend strength
    if (config.requireTrendStrength) {
      const trend = getPriceTrendStrength(rounds, i, 5);
      if (trend.r2 < config.requireTrendStrength) {
        skipped++;
        continue;
      }
    }

    // Calculate position size
    let sizeMultiplier = 1.0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;
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
  console.log(`   ${r.trades} trades | ${r.winRate.toFixed(1)}% WR | ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}% ROI`);
  if (r.skipped > 0) {
    console.log(`   Skipped: ${r.skipped} trades`);
  }
  console.log();
}

console.log('═'.repeat(100) + '\n');

// Test on 13-loss streak specifically
console.log('🔍 IMPACT ON 13-LOSS STREAK (Epochs 434815-434832)\n');
console.log('─'.repeat(100) + '\n');

const streakStart = rounds.findIndex(r => r.epoch === 434815);
const streakEnd = rounds.findIndex(r => r.epoch === 434832);

console.log(`Analyzing ${streakEnd - streakStart + 1} rounds in the streak period...\n`);

for (const strategy of strategies.slice(0, 5)) {
  let tradesInStreak = 0;
  let skippedInStreak = 0;

  for (let i = streakStart; i <= streakEnd; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;

    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    let betSide = null;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BULL';
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BEAR';
    }

    if (!betSide) continue;

    const emaStability = getEMAStability(rounds, i, emaSignal);
    const trend = getPriceTrendStrength(rounds, i, 5);

    let wouldSkip = false;

    if (strategy.skipRecentFlip && emaStability <= strategy.skipRecentFlip) {
      wouldSkip = true;
    }

    if (strategy.requireStability && emaStability < strategy.requireStability) {
      wouldSkip = true;
    }

    if (strategy.requireTrendStrength && trend.r2 < strategy.requireTrendStrength) {
      wouldSkip = true;
    }

    tradesInStreak++;
    if (wouldSkip) skippedInStreak++;
  }

  console.log(`${strategy.name}:`);
  console.log(`  Would skip: ${skippedInStreak}/${tradesInStreak} trades in the 13-loss streak`);
  console.log(`  Remaining: ${tradesInStreak - skippedInStreak} consecutive losses\n`);
}

console.log('═'.repeat(100));

db.close();
