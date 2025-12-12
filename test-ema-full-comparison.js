import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🔍 FULL DATABASE COMPARISON: EMA 3/7 vs EMA 8/21\n');
console.log('═'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

// Get all complete rounds with EMA data
const rounds = db.prepare(`
  SELECT
    sample_id,
    epoch,
    lock_timestamp,
    lock_price,
    close_price,
    t20s_bull_wei,
    t20s_bear_wei,
    winner,
    winner_payout_multiple,
    ema_signal,
    ema_gap,
    ema3,
    ema7
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Testing on ${rounds.length} complete rounds with EMA data\n`);

if (rounds.length === 0) {
  console.log('❌ No rounds with EMA data found\n');
  db.close();
  process.exit(0);
}

console.log(`   Date range: ${new Date(rounds[0].lock_timestamp * 1000).toISOString()}`);
console.log(`            to ${new Date(rounds[rounds.length - 1].lock_timestamp * 1000).toISOString()}\n`);
console.log('─'.repeat(100) + '\n');

// Calculate EMA 8/21 from lock prices
function calculateEMA8_21(rounds, index) {
  if (index < 20) return null;

  const window = rounds.slice(index - 20, index + 1);
  const prices = window.map(r => {
    const lock = Number(r.lock_price);
    const close = Number(r.close_price);
    if (lock > 0) return lock / 1e8;
    if (close > 0) return close / 1e8;
    return null;
  }).filter(p => p !== null);

  if (prices.length < 21) return null;

  const ema8 = prices.slice(-8).reduce((a, b) => a + b) / 8;
  const ema21 = prices.slice(-21).reduce((a, b) => a + b) / 21;
  const gap = ((ema8 - ema21) / ema21) * 100;
  const signal = gap > 0.05 ? 'BULL' : gap < -0.05 ? 'BEAR' : 'NEUTRAL';

  return { signal, gap, ema8, ema21 };
}

// Fakeout detection
function detectFakeout(rounds, index, signal, emaGap) {
  if (index < 2 || index >= rounds.length - 1) return false;

  const current = rounds[index];
  const prev = rounds[index - 1];

  const currentGap = Math.abs(parseFloat(emaGap));
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

// Run strategy
function runStrategy(rounds, useEMA8_21 = false, contrarian = true) {
  const CONFIG = {
    BASE_POSITION_SIZE: 0.045,
    MOMENTUM_MULTIPLIER: 1.889,
    RECOVERY_MULTIPLIER: 1.5,
    MIN_PAYOUT: 1.45,
    STARTING_BANKROLL: 1.0
  };

  let bankroll = CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let wins = 0;
  let losses = 0;
  let totalProfit = 0;
  let maxBankroll = CONFIG.STARTING_BANKROLL;
  let minBankroll = CONFIG.STARTING_BANKROLL;
  let maxDrawdown = 0;
  let currentStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let currentStreakType = null;

  const tradeLog = [];

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    let emaSignal, emaGap;

    if (useEMA8_21) {
      const ema = calculateEMA8_21(rounds, i);
      if (!ema || ema.signal === 'NEUTRAL') continue;
      emaSignal = ema.signal;
      emaGap = ema.gap;
    } else {
      emaSignal = r.ema_signal;
      emaGap = parseFloat(r.ema_gap);
      if (!emaSignal || emaSignal === 'NEUTRAL') continue;
    }

    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPercent = (bullWei / total) * 100;
    const bearPercent = (bearWei / total) * 100;
    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    let betSide = null;

    if (contrarian) {
      // CONTRARIAN: EMA + Against Crowd
      if (emaSignal === 'BULL' && bearPayout >= CONFIG.MIN_PAYOUT) {
        betSide = 'BULL';
      } else if (emaSignal === 'BEAR' && bullPayout >= CONFIG.MIN_PAYOUT) {
        betSide = 'BEAR';
      }
    } else {
      // CONSENSUS: EMA + With Crowd
      const crowdFavorite = bullPercent > bearPercent ? 'BULL' : 'BEAR';
      if (emaSignal === crowdFavorite) {
        betSide = emaSignal;
      }
    }

    if (!betSide) continue;

    // Fakeout filter
    const isFakeout = detectFakeout(rounds, i, emaSignal, emaGap);
    if (isFakeout) continue;

    // Position sizing
    let sizeMultiplier = 1.0;
    if (Math.abs(emaGap) >= 0.15) {
      sizeMultiplier = CONFIG.MOMENTUM_MULTIPLIER;
    }
    if (lastTwoResults[0] === 'LOSS') {
      sizeMultiplier *= CONFIG.RECOVERY_MULTIPLIER;
    }

    const betSize = bankroll * CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    const won = betSide.toLowerCase() === r.winner.toLowerCase();
    const actualPayout = parseFloat(r.winner_payout_multiple);

    if (won) {
      const profit = betSize * (actualPayout - 1);
      bankroll += profit;
      totalProfit += profit;
      wins++;
      lastTwoResults.unshift('WIN');

      if (currentStreakType === 'WIN') {
        currentStreak++;
      } else {
        currentStreak = 1;
        currentStreakType = 'WIN';
      }
      maxWinStreak = Math.max(maxWinStreak, currentStreak);

    } else {
      bankroll -= betSize;
      totalProfit -= betSize;
      losses++;
      lastTwoResults.unshift('LOSS');

      if (currentStreakType === 'LOSS') {
        currentStreak++;
      } else {
        currentStreak = 1;
        currentStreakType = 'LOSS';
      }
      maxLossStreak = Math.max(maxLossStreak, currentStreak);
    }

    if (lastTwoResults.length > 2) lastTwoResults.pop();

    maxBankroll = Math.max(maxBankroll, bankroll);
    minBankroll = Math.min(minBankroll, bankroll);
    const drawdown = ((maxBankroll - bankroll) / maxBankroll) * 100;
    maxDrawdown = Math.max(maxDrawdown, drawdown);

    tradeLog.push({
      index: i,
      epoch: r.epoch,
      timestamp: r.lock_timestamp,
      betSide,
      emaSignal,
      emaGap,
      won,
      actualPayout,
      bankroll,
      profit: won ? betSize * (actualPayout - 1) : -betSize
    });
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = (totalProfit / CONFIG.STARTING_BANKROLL) * 100;

  return {
    trades: totalTrades,
    wins,
    losses,
    winRate,
    roi,
    finalBankroll: bankroll,
    profit: totalProfit,
    maxBankroll,
    minBankroll,
    maxDrawdown,
    maxWinStreak,
    maxLossStreak,
    tradeLog
  };
}

console.log('🔄 Running strategies...\n');

const ema37_contrarian = runStrategy(rounds, false, true);
const ema821_contrarian = runStrategy(rounds, true, true);
const ema37_consensus = runStrategy(rounds, false, false);
const ema821_consensus = runStrategy(rounds, true, false);

console.log('═'.repeat(100) + '\n');
console.log('📊 FULL DATABASE RESULTS\n');
console.log('═'.repeat(100) + '\n');

function printResults(name, result) {
  console.log(`${name}:\n`);
  console.log(`  Total Trades:        ${result.trades}`);
  console.log(`  Wins:                ${result.wins} (${result.winRate.toFixed(2)}%)`);
  console.log(`  Losses:              ${result.losses}`);
  console.log(`  ROI:                 ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(2)}%`);
  console.log(`  Final Bankroll:      ${result.finalBankroll.toFixed(6)} BNB`);
  console.log(`  Profit:              ${result.profit >= 0 ? '+' : ''}${result.profit.toFixed(6)} BNB`);
  console.log(`  Max Drawdown:        ${result.maxDrawdown.toFixed(2)}%`);
  console.log(`  Max Win Streak:      ${result.maxWinStreak}`);
  console.log(`  Max Loss Streak:     ${result.maxLossStreak}\n`);
}

console.log('🎯 CONTRARIAN STRATEGIES (EMA + Against Crowd):\n');
console.log('─'.repeat(100) + '\n');
printResults('EMA 3/7 Contrarian', ema37_contrarian);
printResults('EMA 8/21 Contrarian', ema821_contrarian);

console.log('─'.repeat(100) + '\n');
console.log('🤝 CONSENSUS STRATEGIES (EMA + With Crowd):\n');
console.log('─'.repeat(100) + '\n');
printResults('EMA 3/7 Consensus', ema37_consensus);
printResults('EMA 8/21 Consensus', ema821_consensus);

console.log('═'.repeat(100) + '\n');
console.log('📈 PERFORMANCE COMPARISON\n');
console.log('═'.repeat(100) + '\n');

const strategies = [
  { name: 'EMA 3/7 Contrarian', ...ema37_contrarian },
  { name: 'EMA 8/21 Contrarian', ...ema821_contrarian },
  { name: 'EMA 3/7 Consensus', ...ema37_consensus },
  { name: 'EMA 8/21 Consensus', ...ema821_consensus }
].sort((a, b) => b.roi - a.roi);

console.log('Ranked by ROI:\n');
strategies.forEach((s, i) => {
  const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
  const roiStr = s.roi >= 0 ? `+${s.roi.toFixed(2)}%` : `${s.roi.toFixed(2)}%`;
  console.log(`${medal} ${(i+1)}. ${s.name.padEnd(25)} | ${s.trades.toString().padStart(3)} trades | ${s.winRate.toFixed(1).padStart(5)}% WR | ${roiStr.padStart(10)} ROI`);
});

console.log('\n' + '═'.repeat(100) + '\n');

// Analyze winning streaks
console.log('🔥 PERFORMANCE DURING WINNING STREAKS (5+ consecutive wins)\n');
console.log('═'.repeat(100) + '\n');

function analyzeWinningStreaks(result, name) {
  const streaks = [];
  let currentStreak = [];

  for (const trade of result.tradeLog) {
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

  if (streaks.length === 0) {
    console.log(`${name}: No 5+ win streaks found\n`);
    return;
  }

  const totalStreaks = streaks.length;
  const totalStreakTrades = streaks.reduce((sum, s) => sum + s.length, 0);
  const totalStreakProfit = streaks.reduce((sum, streak) => {
    return sum + streak.reduce((p, t) => p + t.profit, 0);
  }, 0);
  const avgStreakLength = totalStreakTrades / totalStreaks;

  console.log(`${name}:\n`);
  console.log(`  Number of 5+ win streaks:     ${totalStreaks}`);
  console.log(`  Total trades in streaks:      ${totalStreakTrades}`);
  console.log(`  Average streak length:        ${avgStreakLength.toFixed(1)} trades`);
  console.log(`  Total profit from streaks:    +${totalStreakProfit.toFixed(6)} BNB`);
  console.log(`  % of total profit:            ${result.profit > 0 ? ((totalStreakProfit / result.profit) * 100).toFixed(1) : 'N/A'}%`);
  console.log(`  Longest streak:               ${Math.max(...streaks.map(s => s.length))} trades\n`);
}

analyzeWinningStreaks(ema37_contrarian, 'EMA 3/7 Contrarian');
analyzeWinningStreaks(ema821_contrarian, 'EMA 8/21 Contrarian');
analyzeWinningStreaks(ema37_consensus, 'EMA 3/7 Consensus');
analyzeWinningStreaks(ema821_consensus, 'EMA 8/21 Consensus');

console.log('═'.repeat(100) + '\n');

// Key insights
console.log('💡 KEY INSIGHTS:\n');
console.log('─'.repeat(100) + '\n');

const best = strategies[0];
const baseline = strategies.find(s => s.name === 'EMA 3/7 Contrarian');
const improvement = best.roi - baseline.roi;

console.log(`1. Best Overall: ${best.name}`);
console.log(`   ${best.trades} trades | ${best.winRate.toFixed(1)}% WR | ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(2)}% ROI\n`);

console.log(`2. vs Baseline (EMA 3/7 Contrarian):`);
console.log(`   Improvement: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(2)}% ROI`);
console.log(`   Win Rate: ${baseline.winRate.toFixed(1)}% → ${best.winRate.toFixed(1)}% (${(best.winRate - baseline.winRate >= 0 ? '+' : '')}${(best.winRate - baseline.winRate).toFixed(1)}%)\n`);

console.log(`3. Contrarian vs Consensus:`);
const bestContrarian = strategies.find(s => s.name.includes('Contrarian'));
const bestConsensus = strategies.find(s => s.name.includes('Consensus'));
console.log(`   Best Contrarian: ${bestContrarian.name} (${bestContrarian.roi.toFixed(2)}% ROI)`);
console.log(`   Best Consensus: ${bestConsensus.name} (${bestConsensus.roi.toFixed(2)}% ROI)`);
console.log(`   ${bestContrarian.roi > bestConsensus.roi ? 'Contrarian wins' : 'Consensus wins'} by ${Math.abs(bestContrarian.roi - bestConsensus.roi).toFixed(2)}%\n`);

console.log(`4. EMA 3/7 vs EMA 8/21:`);
const ema37_best = Math.max(ema37_contrarian.roi, ema37_consensus.roi);
const ema821_best = Math.max(ema821_contrarian.roi, ema821_consensus.roi);
console.log(`   EMA 3/7 best: ${ema37_best.toFixed(2)}% ROI`);
console.log(`   EMA 8/21 best: ${ema821_best.toFixed(2)}% ROI`);
console.log(`   ${ema821_best > ema37_best ? 'EMA 8/21 wins' : 'EMA 3/7 wins'} by ${Math.abs(ema821_best - ema37_best).toFixed(2)}%\n`);

console.log('═'.repeat(100) + '\n');

db.close();
