import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🚀 TESTING OPTIMAL STRATEGIES BASED ON DISCOVERIES\n');
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

// Market state detection
function detectMarketState(rounds, index) {
  if (index < 20) return 'UNKNOWN';

  const window = rounds.slice(index - 20, index + 1);
  const prices = window.map(r => {
    const lock = Number(r.lock_price);
    const close = Number(r.close_price);
    if (lock > 0) return lock / 1e8;
    if (close > 0) return close / 1e8;
    return null;
  }).filter(p => p !== null);

  if (prices.length < 21) return 'UNKNOWN';

  const highest = Math.max(...prices);
  const lowest = Math.min(...prices);
  const range = highest - lowest;
  const avgPrice = prices.reduce((a, b) => a + b) / prices.length;
  const rangePercent = (range / avgPrice) * 100;

  const squaredDiffs = prices.map(p => Math.pow(p - avgPrice, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b) / prices.length;
  const stdDev = Math.sqrt(variance);
  const cv = (stdDev / avgPrice) * 100;

  const firstHalf = prices.slice(0, 10);
  const secondHalf = prices.slice(11);
  const firstAvg = firstHalf.reduce((a, b) => a + b) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b) / secondHalf.length;
  const trendStrength = Math.abs((secondAvg - firstAvg) / firstAvg) * 100;

  if (rangePercent < 2.0 && cv < 1.5 && trendStrength < 1.0) {
    return 'CONSOLIDATION';
  } else if (rangePercent > 3.0 && trendStrength > 1.5) {
    return 'TRENDING';
  } else if (cv > 2.0 && trendStrength < 1.0) {
    return 'CHOPPY';
  } else {
    return 'NEUTRAL';
  }
}

// Run strategy variants
function runStrategy(rounds, config) {
  const {
    name = 'Unnamed',
    reverseMomentum = false,
    skipTrending = false,
    onlyWeakSignals = false,
    weakSignalThreshold = 0.15,
    targetPayoutRange = null
  } = config;

  const BASE_CONFIG = {
    BASE_POSITION_SIZE: 0.045,
    MOMENTUM_MULTIPLIER: 1.889,
    RECOVERY_MULTIPLIER: 1.5,
    MIN_PAYOUT: 1.45,
    STARTING_BANKROLL: 1.0
  };

  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let wins = 0;
  let losses = 0;
  let totalProfit = 0;
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

    // CONTRARIAN
    let betSide = null;
    let contraPayout = 0;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BULL';
      contraPayout = bearPayout;
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BEAR';
      contraPayout = bullPayout;
    }

    if (!betSide) continue;

    // FILTER: Skip trending markets
    if (skipTrending) {
      const marketState = detectMarketState(rounds, i);
      if (marketState === 'TRENDING') {
        skipped++;
        continue;
      }
    }

    // FILTER: Only weak signals
    if (onlyWeakSignals) {
      if (Math.abs(emaGap) >= weakSignalThreshold) {
        skipped++;
        continue;
      }
    }

    // FILTER: Target specific payout range
    if (targetPayoutRange) {
      if (contraPayout < targetPayoutRange.min || contraPayout >= targetPayoutRange.max) {
        skipped++;
        continue;
      }
    }

    // Position sizing
    let sizeMultiplier = 1.0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;
    const hasRecovery = lastTwoResults[0] === 'LOSS';

    if (reverseMomentum) {
      // REVERSE: Bigger bets on WEAK signals
      if (!hasStrongSignal) {
        sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
      }
    } else {
      // NORMAL: Bigger bets on strong signals
      if (hasStrongSignal) {
        sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
      }
    }

    if (hasRecovery) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betSize = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    const won = betSide.toLowerCase() === r.winner.toLowerCase();
    const actualPayout = parseFloat(r.winner_payout_multiple);

    if (won) {
      const profit = betSize * (actualPayout - 1);
      bankroll += profit;
      totalProfit += profit;
      wins++;
      lastTwoResults.unshift('WIN');
    } else {
      bankroll -= betSize;
      totalProfit -= betSize;
      losses++;
      lastTwoResults.unshift('LOSS');
    }

    if (lastTwoResults.length > 2) lastTwoResults.pop();
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = (totalProfit / BASE_CONFIG.STARTING_BANKROLL) * 100;

  return {
    name,
    trades: totalTrades,
    wins,
    losses,
    winRate,
    roi,
    finalBankroll: bankroll,
    profit: totalProfit,
    skipped
  };
}

// Test all strategies
const strategies = [
  // Baseline
  { name: 'Baseline (No filters)', reverseMomentum: false, skipTrending: false },

  // Option 1: Skip trending
  { name: 'Skip Trending Markets', reverseMomentum: false, skipTrending: true },

  // Option 2: Reverse momentum (bet bigger on weak signals)
  { name: 'Reverse Momentum (Big on weak)', reverseMomentum: true, skipTrending: false },

  // Option 3: Only weak signals
  { name: 'Only Weak Signals (<0.15%)', reverseMomentum: false, onlyWeakSignals: true, weakSignalThreshold: 0.15 },

  // Option 4: Only very weak signals
  { name: 'Only Very Weak Signals (<0.1%)', reverseMomentum: false, onlyWeakSignals: true, weakSignalThreshold: 0.1 },

  // Option 5: Target sweet spot payout (1.80-2.00x)
  { name: 'Target Payout 1.80-2.00x', reverseMomentum: false, targetPayoutRange: { min: 1.80, max: 2.00 } },

  // Option 6: Combined - Skip trending + Reverse momentum
  { name: 'Skip Trending + Reverse Momentum', reverseMomentum: true, skipTrending: true },

  // Option 7: Combined - Skip trending + Only weak signals
  { name: 'Skip Trending + Only Weak Signals', reverseMomentum: false, skipTrending: true, onlyWeakSignals: true, weakSignalThreshold: 0.15 },

  // Option 8: Ultra conservative - All filters
  { name: 'All Filters Combined', reverseMomentum: true, skipTrending: true, onlyWeakSignals: true, weakSignalThreshold: 0.1 }
];

const results = strategies.map(config => runStrategy(rounds, config));

// Display results
console.log('═'.repeat(100) + '\n');
console.log('📊 STRATEGY TEST RESULTS\n');
console.log('═'.repeat(100) + '\n');

results.forEach((r, i) => {
  const roiStr = r.roi >= 0 ? `+${r.roi.toFixed(2)}%` : `${r.roi.toFixed(2)}%`;
  console.log(`${(i + 1).toString().padStart(2)}. ${r.name.padEnd(35)} | ${r.trades.toString().padStart(3)} trades | ${r.winRate.toFixed(1).padStart(5)}% WR | ${roiStr.padStart(10)} ROI`);
  if (r.skipped > 0) {
    console.log(`    (Skipped ${r.skipped} trades)`);
  }
});

console.log('\n' + '═'.repeat(100) + '\n');

// Rank by ROI
const ranked = [...results].sort((a, b) => b.roi - a.roi);

console.log('🏆 TOP 3 STRATEGIES BY ROI:\n');
ranked.slice(0, 3).forEach((r, i) => {
  const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
  const roiStr = r.roi >= 0 ? `+${r.roi.toFixed(2)}%` : `${r.roi.toFixed(2)}%`;
  console.log(`${medal} ${r.name}`);
  console.log(`   ${r.trades} trades | ${r.winRate.toFixed(1)}% WR | ${roiStr} ROI | Final: ${r.finalBankroll.toFixed(4)} BNB\n`);
});

// Compare to baseline
const baseline = results[0];
console.log('─'.repeat(100) + '\n');
console.log('📈 IMPROVEMENTS VS BASELINE:\n');

ranked.slice(0, 5).forEach((r, i) => {
  if (r.name === baseline.name) return;

  const improvement = r.roi - baseline.roi;
  const impStr = improvement >= 0 ? `+${improvement.toFixed(2)}%` : `${improvement.toFixed(2)}%`;
  const tradesDiff = r.trades - baseline.trades;
  const tradeDiffStr = tradesDiff >= 0 ? `+${tradesDiff}` : `${tradesDiff}`;

  console.log(`${r.name}:`);
  console.log(`  ROI: ${baseline.roi.toFixed(2)}% → ${r.roi.toFixed(2)}% (${impStr})`);
  console.log(`  Trades: ${baseline.trades} → ${r.trades} (${tradeDiffStr})`);
  console.log(`  Win Rate: ${baseline.winRate.toFixed(1)}% → ${r.winRate.toFixed(1)}%\n`);
});

console.log('═'.repeat(100) + '\n');

db.close();
