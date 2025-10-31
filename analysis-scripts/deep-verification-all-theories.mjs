import { readFileSync, writeFileSync } from 'fs';
import initSqlJs from 'sql.js';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('🔬 DEEP VERIFICATION - TESTING ALL THEORIES WITH CAUTION\n');
console.log('═══════════════════════════════════════════════════════════════\n');

// Get ALL rounds with T-20s data
const allT20sRounds = db.exec(`
  SELECT
    epoch,
    lock_ts,
    close_ts,
    winner,
    winner_multiple,
    t20s_bull_wei,
    t20s_bear_wei,
    t20s_total_wei,
    bull_amount_wei,
    bear_amount_wei,
    total_amount_wei
  FROM rounds
  WHERE t20s_total_wei IS NOT NULL
    AND winner != 'UNKNOWN'
    AND winner IN ('UP', 'DOWN')
  ORDER BY epoch
`)[0];

if (!allT20sRounds || allT20sRounds.values.length === 0) {
  console.log('❌ No rounds found');
  db.close();
  process.exit(1);
}

const allRoundsData = allT20sRounds.values.map(row => ({
  epoch: row[0],
  lock_ts: row[1],
  close_ts: row[2],
  winner: row[3],
  winner_multiple: row[4],
  t20s_bull: row[5],
  t20s_bear: row[6],
  t20s_total: row[7],
  bull_amount: row[8],
  bear_amount: row[9],
  total_amount: row[10]
}));

console.log(`📊 Dataset: ${allRoundsData.length} rounds with T-20s snapshots`);
console.log(`📅 Date Range: Epoch ${allRoundsData[0].epoch} to ${allRoundsData[allRoundsData.length - 1].epoch}`);

// Convert timestamps to dates
const startDate = new Date(allRoundsData[0].close_ts * 1000);
const endDate = new Date(allRoundsData[allRoundsData.length - 1].close_ts * 1000);
console.log(`🗓️  Time Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}\n`);

db.close();

// Fetch TradingView data
console.log('📡 Fetching TradingView/Pyth data...');
const lockTimestamps = allRoundsData.map(r => r.lock_ts);
const minLockTs = Math.min(...lockTimestamps);
const maxLockTs = Math.max(...lockTimestamps);
const startTime = minLockTs - 7200;
const endTime = maxLockTs + 3600;

const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.BNB/USD&resolution=5&from=${startTime}&to=${endTime}`;
const response = await globalThis.fetch(url);
const candles = await response.json();

console.log(`✅ Fetched ${candles.t.length} 5-minute candles\n`);

// Calculate EMA
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const emas = [];
  let ema = prices[0];

  for (let i = 0; i < prices.length; i++) {
    if (i === 0) {
      ema = prices[i];
    } else {
      ema = prices[i] * k + ema * (1 - k);
    }
    emas.push(ema);
  }

  return emas;
}

// Create EMA 3/7 maps
const closes = candles.c;
const ema3 = calculateEMA(closes, 3);
const ema7 = calculateEMA(closes, 7);

const ema3Map = new Map();
const ema7Map = new Map();

for (let i = 0; i < candles.t.length; i++) {
  ema3Map.set(candles.t[i], ema3[i]);
  ema7Map.set(candles.t[i], ema7[i]);
}

// Test strategy with detailed tracking
function testStrategyDetailed(positionSize, gap, crowd, name) {
  let bankroll = 1.0;
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  let upTrades = 0;
  let downTrades = 0;
  const trades = [];
  const dailyResults = new Map();

  for (let i = 0; i < allRoundsData.length; i++) {
    const round = allRoundsData[i];
    const roundedLockTs = Math.floor(round.lock_ts / 300) * 300;

    const currentEma3 = ema3Map.get(roundedLockTs);
    const currentEma7 = ema7Map.get(roundedLockTs);

    if (!currentEma3 || !currentEma7) {
      skipped++;
      continue;
    }

    const emaGap = Math.abs(currentEma3 - currentEma7) / currentEma7;

    let emaSignal = null;
    if (currentEma3 > currentEma7) {
      emaSignal = 'UP';
    } else if (currentEma3 < currentEma7) {
      emaSignal = 'DOWN';
    }

    const bullPct = parseFloat(round.t20s_bull) / parseFloat(round.t20s_total);
    const bearPct = parseFloat(round.t20s_bear) / parseFloat(round.t20s_total);

    let crowdSignal = null;
    let crowdPct = 0;
    if (bullPct >= crowd) {
      crowdSignal = 'UP';
      crowdPct = bullPct;
    } else if (bearPct >= crowd) {
      crowdSignal = 'DOWN';
      crowdPct = bearPct;
    }

    if (emaSignal && crowdSignal && emaSignal === crowdSignal && emaGap >= gap) {
      const betAmount = bankroll * positionSize;
      const actualWinner = round.winner;
      const won = emaSignal === actualWinner;

      let payout = 0;
      let profit = 0;

      if (won) {
        payout = betAmount * round.winner_multiple;
        profit = payout - betAmount;
        wins++;
        bankroll = bankroll - betAmount + payout;
      } else {
        profit = -betAmount;
        losses++;
        bankroll = bankroll - betAmount;
      }

      if (emaSignal === 'UP') upTrades++;
      if (emaSignal === 'DOWN') downTrades++;

      const tradeDate = new Date(round.close_ts * 1000).toISOString().split('T')[0];

      trades.push({
        tradeNumber: trades.length + 1,
        epoch: round.epoch,
        date: tradeDate,
        timestamp: round.close_ts,
        emaSignal,
        crowdPct: crowdPct * 100,
        emaGap: emaGap * 100,
        betAmount,
        winner: actualWinner,
        won,
        payout,
        profit,
        multiple: round.winner_multiple,
        bankroll
      });

      // Track daily results
      if (!dailyResults.has(tradeDate)) {
        dailyResults.set(tradeDate, {
          date: tradeDate,
          trades: 0,
          wins: 0,
          losses: 0,
          totalWagered: 0,
          totalProfit: 0,
          startBankroll: trades.length === 1 ? 1.0 : trades[trades.findIndex(t => t.date === tradeDate) - 1]?.bankroll || 1.0,
          endBankroll: 0
        });
      }

      const dayData = dailyResults.get(tradeDate);
      dayData.trades++;
      dayData.wins += won ? 1 : 0;
      dayData.losses += won ? 0 : 1;
      dayData.totalWagered += betAmount;
      dayData.totalProfit += profit;
      dayData.endBankroll = bankroll;
    } else {
      skipped++;
    }
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const roi = ((bankroll - 1.0) / 1.0 * 100);
  const profit = bankroll - 1.0;

  // Calculate daily statistics
  const dailyArray = Array.from(dailyResults.values());
  const losingDays = dailyArray.filter(d => d.totalProfit < 0);
  const winningDays = dailyArray.filter(d => d.totalProfit > 0);
  const breakEvenDays = dailyArray.filter(d => d.totalProfit === 0);

  return {
    name,
    positionSize: (positionSize * 100).toFixed(1) + '%',
    gap: (gap * 100).toFixed(2) + '%',
    crowd: (crowd * 100).toFixed(0) + '%',
    totalRounds: allRoundsData.length,
    totalTrades,
    wins,
    losses,
    upTrades,
    downTrades,
    winRate,
    roi,
    profit,
    bankroll,
    tradeFreq: (totalTrades / allRoundsData.length * 100),
    skipped,
    trades,
    dailyResults: dailyArray,
    losingDays: losingDays.length,
    winningDays: winningDays.length,
    breakEvenDays: breakEvenDays.length
  };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('TEST 1: VERIFY 60% WIN RATE WITH 2% POSITION SIZE');
console.log('═══════════════════════════════════════════════════════════════\n');

const test2pct = testStrategyDetailed(0.02, 0.0005, 0.65, '2% Position Size');

console.log(`Configuration: EMA 3/7 + 0.05% gap + 65% crowd + T-20s`);
console.log(`Position Size: 2%\n`);

console.log(`Results:`);
console.log(`   Total Rounds: ${test2pct.totalRounds}`);
console.log(`   Trades Taken: ${test2pct.totalTrades} (${test2pct.tradeFreq.toFixed(1)}%)`);
console.log(`   Trades Skipped: ${test2pct.skipped}`);
console.log(`   Wins: ${test2pct.wins}`);
console.log(`   Losses: ${test2pct.losses}`);
console.log(`   Win Rate: ${test2pct.winRate.toFixed(2)}%`);
console.log(`   ROI: ${test2pct.roi >= 0 ? '+' : ''}${test2pct.roi.toFixed(2)}%`);
console.log(`   Starting Bankroll: 1.0000 BNB`);
console.log(`   Ending Bankroll: ${test2pct.bankroll.toFixed(4)} BNB`);
console.log(`   Profit: ${test2pct.profit >= 0 ? '+' : ''}${test2pct.profit.toFixed(4)} BNB\n`);

console.log(`Signal Distribution:`);
console.log(`   UP trades: ${test2pct.upTrades} (${(test2pct.upTrades / test2pct.totalTrades * 100).toFixed(1)}%)`);
console.log(`   DOWN trades: ${test2pct.downTrades} (${(test2pct.downTrades / test2pct.totalTrades * 100).toFixed(1)}%)\n`);

console.log('═══════════════════════════════════════════════════════════════');
console.log('TEST 2: COMPARE WITH 6.5% POSITION SIZE');
console.log('═══════════════════════════════════════════════════════════════\n');

const test6_5pct = testStrategyDetailed(0.065, 0.0005, 0.65, '6.5% Position Size');

console.log(`Configuration: EMA 3/7 + 0.05% gap + 65% crowd + T-20s`);
console.log(`Position Size: 6.5%\n`);

console.log(`Results:`);
console.log(`   Trades Taken: ${test6_5pct.totalTrades}`);
console.log(`   Wins: ${test6_5pct.wins}`);
console.log(`   Losses: ${test6_5pct.losses}`);
console.log(`   Win Rate: ${test6_5pct.winRate.toFixed(2)}%`);
console.log(`   ROI: ${test6_5pct.roi >= 0 ? '+' : ''}${test6_5pct.roi.toFixed(2)}%`);
console.log(`   Starting Bankroll: 1.0000 BNB`);
console.log(`   Ending Bankroll: ${test6_5pct.bankroll.toFixed(4)} BNB`);
console.log(`   Profit: ${test6_5pct.profit >= 0 ? '+' : ''}${test6_5pct.profit.toFixed(4)} BNB\n`);

const roiDiff = test6_5pct.roi - test2pct.roi;
console.log(`Comparison:`);
console.log(`   ROI Difference: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}%`);
console.log(`   Profit Difference: ${(test6_5pct.profit - test2pct.profit) >= 0 ? '+' : ''}${(test6_5pct.profit - test2pct.profit).toFixed(4)} BNB\n`);

if (roiDiff > 0) {
  console.log(`✅ 6.5% position size is MORE profitable (+${roiDiff.toFixed(2)}%)`);
  console.log(`   Higher risk = Higher reward\n`);
} else {
  console.log(`❌ 6.5% position size is LESS profitable (${roiDiff.toFixed(2)}%)`);
  console.log(`   Likely due to larger drawdowns on losing streaks\n`);
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('TEST 3: DAILY PROFITABILITY ANALYSIS (DID WE HAVE LOSING DAYS?)');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`Using 2% position size:\n`);

console.log(`Daily Summary:`);
console.log(`   Total Trading Days: ${test2pct.dailyResults.length}`);
console.log(`   Winning Days: ${test2pct.winningDays} (${(test2pct.winningDays / test2pct.dailyResults.length * 100).toFixed(1)}%)`);
console.log(`   Losing Days: ${test2pct.losingDays} (${(test2pct.losingDays / test2pct.dailyResults.length * 100).toFixed(1)}%)`);
console.log(`   Break-even Days: ${test2pct.breakEvenDays}\n`);

if (test2pct.losingDays > 0) {
  console.log(`⚠️  YES - We had ${test2pct.losingDays} LOSING DAY(S)\n`);

  console.log(`Losing Days Details:\n`);
  const losingDaysData = test2pct.dailyResults.filter(d => d.totalProfit < 0);

  console.log(`Date       | Trades | Wins | Losses | Wagered  | Profit    | Start→End Bankroll`);
  console.log(`────────────────────────────────────────────────────────────────────────────────`);

  for (const day of losingDaysData) {
    const dayStr = day.date.padEnd(10);
    const trades = day.trades.toString().padStart(6);
    const wins = day.wins.toString().padStart(4);
    const losses = day.losses.toString().padStart(6);
    const wagered = day.totalWagered.toFixed(4).padStart(8);
    const profit = day.totalProfit.toFixed(4).padStart(9);
    const bankrolls = `${day.startBankroll.toFixed(4)} → ${day.endBankroll.toFixed(4)}`;

    console.log(`${dayStr} | ${trades} | ${wins} | ${losses} | ${wagered} | ${profit} | ${bankrolls}`);
  }
  console.log();
} else {
  console.log(`✅ NO LOSING DAYS! Every trading day was profitable or break-even.\n`);
}

console.log(`\nAll Daily Results:\n`);
console.log(`Date       | Trades | W/L   | Win%  | Wagered  | Profit    | Daily ROI | Bankroll`);
console.log(`───────────────────────────────────────────────────────────────────────────────────────`);

for (const day of test2pct.dailyResults) {
  const dayStr = day.date.padEnd(10);
  const trades = day.trades.toString().padStart(6);
  const wl = `${day.wins}/${day.losses}`.padStart(5);
  const winPct = day.trades > 0 ? (day.wins / day.trades * 100).toFixed(0).padStart(4) + '%' : '  N/A';
  const wagered = day.totalWagered.toFixed(4).padStart(8);
  const profit = (day.totalProfit >= 0 ? '+' : '') + day.totalProfit.toFixed(4).padStart(8);
  const dailyRoi = ((day.endBankroll - day.startBankroll) / day.startBankroll * 100).toFixed(2);
  const dailyRoiStr = (dailyRoi >= 0 ? '+' : '') + dailyRoi.padStart(8) + '%';
  const bankroll = day.endBankroll.toFixed(4).padStart(8);

  console.log(`${dayStr} | ${trades} | ${wl} | ${winPct} | ${wagered} | ${profit} | ${dailyRoiStr} | ${bankroll}`);
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('TEST 4: TRADE-BY-TRADE VERIFICATION (FIRST & LAST 10 TRADES)');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`First 10 Trades:\n`);
console.log(`# | Epoch  | Signal | Crowd% | Gap%  | Bet      | Winner | Result | Multiple | Profit    | Bankroll`);
console.log(`──────────────────────────────────────────────────────────────────────────────────────────────────────────`);

for (let i = 0; i < Math.min(10, test2pct.trades.length); i++) {
  const t = test2pct.trades[i];
  const num = t.tradeNumber.toString().padStart(2);
  const epoch = t.epoch.toString().padEnd(6);
  const signal = t.emaSignal.padEnd(6);
  const crowd = t.crowdPct.toFixed(1).padStart(5) + '%';
  const gap = t.emaGap.toFixed(2).padStart(4) + '%';
  const bet = t.betAmount.toFixed(4).padStart(8);
  const winner = t.winner.padEnd(6);
  const result = t.won ? '✅ WIN ' : '❌ LOSS';
  const multiple = t.multiple.toFixed(2).padStart(4) + 'x';
  const profit = (t.profit >= 0 ? '+' : '') + t.profit.toFixed(4).padStart(8);
  const bankroll = t.bankroll.toFixed(4).padStart(8);

  console.log(`${num} | ${epoch} | ${signal} | ${crowd} | ${gap} | ${bet} | ${winner} | ${result} | ${multiple} | ${profit} | ${bankroll}`);
}

console.log(`\nLast 10 Trades:\n`);
console.log(`# | Epoch  | Signal | Crowd% | Gap%  | Bet      | Winner | Result | Multiple | Profit    | Bankroll`);
console.log(`──────────────────────────────────────────────────────────────────────────────────────────────────────────`);

const lastTenStart = Math.max(0, test2pct.trades.length - 10);
for (let i = lastTenStart; i < test2pct.trades.length; i++) {
  const t = test2pct.trades[i];
  const num = t.tradeNumber.toString().padStart(2);
  const epoch = t.epoch.toString().padEnd(6);
  const signal = t.emaSignal.padEnd(6);
  const crowd = t.crowdPct.toFixed(1).padStart(5) + '%';
  const gap = t.emaGap.toFixed(2).padStart(4) + '%';
  const bet = t.betAmount.toFixed(4).padStart(8);
  const winner = t.winner.padEnd(6);
  const result = t.won ? '✅ WIN ' : '❌ LOSS';
  const multiple = t.multiple.toFixed(2).padStart(4) + 'x';
  const profit = (t.profit >= 0 ? '+' : '') + t.profit.toFixed(4).padStart(8);
  const bankroll = t.bankroll.toFixed(4).padStart(8);

  console.log(`${num} | ${epoch} | ${signal} | ${crowd} | ${gap} | ${bet} | ${winner} | ${result} | ${multiple} | ${profit} | ${bankroll}`);
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('TEST 5: LOSING STREAK ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════\n');

// Find longest losing streak
let currentStreak = 0;
let maxLosingStreak = 0;
let maxLosingStreakStart = 0;

for (let i = 0; i < test2pct.trades.length; i++) {
  if (!test2pct.trades[i].won) {
    currentStreak++;
    if (currentStreak > maxLosingStreak) {
      maxLosingStreak = currentStreak;
      maxLosingStreakStart = i - currentStreak + 1;
    }
  } else {
    currentStreak = 0;
  }
}

console.log(`Longest Losing Streak: ${maxLosingStreak} trades in a row\n`);

if (maxLosingStreak > 0) {
  console.log(`Losing Streak Details (trades ${maxLosingStreakStart + 1} to ${maxLosingStreakStart + maxLosingStreak}):\n`);
  console.log(`# | Epoch  | Signal | Crowd% | Bet      | Winner | Bankroll Change`);
  console.log(`──────────────────────────────────────────────────────────────────────────`);

  for (let i = maxLosingStreakStart; i < maxLosingStreakStart + maxLosingStreak; i++) {
    const t = test2pct.trades[i];
    const num = t.tradeNumber.toString().padStart(2);
    const epoch = t.epoch.toString().padEnd(6);
    const signal = t.emaSignal.padEnd(6);
    const crowd = t.crowdPct.toFixed(1).padStart(5) + '%';
    const bet = t.betAmount.toFixed(4).padStart(8);
    const winner = t.winner.padEnd(6);
    const prevBankroll = i > 0 ? test2pct.trades[i - 1].bankroll : 1.0;
    const change = ((t.bankroll - prevBankroll) / prevBankroll * 100).toFixed(2);

    console.log(`${num} | ${epoch} | ${signal} | ${crowd} | ${bet} | ${winner} | ${change}%`);
  }

  const streakStartBankroll = maxLosingStreakStart > 0 ? test2pct.trades[maxLosingStreakStart - 1].bankroll : 1.0;
  const streakEndBankroll = test2pct.trades[maxLosingStreakStart + maxLosingStreak - 1].bankroll;
  const streakLoss = ((streakEndBankroll - streakStartBankroll) / streakStartBankroll * 100);

  console.log(`\n   Bankroll before streak: ${streakStartBankroll.toFixed(4)} BNB`);
  console.log(`   Bankroll after streak: ${streakEndBankroll.toFixed(4)} BNB`);
  console.log(`   Total loss during streak: ${streakLoss.toFixed(2)}%\n`);
}

const worstDrawdown = maxLosingStreak > 0 ? streakLoss : 0;

console.log('═══════════════════════════════════════════════════════════════');
console.log('FINAL VERIFICATION SUMMARY');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`✅ VERIFIED: Strategy tested on ${test2pct.totalRounds} rounds\n`);

console.log(`📊 Core Metrics:`);
console.log(`   Win Rate: ${test2pct.winRate.toFixed(2)}% (${test2pct.wins}W/${test2pct.losses}L)`);
console.log(`   Required to beat house: 51.5%`);
console.log(`   Our edge: +${(test2pct.winRate - 51.5).toFixed(2)}%\n`);

console.log(`💰 Position Sizing Comparison:`);
console.log(`   2% position:   ${test2pct.roi >= 0 ? '+' : ''}${test2pct.roi.toFixed(2)}% ROI = ${test2pct.bankroll.toFixed(4)} BNB`);
console.log(`   6.5% position: ${test6_5pct.roi >= 0 ? '+' : ''}${test6_5pct.roi.toFixed(2)}% ROI = ${test6_5pct.bankroll.toFixed(4)} BNB`);
console.log(`   Difference: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}%\n`);

console.log(`📅 Daily Performance:`);
console.log(`   Trading days: ${test2pct.dailyResults.length}`);
console.log(`   Winning days: ${test2pct.winningDays} ✅`);
console.log(`   Losing days: ${test2pct.losingDays} ${test2pct.losingDays > 0 ? '⚠️' : '✅'}`);
console.log(`   Daily win rate: ${(test2pct.winningDays / test2pct.dailyResults.length * 100).toFixed(1)}%\n`);

console.log(`⚠️  Risk Metrics:`);
console.log(`   Max losing streak: ${maxLosingStreak} trades`);
console.log(`   Worst drawdown: ${maxLosingStreak > 0 ? worstDrawdown.toFixed(2) + '%' : 'N/A'}\n`);

if (test2pct.winRate >= 60) {
  console.log(`✅ CONFIRMED: 60%+ win rate is REAL`);
} else if (test2pct.winRate >= 55) {
  console.log(`✅ Strategy beats house edge but below 60%`);
} else {
  console.log(`❌ WARNING: Win rate below expectations`);
}

console.log('\n');

// Save detailed report
const reportData = {
  dataset: {
    totalRounds: test2pct.totalRounds,
    startEpoch: allRoundsData[0].epoch,
    endEpoch: allRoundsData[allRoundsData.length - 1].epoch,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString()
  },
  test2pct: {
    winRate: test2pct.winRate,
    roi: test2pct.roi,
    trades: test2pct.trades,
    dailyResults: test2pct.dailyResults
  },
  test6_5pct: {
    winRate: test6_5pct.winRate,
    roi: test6_5pct.roi
  }
};

writeFileSync('./data/verification-detailed-results.json', JSON.stringify(reportData, null, 2));
console.log('📄 Detailed results saved to: ./data/verification-detailed-results.json\n');
