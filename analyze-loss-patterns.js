import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🔍 DEEP DIVE: WHAT CAUSES WINS VS LOSSES?\n');
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

console.log(`📊 Analyzing ${rounds.length} complete rounds\n`);

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

// Run strategy and capture all details
const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0
};

let bankroll = BASE_CONFIG.STARTING_BANKROLL;
let lastTwoResults = [];
const tradeLog = [];

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];

  const emaSignal = r.ema_signal;
  const emaGap = parseFloat(r.ema_gap);
  if (!emaSignal || emaSignal === 'NEUTRAL') continue;

  const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;
  if (total === 0) continue;

  const bullPercent = (bullWei / total) * 100;
  const bearPercent = (bearWei / total) * 100;
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

  // Position sizing
  let sizeMultiplier = 1.0;
  const hasMomentum = Math.abs(emaGap) >= 0.15;
  const hasRecovery = lastTwoResults[0] === 'LOSS';

  if (hasMomentum) sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
  if (hasRecovery) sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;

  const betSize = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
  const won = betSide.toLowerCase() === r.winner.toLowerCase();
  const actualPayout = parseFloat(r.winner_payout_multiple);

  const marketState = detectMarketState(rounds, i);

  if (won) {
    const profit = betSize * (actualPayout - 1);
    bankroll += profit;
    lastTwoResults.unshift('WIN');
  } else {
    bankroll -= betSize;
    lastTwoResults.unshift('LOSS');
  }

  if (lastTwoResults.length > 2) lastTwoResults.pop();

  tradeLog.push({
    index: i,
    epoch: r.epoch,
    timestamp: r.lock_timestamp,
    betSide,
    emaSignal,
    emaGap: Math.abs(emaGap),
    contraPayout,
    actualPayout,
    won,
    marketState,
    hasMomentum,
    hasRecovery,
    bullPct: bullPercent,
    bearPct: bearPercent
  });
}

console.log(`Total trades: ${tradeLog.length}\n`);
console.log('═'.repeat(100) + '\n');

// Analyze wins vs losses
const wins = tradeLog.filter(t => t.won);
const losses = tradeLog.filter(t => !t.won);

console.log('📊 WIN vs LOSS CHARACTERISTICS:\n');
console.log('─'.repeat(100) + '\n');

// By Market State
console.log('BY MARKET STATE:\n');
const marketStates = ['CONSOLIDATION', 'TRENDING', 'CHOPPY', 'NEUTRAL', 'UNKNOWN'];
marketStates.forEach(state => {
  const stateWins = wins.filter(t => t.marketState === state);
  const stateLosses = losses.filter(t => t.marketState === state);
  const total = stateWins.length + stateLosses.length;
  const wr = total > 0 ? (stateWins.length / total) * 100 : 0;

  if (total > 0) {
    console.log(`  ${state.padEnd(15)} | ${total.toString().padStart(3)} trades | ${stateWins.length.toString().padStart(3)} W / ${stateLosses.length.toString().padStart(3)} L | ${wr.toFixed(1).padStart(5)}% WR`);
  }
});

console.log('\n');

// By EMA Gap Strength
console.log('BY EMA GAP STRENGTH:\n');
const gapRanges = [
  { name: 'Very Weak (0.05-0.1)', min: 0.05, max: 0.1 },
  { name: 'Weak (0.1-0.15)', min: 0.1, max: 0.15 },
  { name: 'Moderate (0.15-0.25)', min: 0.15, max: 0.25 },
  { name: 'Strong (0.25-0.5)', min: 0.25, max: 0.5 },
  { name: 'Very Strong (>0.5)', min: 0.5, max: 999 }
];

gapRanges.forEach(range => {
  const rangeWins = wins.filter(t => t.emaGap >= range.min && t.emaGap < range.max);
  const rangeLosses = losses.filter(t => t.emaGap >= range.min && t.emaGap < range.max);
  const total = rangeWins.length + rangeLosses.length;
  const wr = total > 0 ? (rangeWins.length / total) * 100 : 0;

  if (total > 0) {
    console.log(`  ${range.name.padEnd(25)} | ${total.toString().padStart(3)} trades | ${rangeWins.length.toString().padStart(3)} W / ${rangeLosses.length.toString().padStart(3)} L | ${wr.toFixed(1).padStart(5)}% WR`);
  }
});

console.log('\n');

// By Contrarian Payout Level
console.log('BY CONTRARIAN PAYOUT LEVEL:\n');
const payoutRanges = [
  { name: '1.45-1.60x', min: 1.45, max: 1.60 },
  { name: '1.60-1.80x', min: 1.60, max: 1.80 },
  { name: '1.80-2.00x', min: 1.80, max: 2.00 },
  { name: '2.00-2.50x', min: 2.00, max: 2.50 },
  { name: '>2.50x', min: 2.50, max: 999 }
];

payoutRanges.forEach(range => {
  const rangeWins = wins.filter(t => t.contraPayout >= range.min && t.contraPayout < range.max);
  const rangeLosses = losses.filter(t => t.contraPayout >= range.min && t.contraPayout < range.max);
  const total = rangeWins.length + rangeLosses.length;
  const wr = total > 0 ? (rangeWins.length / total) * 100 : 0;

  if (total > 0) {
    console.log(`  ${range.name.padEnd(15)} | ${total.toString().padStart(3)} trades | ${rangeWins.length.toString().padStart(3)} W / ${rangeLosses.length.toString().padStart(3)} L | ${wr.toFixed(1).padStart(5)}% WR`);
  }
});

console.log('\n');

// By Momentum Status
console.log('BY MOMENTUM STATUS:\n');
const momentumWins = wins.filter(t => t.hasMomentum);
const momentumLosses = losses.filter(t => t.hasMomentum);
const momentumTotal = momentumWins.length + momentumLosses.length;
const momentumWR = momentumTotal > 0 ? (momentumWins.length / momentumTotal) * 100 : 0;

const noMomentumWins = wins.filter(t => !t.hasMomentum);
const noMomentumLosses = losses.filter(t => !t.hasMomentum);
const noMomentumTotal = noMomentumWins.length + noMomentumLosses.length;
const noMomentumWR = noMomentumTotal > 0 ? (noMomentumWins.length / noMomentumTotal) * 100 : 0;

console.log(`  Has Momentum (≥15%) | ${momentumTotal.toString().padStart(3)} trades | ${momentumWins.length.toString().padStart(3)} W / ${momentumLosses.length.toString().padStart(3)} L | ${momentumWR.toFixed(1).padStart(5)}% WR`);
console.log(`  No Momentum (<15%)  | ${noMomentumTotal.toString().padStart(3)} trades | ${noMomentumWins.length.toString().padStart(3)} W / ${noMomentumLosses.length.toString().padStart(3)} L | ${noMomentumWR.toFixed(1).padStart(5)}% WR`);

console.log('\n' + '═'.repeat(100) + '\n');

// Find consecutive loss streaks
console.log('🔴 CONSECUTIVE LOSS STREAK ANALYSIS:\n');
console.log('─'.repeat(100) + '\n');

const lossStreaks = [];
let currentStreak = [];

for (const trade of tradeLog) {
  if (!trade.won) {
    currentStreak.push(trade);
  } else {
    if (currentStreak.length >= 4) {
      lossStreaks.push([...currentStreak]);
    }
    currentStreak = [];
  }
}
if (currentStreak.length >= 4) {
  lossStreaks.push(currentStreak);
}

console.log(`Found ${lossStreaks.length} loss streaks of 4+ trades\n`);

if (lossStreaks.length > 0) {
  console.log('Loss Streak Details:\n');

  lossStreaks.forEach((streak, idx) => {
    const marketStates = streak.map(t => t.marketState);
    const mostCommonState = marketStates.reduce((acc, state) => {
      acc[state] = (acc[state] || 0) + 1;
      return acc;
    }, {});
    const dominantState = Object.entries(mostCommonState).sort((a, b) => b[1] - a[1])[0][0];

    const avgGap = streak.reduce((sum, t) => sum + t.emaGap, 0) / streak.length;
    const avgPayout = streak.reduce((sum, t) => sum + t.contraPayout, 0) / streak.length;

    console.log(`  Streak #${idx + 1} - ${streak.length} losses`);
    console.log(`    Date: ${new Date(streak[0].timestamp * 1000).toISOString().split('T')[0]}`);
    console.log(`    Dominant market: ${dominantState} (${mostCommonState[dominantState]}/${streak.length} trades)`);
    console.log(`    Avg EMA gap: ${(avgGap * 100).toFixed(2)}%`);
    console.log(`    Avg contrarian payout: ${avgPayout.toFixed(2)}x\n`);
  });
}

console.log('═'.repeat(100) + '\n');

// Best and worst conditions
console.log('💡 KEY INSIGHTS:\n');
console.log('─'.repeat(100) + '\n');

// Best market state
const bestState = marketStates.map(state => {
  const stateWins = wins.filter(t => t.marketState === state);
  const stateLosses = losses.filter(t => t.marketState === state);
  const total = stateWins.length + stateLosses.length;
  const wr = total > 0 ? (stateWins.length / total) * 100 : 0;
  return { state, total, wr };
}).filter(s => s.total >= 20).sort((a, b) => b.wr - a.wr)[0];

if (bestState) {
  console.log(`1. Best Market State: ${bestState.state} (${bestState.wr.toFixed(1)}% WR over ${bestState.total} trades)`);
}

// Best EMA gap range
const bestGap = gapRanges.map(range => {
  const rangeWins = wins.filter(t => t.emaGap >= range.min && t.emaGap < range.max);
  const rangeLosses = losses.filter(t => t.emaGap >= range.min && t.emaGap < range.max);
  const total = rangeWins.length + rangeLosses.length;
  const wr = total > 0 ? (rangeWins.length / total) * 100 : 0;
  return { range: range.name, total, wr };
}).filter(g => g.total >= 10).sort((a, b) => b.wr - a.wr)[0];

if (bestGap) {
  console.log(`2. Best EMA Gap Range: ${bestGap.range} (${bestGap.wr.toFixed(1)}% WR over ${bestGap.total} trades)`);
}

// Momentum comparison
console.log(`3. Momentum Impact: ${momentumWR > noMomentumWR ? 'Positive' : 'Negative'} (${momentumWR.toFixed(1)}% vs ${noMomentumWR.toFixed(1)}%)`);

// Best payout range
const bestPayout = payoutRanges.map(range => {
  const rangeWins = wins.filter(t => t.contraPayout >= range.min && t.contraPayout < range.max);
  const rangeLosses = losses.filter(t => t.contraPayout >= range.min && t.contraPayout < range.max);
  const total = rangeWins.length + rangeLosses.length;
  const wr = total > 0 ? (rangeWins.length / total) * 100 : 0;
  return { range: range.name, total, wr };
}).filter(p => p.total >= 20).sort((a, b) => b.wr - a.wr)[0];

if (bestPayout) {
  console.log(`4. Best Contrarian Payout: ${bestPayout.range} (${bestPayout.wr.toFixed(1)}% WR over ${bestPayout.total} trades)`);
}

console.log('\n' + '═'.repeat(100) + '\n');

db.close();
