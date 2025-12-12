import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🔍 VERIFYING EMA WHIPSAW THEORY\n');
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
console.log('─'.repeat(100) + '\n');

// Run strategy and track EMA flips
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

  // Count EMA flips in last N rounds
  const lookback = 10;
  let emaFlips = 0;
  if (i >= lookback) {
    for (let j = i - lookback + 1; j <= i; j++) {
      const prevSignal = rounds[j - 1]?.ema_signal;
      const currSignal = rounds[j]?.ema_signal;
      if (prevSignal && currSignal && prevSignal !== 'NEUTRAL' && currSignal !== 'NEUTRAL' && prevSignal !== currSignal) {
        emaFlips++;
      }
    }
  }

  tradeLog.push({
    index: i,
    epoch: r.epoch,
    timestamp: r.lock_timestamp,
    betSide,
    emaSignal,
    emaGap: Math.abs(emaGap),
    won,
    actualPayout,
    emaFlips // Number of EMA direction changes in last 10 rounds
  });
}

console.log(`Total trades: ${tradeLog.length}\n`);
console.log('═'.repeat(100) + '\n');

// Analyze wins vs losses by EMA flip count
const wins = tradeLog.filter(t => t.won);
const losses = tradeLog.filter(t => !t.won);

console.log('📊 EMA FLIP ANALYSIS (Last 10 rounds before trade):\n');
console.log('─'.repeat(100) + '\n');

// Group by EMA flip count
const flipRanges = [
  { name: '0-2 flips (Stable trend)', min: 0, max: 2 },
  { name: '3-4 flips (Some whipsaw)', min: 3, max: 4 },
  { name: '5-6 flips (Heavy whipsaw)', min: 5, max: 6 },
  { name: '7+ flips (Extreme whipsaw)', min: 7, max: 99 }
];

flipRanges.forEach(range => {
  const rangeWins = wins.filter(t => t.emaFlips >= range.min && t.emaFlips <= range.max);
  const rangeLosses = losses.filter(t => t.emaFlips >= range.min && t.emaFlips <= range.max);
  const total = rangeWins.length + rangeLosses.length;
  const wr = total > 0 ? (rangeWins.length / total) * 100 : 0;

  if (total > 0) {
    console.log(`${range.name.padEnd(30)} | ${total.toString().padStart(3)} trades | ${rangeWins.length.toString().padStart(3)} W / ${rangeLosses.length.toString().padStart(3)} L | ${wr.toFixed(1).padStart(5)}% WR`);
  }
});

console.log('\n' + '─'.repeat(100) + '\n');

// Find the 13-loss streak
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
  const avgFlips = streak.reduce((sum, t) => sum + t.emaFlips, 0) / streak.length;
  const avgGap = streak.reduce((sum, t) => sum + t.emaGap, 0) / streak.length;

  console.log(`Streak #${idx + 1} - ${streak.length} consecutive losses:`);
  console.log(`  Date: ${new Date(streak[0].timestamp * 1000).toISOString().split('T')[0]}`);
  console.log(`  Avg EMA flips (last 10 rounds): ${avgFlips.toFixed(1)}`);
  console.log(`  Avg EMA gap: ${(avgGap * 100).toFixed(2)}%`);

  // Show first 5 trades of streak with flip counts
  console.log(`  First 5 trades:`);
  streak.slice(0, 5).forEach((t, i) => {
    console.log(`    ${i + 1}. Epoch ${t.epoch} | EMA ${t.emaSignal} (gap: ${(t.emaGap * 100).toFixed(2)}%) | Flips in last 10: ${t.emaFlips}`);
  });

  if (streak.length > 5) {
    console.log(`    ... and ${streak.length - 5} more losses`);
  }
  console.log();
});

console.log('═'.repeat(100) + '\n');

// Find winning streaks for comparison
const winStreaks = [];
currentStreak = [];

for (const trade of tradeLog) {
  if (trade.won) {
    currentStreak.push(trade);
  } else {
    if (currentStreak.length >= 5) {
      winStreaks.push([...currentStreak]);
    }
    currentStreak = [];
  }
}
if (currentStreak.length >= 5) {
  winStreaks.push(currentStreak);
}

console.log('🟢 WINNING STREAK ANALYSIS (for comparison):\n');
console.log('─'.repeat(100) + '\n');

winStreaks.forEach((streak, idx) => {
  const avgFlips = streak.reduce((sum, t) => sum + t.emaFlips, 0) / streak.length;
  const avgGap = streak.reduce((sum, t) => sum + t.emaGap, 0) / streak.length;

  console.log(`Win Streak #${idx + 1} - ${streak.length} consecutive wins:`);
  console.log(`  Date: ${new Date(streak[0].timestamp * 1000).toISOString().split('T')[0]}`);
  console.log(`  Avg EMA flips (last 10 rounds): ${avgFlips.toFixed(1)}`);
  console.log(`  Avg EMA gap: ${(avgGap * 100).toFixed(2)}%`);
  console.log();
});

console.log('═'.repeat(100) + '\n');

// Statistical comparison
const avgFlipsWins = wins.reduce((sum, t) => sum + t.emaFlips, 0) / wins.length;
const avgFlipsLosses = losses.reduce((sum, t) => sum + t.emaFlips, 0) / losses.length;

console.log('📈 STATISTICAL SUMMARY:\n');
console.log('─'.repeat(100) + '\n');

console.log(`Winning trades:`);
console.log(`  Average EMA flips (last 10 rounds): ${avgFlipsWins.toFixed(2)}`);
console.log();

console.log(`Losing trades:`);
console.log(`  Average EMA flips (last 10 rounds): ${avgFlipsLosses.toFixed(2)}`);
console.log();

const flipDifference = avgFlipsLosses - avgFlipsWins;
console.log(`Difference: ${flipDifference >= 0 ? '+' : ''}${flipDifference.toFixed(2)} more flips during losses`);
console.log();

if (flipDifference > 0.5) {
  console.log('✅ THEORY CONFIRMED: Losses correlate with MORE EMA whipsawing!');
  console.log('   Your theory is correct - EMA flipping rapidly causes losses.');
} else if (flipDifference < -0.5) {
  console.log('❌ THEORY REJECTED: Losses actually happen during STABLE EMA periods!');
  console.log('   The whipsaw theory does not explain the losses.');
} else {
  console.log('🤔 INCONCLUSIVE: EMA flips similar for wins and losses.');
  console.log('   Whipsaw may not be the primary cause.');
}

console.log('\n' + '═'.repeat(100) + '\n');

console.log('💡 KEY INSIGHTS:\n');

// Find the range with best and worst performance
const rangeStats = flipRanges.map(range => {
  const rangeWins = wins.filter(t => t.emaFlips >= range.min && t.emaFlips <= range.max);
  const rangeLosses = losses.filter(t => t.emaFlips >= range.min && t.emaFlips <= range.max);
  const total = rangeWins.length + rangeLosses.length;
  const wr = total > 0 ? (rangeWins.length / total) * 100 : 0;
  return { ...range, total, wr };
}).filter(r => r.total >= 20);

if (rangeStats.length > 0) {
  const best = rangeStats.reduce((a, b) => a.wr > b.wr ? a : b);
  const worst = rangeStats.reduce((a, b) => a.wr < b.wr ? a : b);

  console.log(`1. Best performance: ${best.name} (${best.wr.toFixed(1)}% WR)`);
  console.log(`2. Worst performance: ${worst.name} (${worst.wr.toFixed(1)}% WR)`);
  console.log(`3. Difference: ${(best.wr - worst.wr).toFixed(1)}% WR gap\n`);
}

console.log('═'.repeat(100) + '\n');

db.close();
