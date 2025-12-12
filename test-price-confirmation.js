import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🔍 TESTING PRICE ACTION CONFIRMATION\n');
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
console.log('Idea: Instead of waiting for EMA stability, check if PRICE confirms the EMA signal\n');
console.log('─'.repeat(100) + '\n');

function getPrice(r) {
  const lock = parseFloat(r.lock_price);
  return lock > 1000000 ? lock / 1e8 : lock;
}

// Get recent price momentum
function getRecentPriceMove(rounds, index, candles = 1) {
  if (index < candles) return 0;

  const currentPrice = getPrice(rounds[index]);
  const oldPrice = getPrice(rounds[index - candles]);

  return ((currentPrice - oldPrice) / oldPrice) * 100;
}

// Check if price is moving in EMA direction
function priceConfirmsEMA(rounds, index, emaSignal, threshold = 0.05) {
  const priceMove = getRecentPriceMove(rounds, index, 1);

  if (emaSignal === 'BULL') {
    return priceMove > threshold; // Price going UP confirms BULL
  } else if (emaSignal === 'BEAR') {
    return priceMove < -threshold; // Price going DOWN confirms BEAR
  }

  return false;
}

// Check if price has momentum (last 2-3 candles)
function hasRecentMomentum(rounds, index, emaSignal, candles = 2, threshold = 0.1) {
  const priceMove = getRecentPriceMove(rounds, index, candles);

  if (emaSignal === 'BULL') {
    return priceMove > threshold;
  } else if (emaSignal === 'BEAR') {
    return priceMove < -threshold;
  }

  return false;
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
    name: 'Baseline (no filter)',
    requirePriceConfirmation: false
  },
  {
    name: 'Require price confirms EMA (last 1 candle > 0.05%)',
    requirePriceConfirmation: true,
    candles: 1,
    threshold: 0.05
  },
  {
    name: 'Require price confirms EMA (last 1 candle > 0.1%)',
    requirePriceConfirmation: true,
    candles: 1,
    threshold: 0.1
  },
  {
    name: 'Require price confirms EMA (last 1 candle > 0.15%)',
    requirePriceConfirmation: true,
    candles: 1,
    threshold: 0.15
  },
  {
    name: 'Require price momentum (last 2 candles > 0.1%)',
    requireMomentum: true,
    candles: 2,
    threshold: 0.1
  },
  {
    name: 'Require price momentum (last 2 candles > 0.2%)',
    requireMomentum: true,
    candles: 2,
    threshold: 0.2
  },
  {
    name: 'Require price momentum (last 3 candles > 0.15%)',
    requireMomentum: true,
    candles: 3,
    threshold: 0.15
  },
  {
    name: 'Require price momentum (last 3 candles > 0.3%)',
    requireMomentum: true,
    candles: 3,
    threshold: 0.3
  },
  {
    name: 'REVERSED: Skip if price confirms (bet on reversals)',
    skipPriceConfirmation: true,
    candles: 1,
    threshold: 0.1
  },
  {
    name: 'REVERSED: Skip if price has momentum (bet on reversals)',
    skipMomentum: true,
    candles: 2,
    threshold: 0.2
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

    let betSide = null;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BULL';
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BEAR';
    }

    if (!betSide) continue;

    // FILTER: Require price confirmation
    if (config.requirePriceConfirmation) {
      const confirmed = priceConfirmsEMA(rounds, i, emaSignal, config.threshold);
      if (!confirmed) {
        skipped++;
        continue;
      }
    }

    // FILTER: Require momentum
    if (config.requireMomentum) {
      const hasMomentum = hasRecentMomentum(rounds, i, emaSignal, config.candles, config.threshold);
      if (!hasMomentum) {
        skipped++;
        continue;
      }
    }

    // REVERSED FILTER: Skip if price confirms (bet on reversals)
    if (config.skipPriceConfirmation) {
      const confirmed = priceConfirmsEMA(rounds, i, emaSignal, config.threshold);
      if (confirmed) {
        skipped++;
        continue;
      }
    }

    // REVERSED FILTER: Skip if momentum exists
    if (config.skipMomentum) {
      const hasMomentum = hasRecentMomentum(rounds, i, emaSignal, config.candles, config.threshold);
      if (hasMomentum) {
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
  console.log(`   ${r.trades} trades | ${r.winRate.toFixed(1)}% WR | ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}% ROI | Final: ${r.bankroll.toFixed(3)} BNB`);
  if (r.skipped > 0) {
    console.log(`   Skipped: ${r.skipped} trades`);
  }
  console.log();
}

console.log('═'.repeat(100) + '\n');

console.log('💡 KEY INSIGHTS:\n');
console.log('  • If requiring price confirmation helps = EMA lag is the problem\n');
console.log('  • If reversed filters help (skip when price confirms) = we should bet on reversals\n');
console.log('  • Baseline ROI: -95.29%\n');

console.log('═'.repeat(100));

db.close();
