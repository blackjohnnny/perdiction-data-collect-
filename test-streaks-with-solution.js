import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🎯 TESTING OPTIMAL STRATEGY ON ALL STREAKS\n');
console.log('═'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);
console.log('✅ Database initialized\n');

// Get all complete rounds
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

// Helper: Check if at local extreme
function isAtLocalExtreme(rounds, index, lookback = 14) {
  const startIdx = Math.max(0, index - lookback);
  const priceWindow = rounds.slice(startIdx, index + 1).map(r => {
    const lock = parseFloat(r.lock_price);
    return lock > 1000000 ? lock / 1e8 : lock;
  });

  if (priceWindow.length < 2) return { isTop: false, isBottom: false, position: 50 };

  const currentPrice = priceWindow[priceWindow.length - 1];
  const high = Math.max(...priceWindow);
  const low = Math.min(...priceWindow);
  const range = high - low;

  if (range === 0) return { isTop: false, isBottom: false, position: 50 };

  const position = ((currentPrice - low) / range) * 100;

  return {
    isTop: position >= 80,
    isBottom: position <= 20,
    position: position
  };
}

// Run BASELINE strategy
function runBaseline(rounds) {
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

    let betSide = null;
    if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BULL';
    } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
      betSide = 'BEAR';
    }

    if (!betSide) continue;

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

    tradeLog.push({
      epoch: r.epoch,
      timestamp: r.lock_timestamp,
      betSide,
      betSize,
      payout: actualPayout,
      won,
      profit,
      bankroll,
      emaGap
    });
  }

  return tradeLog;
}

// Run OPTIMAL strategy (Skip BULL at bottom + Reverse momentum)
function runOptimal(rounds) {
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
  let skippedBottom = 0;

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

    // FILTER: Skip BULL at bottom
    const extreme = isAtLocalExtreme(rounds, i, 14);
    if (betSide === 'BULL' && extreme.isBottom) {
      skippedBottom++;
      tradeLog.push({
        epoch: r.epoch,
        timestamp: r.lock_timestamp,
        betSide,
        skipped: true,
        reason: 'BULL at bottom',
        wouldHaveWon: r.winner.toLowerCase() === betSide.toLowerCase()
      });
      continue;
    }

    // REVERSE MOMENTUM: Bet BIG on weak signals
    let sizeMultiplier = 1.0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;
    if (!hasStrongSignal) { // REVERSED!
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

    tradeLog.push({
      epoch: r.epoch,
      timestamp: r.lock_timestamp,
      betSide,
      betSize,
      payout: actualPayout,
      won,
      profit,
      bankroll,
      emaGap,
      skipped: false
    });
  }

  console.log(`Skipped ${skippedBottom} BULL at bottom trades\n`);
  return tradeLog;
}

// Identify streaks
function findStreaks(tradeLog, minLength = 3) {
  const winStreaks = [];
  const lossStreaks = [];

  let currentStreak = [];
  let streakType = null;

  for (let i = 0; i < tradeLog.length; i++) {
    const trade = tradeLog[i];

    if (trade.skipped) continue; // Skip filtered trades

    if (streakType === null) {
      streakType = trade.won ? 'win' : 'loss';
      currentStreak.push(trade);
    } else if ((streakType === 'win' && trade.won) || (streakType === 'loss' && !trade.won)) {
      currentStreak.push(trade);
    } else {
      // Streak ended
      if (currentStreak.length >= minLength) {
        if (streakType === 'win') {
          winStreaks.push([...currentStreak]);
        } else {
          lossStreaks.push([...currentStreak]);
        }
      }
      streakType = trade.won ? 'win' : 'loss';
      currentStreak = [trade];
    }
  }

  // Handle last streak
  if (currentStreak.length >= minLength) {
    if (streakType === 'win') {
      winStreaks.push(currentStreak);
    } else {
      lossStreaks.push(currentStreak);
    }
  }

  return { winStreaks, lossStreaks };
}

// Compare streaks
function compareStreaks() {
  console.log('🔄 Running BASELINE strategy...\n');
  const baselineLog = runBaseline(rounds);
  const baselineStreaks = findStreaks(baselineLog, 3);

  console.log('🔄 Running OPTIMAL strategy (Skip BULL at bottom + Reverse momentum)...\n');
  const optimalLog = runOptimal(rounds);
  const optimalStreaks = findStreaks(optimalLog, 3);

  console.log('═'.repeat(100) + '\n');
  console.log('📉 LOSS STREAKS COMPARISON\n');
  console.log('═'.repeat(100) + '\n');

  console.log(`BASELINE: ${baselineStreaks.lossStreaks.length} loss streaks (≥3 losses)\n`);

  for (let i = 0; i < baselineStreaks.lossStreaks.length; i++) {
    const streak = baselineStreaks.lossStreaks[i];
    const startBankroll = i === 0 ? 1.0 : baselineLog[baselineLog.indexOf(streak[0]) - 1]?.bankroll || 1.0;
    const endBankroll = streak[streak.length - 1].bankroll;
    const drawdown = ((endBankroll - startBankroll) / startBankroll) * 100;

    console.log(`Loss Streak #${i + 1}: ${streak.length} consecutive losses`);
    console.log(`  Epochs: ${streak[0].epoch} → ${streak[streak.length - 1].epoch}`);
    console.log(`  Bankroll: ${startBankroll.toFixed(3)} → ${endBankroll.toFixed(3)} BNB (${drawdown.toFixed(2)}%)`);

    // Check if any would be skipped in optimal
    const skippedCount = streak.filter(t => {
      const roundIdx = rounds.findIndex(r => r.epoch === t.epoch);
      if (roundIdx === -1) return false;
      const extreme = isAtLocalExtreme(rounds, roundIdx, 14);
      return t.betSide === 'BULL' && extreme.isBottom;
    }).length;

    if (skippedCount > 0) {
      console.log(`  🎯 OPTIMAL would skip: ${skippedCount}/${streak.length} trades`);
    }
    console.log();
  }

  console.log('─'.repeat(100) + '\n');
  console.log(`OPTIMAL: ${optimalStreaks.lossStreaks.length} loss streaks (≥3 losses)\n`);

  for (let i = 0; i < optimalStreaks.lossStreaks.length; i++) {
    const streak = optimalStreaks.lossStreaks[i];
    const startBankroll = i === 0 ? 1.0 : optimalLog[optimalLog.indexOf(streak[0]) - 1]?.bankroll || 1.0;
    const endBankroll = streak[streak.length - 1].bankroll;
    const drawdown = ((endBankroll - startBankroll) / startBankroll) * 100;

    console.log(`Loss Streak #${i + 1}: ${streak.length} consecutive losses`);
    console.log(`  Epochs: ${streak[0].epoch} → ${streak[streak.length - 1].epoch}`);
    console.log(`  Bankroll: ${startBankroll.toFixed(3)} → ${endBankroll.toFixed(3)} BNB (${drawdown.toFixed(2)}%)`);
    console.log();
  }

  console.log('═'.repeat(100) + '\n');
  console.log('📈 WIN STREAKS COMPARISON\n');
  console.log('═'.repeat(100) + '\n');

  console.log(`BASELINE: ${baselineStreaks.winStreaks.length} win streaks (≥3 wins)\n`);

  for (let i = 0; i < baselineStreaks.winStreaks.length; i++) {
    const streak = baselineStreaks.winStreaks[i];
    const startBankroll = i === 0 ? 1.0 : baselineLog[baselineLog.indexOf(streak[0]) - 1]?.bankroll || 1.0;
    const endBankroll = streak[streak.length - 1].bankroll;
    const gain = ((endBankroll - startBankroll) / startBankroll) * 100;

    console.log(`Win Streak #${i + 1}: ${streak.length} consecutive wins`);
    console.log(`  Epochs: ${streak[0].epoch} → ${streak[streak.length - 1].epoch}`);
    console.log(`  Bankroll: ${startBankroll.toFixed(3)} → ${endBankroll.toFixed(3)} BNB (+${gain.toFixed(2)}%)`);
    console.log();
  }

  console.log('─'.repeat(100) + '\n');
  console.log(`OPTIMAL: ${optimalStreaks.winStreaks.length} win streaks (≥3 wins)\n`);

  for (let i = 0; i < optimalStreaks.winStreaks.length; i++) {
    const streak = optimalStreaks.winStreaks[i];
    const startBankroll = i === 0 ? 1.0 : optimalLog[optimalLog.indexOf(streak[0]) - 1]?.bankroll || 1.0;
    const endBankroll = streak[streak.length - 1].bankroll;
    const gain = ((endBankroll - startBankroll) / startBankroll) * 100;

    console.log(`Win Streak #${i + 1}: ${streak.length} consecutive wins`);
    console.log(`  Epochs: ${streak[0].epoch} → ${streak[streak.length - 1].epoch}`);
    console.log(`  Bankroll: ${startBankroll.toFixed(3)} → ${endBankroll.toFixed(3)} BNB (+${gain.toFixed(2)}%)`);
    console.log();
  }

  console.log('═'.repeat(100) + '\n');
  console.log('📊 SUMMARY\n');
  console.log('═'.repeat(100) + '\n');

  console.log('BASELINE:');
  console.log(`  Loss Streaks: ${baselineStreaks.lossStreaks.length} (≥3 losses)`);
  console.log(`  Win Streaks: ${baselineStreaks.winStreaks.length} (≥3 wins)`);
  console.log(`  Final Bankroll: ${baselineLog[baselineLog.length - 1].bankroll.toFixed(3)} BNB\n`);

  console.log('OPTIMAL:');
  console.log(`  Loss Streaks: ${optimalStreaks.lossStreaks.length} (≥3 losses)`);
  console.log(`  Win Streaks: ${optimalStreaks.winStreaks.length} (≥3 wins)`);
  console.log(`  Final Bankroll: ${optimalLog[optimalLog.length - 1].bankroll.toFixed(3)} BNB\n`);

  const lossStreakReduction = baselineStreaks.lossStreaks.length - optimalStreaks.lossStreaks.length;
  const winStreakChange = optimalStreaks.winStreaks.length - baselineStreaks.winStreaks.length;

  console.log('IMPROVEMENTS:');
  console.log(`  Loss Streaks: ${lossStreakReduction > 0 ? '-' : '+'}${Math.abs(lossStreakReduction)} (${lossStreakReduction > 0 ? 'BETTER' : 'WORSE'})`);
  console.log(`  Win Streaks: ${winStreakChange > 0 ? '+' : ''}${winStreakChange} (${winStreakChange >= 0 ? 'MORE' : 'FEWER'})`);
  console.log(`  Bankroll Gain: ${((optimalLog[optimalLog.length - 1].bankroll / baselineLog[baselineLog.length - 1].bankroll - 1) * 100).toFixed(2)}%`);

  console.log('\n' + '═'.repeat(100));
}

compareStreaks();

db.close();
