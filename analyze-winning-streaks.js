import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🔥 DEEP DIVE: WINNING STREAKS WITH DYNAMIC POSITION SIZING\n');
console.log('═'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

// Get all complete rounds with EMA data
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

// Fakeout detection
function detectFakeout(rounds, index, signal) {
  if (index < 2 || index >= rounds.length - 1) return false;

  const current = rounds[index];
  const prev = rounds[index - 1];

  const currentGap = Math.abs(parseFloat(current.ema_gap));
  const prevGap = Math.abs(parseFloat(prev.ema_gap));

  const bullWei = parseFloat(current.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(current.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;
  if (total === 0) return false;

  const bullPct = (bullWei / total) * 100;
  const bearPct = (bearWei / total) * 100;

  const lookback = 14;
  const startIdx = Math.max(0, index - lookback);
  const priceWindow = rounds.slice(startIdx, index + 1);
  const prices = priceWindow.map(r => {
    const lock = Number(r.lock_price);
    const close = Number(r.close_price);
    if (lock > 0) return lock / 1e8;
    if (close > 0) return close / 1e8;
    return 0;
  }).filter(p => p > 0);

  if (prices.length === 0) return false;

  const highest = Math.max(...prices);
  const lowest = Math.min(...prices);
  const range = highest - lowest;
  if (range === 0) return false;

  const currentLock = Number(current.lock_price);
  const currentClose = Number(current.close_price);
  const currentPrice = currentLock > 0 ? currentLock / 1e8 : currentClose > 0 ? currentClose / 1e8 : 0;
  if (currentPrice === 0) return false;

  const pricePosition = (currentPrice - lowest) / range;

  let fakeoutScore = 0;

  if (currentGap < prevGap * 0.8) fakeoutScore += 1;
  if (signal === 'BULL' && bullPct > 80) fakeoutScore += 1;
  else if (signal === 'BEAR' && bearPct > 80) fakeoutScore += 1;
  if (signal === 'BULL' && pricePosition > 0.8) fakeoutScore += 1;
  else if (signal === 'BEAR' && pricePosition < 0.2) fakeoutScore += 1;

  return fakeoutScore >= 2;
}

// Run strategy and capture detailed streak info
function runStrategyWithStreaks() {
  const CONFIG = {
    BASE_POSITION_SIZE: 0.045,
    MOMENTUM_MULTIPLIER: 1.889,
    RECOVERY_MULTIPLIER: 1.5,
    MIN_PAYOUT: 1.45,
    STARTING_BANKROLL: 1.0
  };

  let bankroll = CONFIG.STARTING_BANKROLL;
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

    let betSide = null;

    // CONTRARIAN: EMA + Against Crowd
    if (emaSignal === 'BULL' && bearPayout >= CONFIG.MIN_PAYOUT) {
      betSide = 'BULL';
    } else if (emaSignal === 'BEAR' && bullPayout >= CONFIG.MIN_PAYOUT) {
      betSide = 'BEAR';
    }

    if (!betSide) continue;

    // Fakeout filter
    const isFakeout = detectFakeout(rounds, i, emaSignal);
    if (isFakeout) continue;

    // Position sizing with dynamic multipliers
    let sizeMultiplier = 1.0;
    const hasMomentum = Math.abs(emaGap) >= 0.15;
    const hasRecovery = lastTwoResults[0] === 'LOSS';

    if (hasMomentum) {
      sizeMultiplier = CONFIG.MOMENTUM_MULTIPLIER;
    }
    if (hasRecovery) {
      sizeMultiplier *= CONFIG.RECOVERY_MULTIPLIER;
    }

    const positionPercent = CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    const betSize = bankroll * positionPercent;
    const won = betSide.toLowerCase() === r.winner.toLowerCase();
    const actualPayout = parseFloat(r.winner_payout_multiple);

    const oldBankroll = bankroll;

    if (won) {
      const profit = betSize * (actualPayout - 1);
      bankroll += profit;
      lastTwoResults.unshift('WIN');

      tradeLog.push({
        epoch: r.epoch,
        timestamp: r.lock_timestamp,
        betSide,
        emaSignal,
        emaGap,
        won: true,
        betSize,
        positionPercent,
        hasMomentum,
        hasRecovery,
        actualPayout,
        profit,
        oldBankroll,
        newBankroll: bankroll,
        multiplier: sizeMultiplier
      });

    } else {
      bankroll -= betSize;
      lastTwoResults.unshift('LOSS');

      tradeLog.push({
        epoch: r.epoch,
        timestamp: r.lock_timestamp,
        betSide,
        emaSignal,
        emaGap,
        won: false,
        betSize,
        positionPercent,
        hasMomentum,
        hasRecovery,
        actualPayout,
        profit: -betSize,
        oldBankroll,
        newBankroll: bankroll,
        multiplier: sizeMultiplier
      });
    }

    if (lastTwoResults.length > 2) lastTwoResults.pop();
  }

  return tradeLog;
}

const tradeLog = runStrategyWithStreaks();

// Find winning streaks
const streaks = [];
let currentStreak = [];

for (const trade of tradeLog) {
  if (trade.won) {
    currentStreak.push(trade);
  } else {
    if (currentStreak.length >= 5) {
      streaks.push([...currentStreak]);
    }
    currentStreak = [];
  }
}
if (currentStreak.length >= 5) {
  streaks.push(currentStreak);
}

console.log(`Found ${streaks.length} winning streaks of 5+ trades\n`);
console.log('═'.repeat(100) + '\n');

// Analyze each streak in detail
streaks.forEach((streak, idx) => {
  console.log(`🔥 WINNING STREAK #${idx + 1} - ${streak.length} consecutive wins\n`);
  console.log('─'.repeat(100) + '\n');

  const startDate = new Date(streak[0].timestamp * 1000).toISOString().split('T')[0];
  const endDate = new Date(streak[streak.length - 1].timestamp * 1000).toISOString().split('T')[0];
  const startBankroll = streak[0].oldBankroll;
  const endBankroll = streak[streak.length - 1].newBankroll;
  const totalProfit = endBankroll - startBankroll;
  const roi = ((endBankroll - startBankroll) / startBankroll) * 100;

  console.log(`📅 Period: ${startDate} to ${endDate}`);
  console.log(`💰 Bankroll Growth: ${startBankroll.toFixed(6)} → ${endBankroll.toFixed(6)} BNB`);
  console.log(`📈 Profit: +${totalProfit.toFixed(6)} BNB (+${roi.toFixed(2)}% ROI)\n`);

  console.log('📋 Trade-by-Trade Breakdown:\n');

  streak.forEach((trade, i) => {
    const date = new Date(trade.timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19);
    const momentum = trade.hasMomentum ? '🔥' : '  ';
    const recovery = trade.hasRecovery ? '🔄' : '  ';
    const emaDir = trade.emaGap > 0 ? '📈' : '📉';

    console.log(`  ${(i + 1).toString().padStart(2)}. ${date} | Epoch ${trade.epoch}`);
    console.log(`      ${emaDir} EMA ${trade.emaSignal} (${(trade.emaGap * 100).toFixed(2)}%) ${momentum}${recovery}`);
    console.log(`      Bet: ${trade.betSide} | Size: ${trade.betSize.toFixed(6)} BNB (${(trade.positionPercent * 100).toFixed(2)}%)`);
    console.log(`      Payout: ${trade.actualPayout.toFixed(2)}x | Profit: +${trade.profit.toFixed(6)} BNB`);
    console.log(`      Bankroll: ${trade.oldBankroll.toFixed(6)} → ${trade.newBankroll.toFixed(6)}\n`);
  });

  console.log('─'.repeat(100) + '\n');
});

// Overall summary
console.log('📊 WINNING STREAKS SUMMARY\n');
console.log('═'.repeat(100) + '\n');

const totalStreakTrades = streaks.reduce((sum, s) => sum + s.length, 0);
const totalStreakProfit = streaks.reduce((sum, streak) => {
  const start = streak[0].oldBankroll;
  const end = streak[streak.length - 1].newBankroll;
  return sum + (end - start);
}, 0);

const avgStreakLength = totalStreakTrades / streaks.length;
const longestStreak = Math.max(...streaks.map(s => s.length));

console.log(`Total Streaks (5+):           ${streaks.length}`);
console.log(`Total Trades in Streaks:      ${totalStreakTrades}`);
console.log(`Average Streak Length:        ${avgStreakLength.toFixed(1)} trades`);
console.log(`Longest Streak:               ${longestStreak} trades`);
console.log(`Total Profit from Streaks:    +${totalStreakProfit.toFixed(6)} BNB`);
console.log(`Average Profit per Streak:    +${(totalStreakProfit / streaks.length).toFixed(6)} BNB\n`);

// Calculate overall strategy performance
const totalTrades = tradeLog.length;
const wins = tradeLog.filter(t => t.won).length;
const losses = tradeLog.filter(t => !t.won).length;
const finalBankroll = tradeLog[tradeLog.length - 1].newBankroll;
const totalProfit = finalBankroll - 1.0;

console.log('📈 Overall Strategy Performance (EMA 3/7 Contrarian):\n');
console.log(`Total Trades:                 ${totalTrades}`);
console.log(`Wins:                         ${wins} (${((wins/totalTrades)*100).toFixed(2)}%)`);
console.log(`Losses:                       ${losses}`);
console.log(`Final Bankroll:               ${finalBankroll.toFixed(6)} BNB`);
console.log(`Total Profit:                 +${totalProfit.toFixed(6)} BNB`);
console.log(`Total ROI:                    +${((totalProfit / 1.0) * 100).toFixed(2)}%\n`);

console.log(`Streak Profit % of Total:     ${((totalStreakProfit / totalProfit) * 100).toFixed(1)}%`);
console.log(`Non-Streak Profit:            +${(totalProfit - totalStreakProfit).toFixed(6)} BNB\n`);

console.log('═'.repeat(100) + '\n');

db.close();
