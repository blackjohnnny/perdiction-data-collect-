import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🔍 VERIFYING LOCAL TOP/BOTTOM ENTRY THEORY\n');
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
console.log('Your Theory: We enter at local tops/bottoms during consolidation, then price reverses\n');
console.log('─'.repeat(100) + '\n');

// Function to check if entry is at local extreme
function isAtLocalExtreme(rounds, index, lookback = 14) {
  if (index < lookback) return { isTop: false, isBottom: false, position: 0.5 };

  const window = rounds.slice(index - lookback, index + 1);
  const prices = window.map(r => {
    const lock = Number(r.lock_price);
    const close = Number(r.close_price);
    if (lock > 0) return lock / 1e8;
    if (close > 0) return close / 1e8;
    return null;
  }).filter(p => p !== null);

  if (prices.length < lookback) return { isTop: false, isBottom: false, position: 0.5 };

  const currentPrice = prices[prices.length - 1];
  const highest = Math.max(...prices);
  const lowest = Math.min(...prices);
  const range = highest - lowest;

  if (range === 0) return { isTop: false, isBottom: false, position: 0.5 };

  // Position in range (0 = bottom, 1 = top)
  const position = (currentPrice - lowest) / range;

  // Is this a local top? (price in top 20% of recent range)
  const isTop = position > 0.80;

  // Is this a local bottom? (price in bottom 20% of recent range)
  const isBottom = position < 0.20;

  return { isTop, isBottom, position };
}

// Run strategy and track entry positions
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

  const bullPayout = (total * 0.97) / bullWei;
  const bearPayout = (total * 0.97) / bearWei;

  // CONTRARIAN
  let betSide = null;
  if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
    betSide = 'BULL';
  } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
    betSide = 'BEAR';
  }

  if (!betSide) continue;

  // Check if entry is at local extreme
  const extreme = isAtLocalExtreme(rounds, i, 14);

  // Position sizing
  let sizeMultiplier = 1.0;
  if (Math.abs(emaGap) >= 0.15) {
    sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
  }
  if (lastTwoResults[0] === 'LOSS') {
    sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
  }

  const betSize = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
  const won = betSide.toLowerCase() === r.winner.toLowerCase();
  const actualPayout = parseFloat(r.winner_payout_multiple);

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
    won,
    actualPayout,
    isTop: extreme.isTop,
    isBottom: extreme.isBottom,
    pricePosition: extreme.position
  });
}

console.log(`Total trades: ${tradeLog.length}\n`);
console.log('═'.repeat(100) + '\n');

// Analyze wins vs losses by entry position
const wins = tradeLog.filter(t => t.won);
const losses = tradeLog.filter(t => !t.won);

console.log('📊 ENTRY POSITION ANALYSIS (Last 14 rounds):\n');
console.log('─'.repeat(100) + '\n');

// Group by position in range
const positionRanges = [
  { name: 'Bottom 20% (Local Low)', min: 0.00, max: 0.20 },
  { name: 'Lower Middle (20-40%)', min: 0.20, max: 0.40 },
  { name: 'Middle (40-60%)', min: 0.40, max: 0.60 },
  { name: 'Upper Middle (60-80%)', min: 0.60, max: 0.80 },
  { name: 'Top 20% (Local High)', min: 0.80, max: 1.00 }
];

positionRanges.forEach(range => {
  const rangeWins = wins.filter(t => t.pricePosition >= range.min && t.pricePosition < range.max);
  const rangeLosses = losses.filter(t => t.pricePosition >= range.min && t.pricePosition < range.max);
  const total = rangeWins.length + rangeLosses.length;
  const wr = total > 0 ? (rangeWins.length / total) * 100 : 0;

  if (total > 0) {
    console.log(`${range.name.padEnd(30)} | ${total.toString().padStart(3)} trades | ${rangeWins.length.toString().padStart(3)} W / ${rangeLosses.length.toString().padStart(3)} L | ${wr.toFixed(1).padStart(5)}% WR`);
  }
});

console.log('\n' + '─'.repeat(100) + '\n');

// Analyze by EMA signal direction vs entry position
console.log('📊 EMA SIGNAL vs ENTRY POSITION:\n');
console.log('─'.repeat(100) + '\n');

const bullSignalAtTop = tradeLog.filter(t => t.emaSignal === 'BULL' && t.isTop);
const bullSignalAtBottom = tradeLog.filter(t => t.emaSignal === 'BULL' && t.isBottom);
const bearSignalAtTop = tradeLog.filter(t => t.emaSignal === 'BEAR' && t.isTop);
const bearSignalAtBottom = tradeLog.filter(t => t.emaSignal === 'BEAR' && t.isBottom);

console.log('BULL EMA signal at LOCAL TOP (should be bad - buying high):');
if (bullSignalAtTop.length > 0) {
  const wins = bullSignalAtTop.filter(t => t.won).length;
  const wr = (wins / bullSignalAtTop.length) * 100;
  console.log(`  ${bullSignalAtTop.length} trades | ${wins} wins | ${wr.toFixed(1)}% WR\n`);
} else {
  console.log(`  0 trades\n`);
}

console.log('BULL EMA signal at LOCAL BOTTOM (should be good - buying low):');
if (bullSignalAtBottom.length > 0) {
  const wins = bullSignalAtBottom.filter(t => t.won).length;
  const wr = (wins / bullSignalAtBottom.length) * 100;
  console.log(`  ${bullSignalAtBottom.length} trades | ${wins} wins | ${wr.toFixed(1)}% WR\n`);
} else {
  console.log(`  0 trades\n`);
}

console.log('BEAR EMA signal at LOCAL BOTTOM (should be bad - selling low):');
if (bearSignalAtBottom.length > 0) {
  const wins = bearSignalAtBottom.filter(t => t.won).length;
  const wr = (wins / bearSignalAtBottom.length) * 100;
  console.log(`  ${bearSignalAtBottom.length} trades | ${wins} wins | ${wr.toFixed(1)}% WR\n`);
} else {
  console.log(`  0 trades\n`);
}

console.log('BEAR EMA signal at LOCAL TOP (should be good - selling high):');
if (bearSignalAtTop.length > 0) {
  const wins = bearSignalAtTop.filter(t => t.won).length;
  const wr = (wins / bearSignalAtTop.length) * 100;
  console.log(`  ${bearSignalAtTop.length} trades | ${wins} wins | ${wr.toFixed(1)}% WR\n`);
} else {
  console.log(`  0 trades\n`);
}

console.log('─'.repeat(100) + '\n');

// Find loss streaks and check entry positions
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

console.log('🔴 LOSS STREAK ANALYSIS:\n');
console.log('─'.repeat(100) + '\n');

lossStreaks.forEach((streak, idx) => {
  const avgPosition = streak.reduce((sum, t) => sum + t.pricePosition, 0) / streak.length;
  const atExtremes = streak.filter(t => t.isTop || t.isBottom).length;

  console.log(`Streak #${idx + 1} - ${streak.length} consecutive losses:`);
  console.log(`  Date: ${new Date(streak[0].timestamp * 1000).toISOString().split('T')[0]}`);
  console.log(`  Avg price position: ${(avgPosition * 100).toFixed(1)}% of range`);
  console.log(`  Trades at extremes (top/bottom 20%): ${atExtremes}/${streak.length} (${((atExtremes/streak.length)*100).toFixed(1)}%)`);

  console.log(`  First 5 trades:`);
  streak.slice(0, 5).forEach((t, i) => {
    const posType = t.isTop ? '🔴 TOP' : t.isBottom ? '🟢 BOTTOM' : '📊 MIDDLE';
    console.log(`    ${i + 1}. Epoch ${t.epoch} | EMA ${t.emaSignal} | Entry: ${posType} (${(t.pricePosition * 100).toFixed(1)}%)`);
  });

  if (streak.length > 5) {
    console.log(`    ... and ${streak.length - 5} more losses`);
  }
  console.log();
});

console.log('═'.repeat(100) + '\n');

// Statistical comparison
const avgPositionWins = wins.reduce((sum, t) => sum + t.pricePosition, 0) / wins.length;
const avgPositionLosses = losses.reduce((sum, t) => sum + t.pricePosition, 0) / losses.length;

const extremeWins = wins.filter(t => t.isTop || t.isBottom).length;
const extremeLosses = losses.filter(t => t.isTop || t.isBottom).length;
const extremeWinRate = (extremeWins / (extremeWins + extremeLosses)) * 100;

console.log('📈 STATISTICAL SUMMARY:\n');
console.log('─'.repeat(100) + '\n');

console.log(`Winning trades:`);
console.log(`  Average entry position: ${(avgPositionWins * 100).toFixed(1)}% of range`);
console.log(`  Entries at extremes: ${extremeWins}/${wins.length} (${((extremeWins/wins.length)*100).toFixed(1)}%)\n`);

console.log(`Losing trades:`);
console.log(`  Average entry position: ${(avgPositionLosses * 100).toFixed(1)}% of range`);
console.log(`  Entries at extremes: ${extremeLosses}/${losses.length} (${((extremeLosses/losses.length)*100).toFixed(1)}%)\n`);

console.log(`Trades at extremes (top/bottom 20%):`);
console.log(`  Total: ${extremeWins + extremeLosses} trades`);
console.log(`  Win rate: ${extremeWinRate.toFixed(1)}%\n`);

const middleWins = wins.filter(t => !t.isTop && !t.isBottom).length;
const middleLosses = losses.filter(t => !t.isTop && !t.isBottom).length;
const middleWinRate = (middleWins / (middleWins + middleLosses)) * 100;

console.log(`Trades in middle (20-80% of range):`);
console.log(`  Total: ${middleWins + middleLosses} trades`);
console.log(`  Win rate: ${middleWinRate.toFixed(1)}%\n`);

const difference = middleWinRate - extremeWinRate;
console.log(`Win Rate Difference: ${difference >= 0 ? '+' : ''}${difference.toFixed(1)}% (middle vs extremes)`);
console.log();

if (difference > 5) {
  console.log('✅ THEORY CONFIRMED: Entering at local extremes HURTS performance!');
  console.log('   Your theory is correct - we enter at tops/bottoms and get reversed.');
} else if (difference < -5) {
  console.log('❌ THEORY REJECTED: Entering at extremes actually HELPS!');
  console.log('   The local top/bottom theory does not explain the losses.');
} else {
  console.log('🤔 INCONCLUSIVE: Entry position has minimal impact on results.');
  console.log('   Local extremes may not be the primary cause.');
}

console.log('\n' + '═'.repeat(100) + '\n');

db.close();
