import { initDatabase } from './db-init.js';

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0,
};

function calculateFlipRate(rounds, currentIndex, lookback) {
  const startIdx = Math.max(0, currentIndex - lookback);
  const recentRounds = rounds.slice(startIdx, currentIndex + 1);

  if (recentRounds.length < 3) return null;

  let emaFlips = 0;
  let prevSignal = null;
  for (const r of recentRounds) {
    const signal = r.ema_signal;
    if (signal && signal !== 'NEUTRAL') {
      if (prevSignal && signal !== prevSignal) emaFlips++;
      prevSignal = signal;
    }
  }

  return emaFlips / recentRounds.length;
}

function analyzeSkippedTrades(rounds) {
  let consecutiveLosses = 0;
  let lastTwoResults = [];
  let cooldownUntilTimestamp = 0;

  const skippedTrades = [];
  let tradeIndex = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    // Check if this trade would be skipped by circuit breaker
    const wouldBeSkipped = r.lock_timestamp < cooldownUntilTimestamp;

    // Calculate flip rate for inverse strategy
    const flipRate = calculateFlipRate(rounds, i, 12);
    if (flipRate === null) continue;

    const isChoppy = flipRate > 0.20;

    const t20sBull = parseFloat(r.t20s_bull_wei || 0) / 1e18;
    const t20sBear = parseFloat(r.t20s_bear_wei || 0) / 1e18;
    const t20sTotal = t20sBull + t20sBear;
    if (t20sTotal === 0) continue;

    const bullPayout = (t20sTotal * 0.97) / t20sBull;
    const bearPayout = (t20sTotal * 0.97) / t20sBear;

    let signal = null;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      signal = 'BULL';
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      signal = 'BEAR';
    }

    if (!signal) continue;

    tradeIndex++;

    // What would happen with inverse?
    let normalSignal = signal;
    let inversedSignal = isChoppy ? (signal === 'BULL' ? 'BEAR' : 'BULL') : signal;

    const winner = r.winner ? r.winner.toLowerCase() : '';
    const normalWon = (normalSignal === 'BULL' && winner === 'bull') || (normalSignal === 'BEAR' && winner === 'bear');
    const inversedWon = (inversedSignal === 'BULL' && winner === 'bull') || (inversedSignal === 'BEAR' && winner === 'bear');

    if (wouldBeSkipped) {
      skippedTrades.push({
        tradeIndex,
        epoch: r.epoch,
        timestamp: r.lock_timestamp,
        normalSignal,
        inversedSignal,
        winner,
        normalWon,
        inversedWon,
        isChoppy,
        flipRate,
        payout: parseFloat(r.winner_payout_multiple)
      });
    }

    // Update circuit breaker state for next iteration
    if (!wouldBeSkipped) {
      if (normalWon) {
        consecutiveLosses = 0;
      } else {
        consecutiveLosses++;
        if (consecutiveLosses >= 3) {
          cooldownUntilTimestamp = r.lock_timestamp + (45 * 60);
          consecutiveLosses = 0;
        }
      }
    }
  }

  return skippedTrades;
}

console.log('🔍 ANALYZING CIRCUIT BREAKER SKIPPED TRADES WITH INVERSE LOGIC\n');
console.log('═'.repeat(120));

const db = initDatabase('./prediction.db');
const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`\n📊 Total rounds: ${rounds.length}\n`);

const skipped = analyzeSkippedTrades(rounds);

console.log('═'.repeat(120));
console.log(`\n🚫 CIRCUIT BREAKER SKIPPED: ${skipped.length} trades\n`);
console.log('─'.repeat(120));

let normalWins = 0, normalLosses = 0;
let inverseWins = 0, inverseLosses = 0;
let choppyCount = 0;
let wouldFlip = 0;

for (const trade of skipped) {
  if (trade.normalWon) normalWins++;
  else normalLosses++;

  if (trade.inversedWon) inverseWins++;
  else inverseLosses++;

  if (trade.isChoppy) choppyCount++;
  if (trade.isChoppy && trade.normalSignal !== trade.inversedSignal) wouldFlip++;
}

console.log('📊 PERFORMANCE OF SKIPPED TRADES:\n');
console.log(`WITHOUT Inverse (normal contrarian):`);
console.log(`  Win Rate: ${((normalWins / skipped.length) * 100).toFixed(1)}% (${normalWins}W / ${normalLosses}L)`);
console.log();
console.log(`WITH Inverse (flip choppy trades):`);
console.log(`  Win Rate: ${((inverseWins / skipped.length) * 100).toFixed(1)}% (${inverseWins}W / ${inverseLosses}L)`);
console.log(`  Improvement: ${inverseWins - normalWins >= 0 ? '+' : ''}${inverseWins - normalWins} wins`);
console.log();
console.log(`Choppy Trades in Skipped: ${choppyCount} (${((choppyCount / skipped.length) * 100).toFixed(1)}%)`);
console.log(`Would be Inversed: ${wouldFlip}`);

console.log('\n' + '─'.repeat(120));
console.log('\n📋 DETAILED BREAKDOWN:\n');

console.log('Trade │ Epoch  │  Choppy  │ Normal Signal │ Inverse Signal │ Winner │ Normal Result │ Inverse Result │ FlipRate');
console.log('─'.repeat(120));

for (let i = 0; i < skipped.length; i++) {
  const t = skipped[i];
  const idx = String(i + 1).padStart(3);
  const epoch = String(t.epoch).padEnd(6);
  const choppy = t.isChoppy ? '   ✅   ' : '   ❌   ';
  const normal = t.normalSignal.padEnd(13);
  const inverse = t.inversedSignal.padEnd(14);
  const winner = t.winner.toUpperCase().padEnd(6);
  const normalResult = t.normalWon ? '      ✅ WIN     ' : '      ❌ LOSS    ';
  const inverseResult = t.inversedWon ? '       ✅ WIN    ' : '       ❌ LOSS   ';
  const flip = `${(t.flipRate * 100).toFixed(0)}%`.padStart(8);

  console.log(`${idx}   │ ${epoch} │ ${choppy} │ ${normal} │ ${inverse} │ ${winner} │ ${normalResult} │ ${inverseResult} │ ${flip}`);
}

console.log('\n' + '═'.repeat(120));
console.log('\n💡 ANALYSIS:\n');

const normalWR = (normalWins / skipped.length) * 100;
const inverseWR = (inverseWins / skipped.length) * 100;
const improvement = inverseWins - normalWins;

if (improvement > 0) {
  console.log(`✅ INVERSE STRATEGY WOULD IMPROVE SKIPPED TRADES!`);
  console.log();
  console.log(`   By using inverse logic, the ${skipped.length} skipped trades would go from:`);
  console.log(`   ${normalWR.toFixed(1)}% WR (${normalWins}W/${normalLosses}L) → ${inverseWR.toFixed(1)}% WR (${inverseWins}W/${inverseLosses}L)`);
  console.log();
  console.log(`   Net improvement: +${improvement} wins`);
  console.log();
  console.log(`   This means: Instead of SKIPPING these trades, we should TAKE them with inverse logic!`);
} else if (improvement < 0) {
  console.log(`❌ Inverse strategy would make skipped trades WORSE`);
  console.log();
  console.log(`   The circuit breaker is RIGHT to skip these trades.`);
  console.log(`   Even with inverse logic: ${inverseWR.toFixed(1)}% WR (${inverseWins}W/${inverseLosses}L)`);
} else {
  console.log(`⚖️  Inverse strategy has NO EFFECT on skipped trades`);
}

console.log('\n' + '═'.repeat(120));
console.log('\n🎯 WHAT ABOUT THE 13-LOSS STREAK?\n');
console.log('─'.repeat(120));

// Find consecutive losses in skipped trades
let maxStreak = 0;
let currentStreak = 0;
let maxStreakStart = -1;
let currentStreakStart = -1;

for (let i = 0; i < skipped.length; i++) {
  if (!skipped[i].normalWon) {
    if (currentStreak === 0) currentStreakStart = i;
    currentStreak++;
    if (currentStreak > maxStreak) {
      maxStreak = currentStreak;
      maxStreakStart = currentStreakStart;
    }
  } else {
    currentStreak = 0;
  }
}

if (maxStreak > 0) {
  console.log(`\nLongest loss streak in SKIPPED trades: ${maxStreak} consecutive losses`);
  console.log(`Starting at trade #${maxStreakStart + 1} (epoch ${skipped[maxStreakStart].epoch})\n`);

  // Check how many would be saved by inverse
  let savedByInverse = 0;
  for (let i = maxStreakStart; i < maxStreakStart + maxStreak && i < skipped.length; i++) {
    if (!skipped[i].normalWon && skipped[i].inversedWon) savedByInverse++;
  }

  if (savedByInverse > 0) {
    console.log(`✅ With inverse logic: ${savedByInverse} of these ${maxStreak} losses would become WINS!`);
    console.log(`   The streak would be reduced to ${maxStreak - savedByInverse} losses.`);
  } else {
    console.log(`❌ Inverse logic wouldn't help this streak.`);
  }
}

console.log('\n' + '═'.repeat(120));

db.close();
