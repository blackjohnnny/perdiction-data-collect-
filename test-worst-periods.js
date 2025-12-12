import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🔍 ANALYZING WORST PERFORMANCE PERIODS\n');
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
    lock_bull_wei,
    lock_bear_wei,
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

console.log(`📊 Analyzing ${rounds.length} complete rounds\n`);
console.log('─'.repeat(100) + '\n');

// Configuration
const CONFIG = {
  CROWD_THRESHOLD: 0.65,
  EMA_GAP_THRESHOLD: 0.05,
  MAX_PAYOUT: 1.45,
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  STARTING_BANKROLL: 1.0
};

// Multi-factor fakeout detection
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
  const prices = priceWindow.map(r => Number(r.lock_price) / 1e8);
  const highest = Math.max(...prices);
  const lowest = Math.min(...prices);
  const range = highest - lowest;
  if (range === 0) return false;

  const currentPrice = Number(current.lock_price) / 1e8;
  const pricePosition = (currentPrice - lowest) / range;

  let fakeoutScore = 0;

  if (currentGap < prevGap * 0.8) fakeoutScore += 1;
  if (signal === 'BULL' && bullPct > 80) fakeoutScore += 1;
  else if (signal === 'BEAR' && bearPct > 80) fakeoutScore += 1;
  if (signal === 'BULL' && pricePosition > 0.8) fakeoutScore += 1;
  else if (signal === 'BEAR' && pricePosition < 0.2) fakeoutScore += 1;

  return fakeoutScore >= 2;
}

// Trading state
let bankroll = CONFIG.STARTING_BANKROLL;
let lastTwoResults = [];
let totalTrades = 0;

const allTrades = [];

// Process rounds and execute trades
for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];

  const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;

  if (total === 0) continue;

  const bullPercent = (bullWei / total) * 100;
  const bearPercent = (bearWei / total) * 100;

  const estimatedPayout = bullPercent > bearPercent
    ? total / bullWei
    : total / bearWei;

  const emaSignal = r.ema_signal;
  const emaGap = parseFloat(r.ema_gap);

  if (!emaSignal || emaSignal === 'NEUTRAL') continue;
  if (estimatedPayout < CONFIG.MAX_PAYOUT) continue;

  const isFakeout = detectFakeout(rounds, i, emaSignal);
  if (isFakeout) continue;

  const betSide = emaSignal === 'BULL' ? 'BULL' : 'BEAR';

  let sizeMultiplier = 1.0;
  if (Math.abs(emaGap) >= 0.15) {
    sizeMultiplier = CONFIG.MOMENTUM_MULTIPLIER;
  }
  if (lastTwoResults[0] === 'LOSS') {
    sizeMultiplier *= CONFIG.RECOVERY_MULTIPLIER;
  }

  const betSize = bankroll * CONFIG.BASE_POSITION_SIZE * sizeMultiplier;

  totalTrades++;
  const won = betSide.toLowerCase() === r.winner.toLowerCase();
  const actualPayout = parseFloat(r.winner_payout_multiple);

  let tradePnL;
  let newBankroll;

  if (won) {
    tradePnL = betSize * (actualPayout - 1);
    newBankroll = bankroll + tradePnL;
    lastTwoResults.unshift('WIN');
  } else {
    tradePnL = -betSize;
    newBankroll = bankroll - betSize;
    lastTwoResults.unshift('LOSS');
  }

  if (lastTwoResults.length > 2) lastTwoResults.pop();

  const oldBankroll = bankroll;
  bankroll = newBankroll;

  allTrades.push({
    tradeNum: totalTrades,
    epoch: r.epoch,
    timestamp: r.lock_timestamp,
    betSide,
    betSize,
    won,
    actualPayout,
    tradePnL,
    oldBankroll,
    newBankroll,
    date: new Date(r.lock_timestamp * 1000).toISOString()
  });
}

console.log(`✅ Executed ${allTrades.length} trades total\n`);
console.log('═'.repeat(100) + '\n');

// Analyze losing streaks
console.log('🔴 WORST LOSING STREAKS:\n');

let currentStreak = 0;
let maxStreak = 0;
let streaks = [];
let streakStart = -1;

for (let i = 0; i < allTrades.length; i++) {
  if (!allTrades[i].won) {
    if (currentStreak === 0) {
      streakStart = i;
    }
    currentStreak++;
    maxStreak = Math.max(maxStreak, currentStreak);
  } else {
    if (currentStreak >= 3) {
      streaks.push({
        start: streakStart,
        end: i - 1,
        length: currentStreak,
        startTrade: allTrades[streakStart].tradeNum,
        endTrade: allTrades[i - 1].tradeNum,
        startDate: allTrades[streakStart].date,
        endDate: allTrades[i - 1].date,
        bankrollBefore: allTrades[streakStart].oldBankroll,
        bankrollAfter: allTrades[i - 1].newBankroll,
        loss: allTrades[streakStart].oldBankroll - allTrades[i - 1].newBankroll
      });
    }
    currentStreak = 0;
  }
}

// Check if streak continues to end
if (currentStreak >= 3) {
  const i = allTrades.length - 1;
  streaks.push({
    start: streakStart,
    end: i,
    length: currentStreak,
    startTrade: allTrades[streakStart].tradeNum,
    endTrade: allTrades[i].tradeNum,
    startDate: allTrades[streakStart].date,
    endDate: allTrades[i].date,
    bankrollBefore: allTrades[streakStart].oldBankroll,
    bankrollAfter: allTrades[i].newBankroll,
    loss: allTrades[streakStart].oldBankroll - allTrades[i].newBankroll
  });
}

// Sort by length
streaks.sort((a, b) => b.length - a.length);

console.log(`  Maximum losing streak: ${maxStreak} consecutive losses\n`);
console.log(`  Losing streaks of 3+: ${streaks.length}\n`);

if (streaks.length > 0) {
  console.log('  Top 5 longest losing streaks:\n');
  for (let i = 0; i < Math.min(5, streaks.length); i++) {
    const s = streaks[i];
    const lossPct = ((s.loss / s.bankrollBefore) * 100).toFixed(2);
    console.log(`  ${i + 1}. ${s.length} consecutive losses`);
    console.log(`     Trades #${s.startTrade} - #${s.endTrade}`);
    console.log(`     ${s.startDate.substring(0, 19)} → ${s.endDate.substring(0, 19)}`);
    console.log(`     Bankroll: ${s.bankrollBefore.toFixed(4)} → ${s.bankrollAfter.toFixed(4)} (-${lossPct}%)`);
    console.log('');
  }
}

console.log('─'.repeat(100) + '\n');

// Analyze rolling win rate (20-trade windows)
console.log('📉 WORST WIN RATE PERIODS (20-trade windows):\n');

const windowSize = 20;
let worstPeriods = [];

for (let i = 0; i <= allTrades.length - windowSize; i++) {
  const window = allTrades.slice(i, i + windowSize);
  const wins = window.filter(t => t.won).length;
  const winRate = (wins / windowSize) * 100;

  const startBankroll = window[0].oldBankroll;
  const endBankroll = window[windowSize - 1].newBankroll;
  const pnl = endBankroll - startBankroll;
  const pnlPct = ((pnl / startBankroll) * 100);

  worstPeriods.push({
    startIdx: i,
    endIdx: i + windowSize - 1,
    startTrade: window[0].tradeNum,
    endTrade: window[windowSize - 1].tradeNum,
    startDate: window[0].date,
    endDate: window[windowSize - 1].date,
    wins,
    losses: windowSize - wins,
    winRate,
    startBankroll,
    endBankroll,
    pnl,
    pnlPct
  });
}

// Sort by win rate (worst first)
worstPeriods.sort((a, b) => a.winRate - b.winRate);

console.log('  Top 5 worst win rate periods:\n');
for (let i = 0; i < Math.min(5, worstPeriods.length); i++) {
  const p = worstPeriods[i];
  console.log(`  ${i + 1}. Win Rate: ${p.winRate.toFixed(1)}% (${p.wins}W / ${p.losses}L)`);
  console.log(`     Trades #${p.startTrade} - #${p.endTrade}`);
  console.log(`     ${p.startDate.substring(0, 19)} → ${p.endDate.substring(0, 19)}`);
  console.log(`     Bankroll: ${p.startBankroll.toFixed(4)} → ${p.endBankroll.toFixed(4)} (${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(2)}%)`);
  console.log('');
}

console.log('─'.repeat(100) + '\n');

// Show detailed trades from worst period
if (worstPeriods.length > 0) {
  const worstPeriod = worstPeriods[0];
  console.log(`📋 DETAILED TRADES FROM WORST PERIOD (#${worstPeriod.startTrade}-#${worstPeriod.endTrade}):\n`);

  const worstTrades = allTrades.slice(worstPeriod.startIdx, worstPeriod.endIdx + 1);

  for (const t of worstTrades) {
    const status = t.won ? '✅' : '❌';
    const pnlStr = t.tradePnL >= 0 ? `+${t.tradePnL.toFixed(6)}` : t.tradePnL.toFixed(6);

    console.log(`Trade #${t.tradeNum.toString().padStart(3)} ${status} | ${t.betSide} | Bet: ${t.betSize.toFixed(6)} | Payout: ${t.actualPayout.toFixed(2)}x`);
    console.log(`  P&L: ${pnlStr} | Bankroll: ${t.oldBankroll.toFixed(6)} → ${t.newBankroll.toFixed(6)}`);
  }

  console.log('');
}

console.log('═'.repeat(100) + '\n');

// Calculate drawdown statistics
console.log('💸 MAXIMUM DRAWDOWN ANALYSIS:\n');

let peakBankroll = CONFIG.STARTING_BANKROLL;
let maxDrawdown = 0;
let maxDrawdownPct = 0;
let drawdownStart = -1;
let drawdownEnd = -1;

for (let i = 0; i < allTrades.length; i++) {
  const currentBankroll = allTrades[i].newBankroll;

  if (currentBankroll > peakBankroll) {
    peakBankroll = currentBankroll;
  }

  const drawdown = peakBankroll - currentBankroll;
  const drawdownPct = (drawdown / peakBankroll) * 100;

  if (drawdown > maxDrawdown) {
    maxDrawdown = drawdown;
    maxDrawdownPct = drawdownPct;
    drawdownEnd = i;

    // Find when we were at peak
    for (let j = i; j >= 0; j--) {
      if (allTrades[j].newBankroll === peakBankroll) {
        drawdownStart = j;
        break;
      }
    }
  }
}

console.log(`  Maximum drawdown: ${maxDrawdown.toFixed(6)} BNB (${maxDrawdownPct.toFixed(2)}%)`);
console.log(`  Peak bankroll: ${peakBankroll.toFixed(6)} BNB`);
console.log(`  Lowest point: ${(peakBankroll - maxDrawdown).toFixed(6)} BNB\n`);

if (drawdownStart !== -1 && drawdownEnd !== -1) {
  console.log(`  Drawdown period:`);
  console.log(`    Start: Trade #${allTrades[drawdownStart].tradeNum} at ${allTrades[drawdownStart].date.substring(0, 19)}`);
  console.log(`    End:   Trade #${allTrades[drawdownEnd].tradeNum} at ${allTrades[drawdownEnd].date.substring(0, 19)}`);
  console.log(`    Duration: ${drawdownEnd - drawdownStart + 1} trades\n`);
}

console.log('═'.repeat(100) + '\n');

db.close();
