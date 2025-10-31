import { readFileSync, writeFileSync } from 'fs';
import initSqlJs from 'sql.js';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('💰 STRATEGY ANALYSIS WITH 6.5% POSITION SIZE\n');
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

console.log(`📊 Dataset: ${allRoundsData.length} rounds`);
const startDate = new Date(allRoundsData[0].close_ts * 1000);
const endDate = new Date(allRoundsData[allRoundsData.length - 1].close_ts * 1000);
console.log(`📅 Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}\n`);

db.close();

// Fetch TradingView data
console.log('📡 Fetching TradingView data...');
const lockTimestamps = allRoundsData.map(r => r.lock_ts);
const minLockTs = Math.min(...lockTimestamps);
const maxLockTs = Math.max(...lockTimestamps);
const startTime = minLockTs - 7200;
const endTime = maxLockTs + 3600;

const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.BNB/USD&resolution=5&from=${startTime}&to=${endTime}`;
const response = await globalThis.fetch(url);
const candles = await response.json();

console.log(`✅ Fetched ${candles.t.length} candles\n`);

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

// Create EMA maps
const closes = candles.c;
const ema3 = calculateEMA(closes, 3);
const ema7 = calculateEMA(closes, 7);

const ema3Map = new Map();
const ema7Map = new Map();

for (let i = 0; i < candles.t.length; i++) {
  ema3Map.set(candles.t[i], ema3[i]);
  ema7Map.set(candles.t[i], ema7[i]);
}

// Run strategy with 6.5% position size
const POSITION_SIZE = 0.065; // 6.5%
const GAP = 0.0005; // 0.05%
const CROWD = 0.65; // 65%

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
  if (bullPct >= CROWD) {
    crowdSignal = 'UP';
    crowdPct = bullPct;
  } else if (bearPct >= CROWD) {
    crowdSignal = 'DOWN';
    crowdPct = bearPct;
  }

  if (emaSignal && crowdSignal && emaSignal === crowdSignal && emaGap >= GAP) {
    const betAmount = bankroll * POSITION_SIZE;
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
      time: new Date(round.close_ts * 1000).toISOString().split('T')[1].split('.')[0],
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
      bankroll,
      bankrollChange: (profit / (bankroll - profit)) * 100
    });

    // Track daily results
    if (!dailyResults.has(tradeDate)) {
      const prevTrade = trades.length > 1 ? trades[trades.length - 2] : null;
      dailyResults.set(tradeDate, {
        date: tradeDate,
        trades: 0,
        wins: 0,
        losses: 0,
        totalWagered: 0,
        totalProfit: 0,
        startBankroll: prevTrade ? prevTrade.bankroll : 1.0,
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
const winRate = (wins / totalTrades * 100);
const roi = ((bankroll - 1.0) / 1.0 * 100);
const profit = bankroll - 1.0;

console.log('═══════════════════════════════════════════════════════════════');
console.log('📈 OVERALL PERFORMANCE (6.5% POSITION SIZE)');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`Strategy Configuration:`);
console.log(`   EMA: 3/7 crossover`);
console.log(`   Gap: 0.05%`);
console.log(`   Crowd: 65% at T-20s`);
console.log(`   Position Size: 6.5% per trade\n`);

console.log(`Results:`);
console.log(`   Total Rounds: ${allRoundsData.length}`);
console.log(`   Trades Taken: ${totalTrades} (${(totalTrades / allRoundsData.length * 100).toFixed(1)}%)`);
console.log(`   Trades Skipped: ${skipped}`);
console.log(`   Wins: ${wins}`);
console.log(`   Losses: ${losses}`);
console.log(`   Win Rate: ${winRate.toFixed(2)}%`);
console.log(`   Starting Bankroll: 1.0000 BNB`);
console.log(`   Ending Bankroll: ${bankroll.toFixed(4)} BNB`);
console.log(`   Total Profit: +${profit.toFixed(4)} BNB`);
console.log(`   ROI: +${roi.toFixed(2)}%\n`);

console.log(`Signal Distribution:`);
console.log(`   UP trades: ${upTrades} (${(upTrades / totalTrades * 100).toFixed(1)}%)`);
console.log(`   DOWN trades: ${downTrades} (${(downTrades / totalTrades * 100).toFixed(1)}%)\n`);

console.log('═══════════════════════════════════════════════════════════════');
console.log('📅 DAILY BREAKDOWN');
console.log('═══════════════════════════════════════════════════════════════\n');

const dailyArray = Array.from(dailyResults.values());
const losingDays = dailyArray.filter(d => d.totalProfit < 0);
const winningDays = dailyArray.filter(d => d.totalProfit > 0);
const breakEvenDays = dailyArray.filter(d => d.totalProfit === 0);

console.log(`Summary:`);
console.log(`   Total Trading Days: ${dailyArray.length}`);
console.log(`   Winning Days: ${winningDays.length} (${(winningDays.length / dailyArray.length * 100).toFixed(1)}%)`);
console.log(`   Losing Days: ${losingDays.length} (${(losingDays.length / dailyArray.length * 100).toFixed(1)}%)`);
console.log(`   Break-even Days: ${breakEvenDays.length}\n`);

console.log(`Date       | Trades | W/L   | Win%  | Wagered  | Profit    | Daily ROI | Start    | End      | Status`);
console.log(`─────────────────────────────────────────────────────────────────────────────────────────────────────────────────`);

for (const day of dailyArray) {
  const dayStr = day.date.padEnd(10);
  const trades = day.trades.toString().padStart(6);
  const wl = `${day.wins}/${day.losses}`.padStart(5);
  const winPct = day.trades > 0 ? (day.wins / day.trades * 100).toFixed(0).padStart(4) + '%' : '  N/A';
  const wagered = day.totalWagered.toFixed(4).padStart(8);
  const profit = (day.totalProfit >= 0 ? '+' : '') + day.totalProfit.toFixed(4).padStart(8);
  const dailyRoi = ((day.endBankroll - day.startBankroll) / day.startBankroll * 100).toFixed(2);
  const dailyRoiStr = (dailyRoi >= 0 ? '+' : '') + dailyRoi.padStart(8) + '%';
  const start = day.startBankroll.toFixed(4).padStart(8);
  const end = day.endBankroll.toFixed(4).padStart(8);
  const status = day.totalProfit > 0 ? '✅ WIN ' : day.totalProfit < 0 ? '❌ LOSS' : '⚪ EVEN';

  console.log(`${dayStr} | ${trades} | ${wl} | ${winPct} | ${wagered} | ${profit} | ${dailyRoiStr} | ${start} | ${end} | ${status}`);
}

if (losingDays.length > 0) {
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log('❌ LOSING DAYS DETAIL');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const day of losingDays) {
    console.log(`📅 ${day.date}:`);
    console.log(`   Trades: ${day.trades} (${day.wins}W/${day.losses}L)`);
    console.log(`   Win Rate: ${(day.wins / day.trades * 100).toFixed(1)}%`);
    console.log(`   Wagered: ${day.totalWagered.toFixed(4)} BNB`);
    console.log(`   Loss: ${day.totalProfit.toFixed(4)} BNB`);
    console.log(`   Daily ROI: ${((day.endBankroll - day.startBankroll) / day.startBankroll * 100).toFixed(2)}%`);
    console.log(`   Bankroll: ${day.startBankroll.toFixed(4)} → ${day.endBankroll.toFixed(4)}\n`);
  }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('⚠️  LOSING STREAK ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════\n');

// Find longest losing streak
let currentStreak = 0;
let maxLosingStreak = 0;
let maxLosingStreakStart = 0;

for (let i = 0; i < trades.length; i++) {
  if (!trades[i].won) {
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
  console.log(`Trades ${maxLosingStreakStart + 1} to ${maxLosingStreakStart + maxLosingStreak}:\n`);
  console.log(`#  | Date       | Time     | Signal | Crowd% | Bet      | Winner | Bankroll Change`);
  console.log(`───────────────────────────────────────────────────────────────────────────────────────`);

  for (let i = maxLosingStreakStart; i < maxLosingStreakStart + maxLosingStreak; i++) {
    const t = trades[i];
    const num = t.tradeNumber.toString().padStart(3);
    const date = t.date.padEnd(10);
    const time = t.time.padEnd(8);
    const signal = t.emaSignal.padEnd(6);
    const crowd = t.crowdPct.toFixed(1).padStart(5) + '%';
    const bet = t.betAmount.toFixed(4).padStart(8);
    const winner = t.winner.padEnd(6);
    const change = t.bankrollChange.toFixed(2).padStart(7) + '%';

    console.log(`${num} | ${date} | ${time} | ${signal} | ${crowd} | ${bet} | ${winner} | ${change}`);
  }

  const streakStartBankroll = maxLosingStreakStart > 0 ? trades[maxLosingStreakStart - 1].bankroll : 1.0;
  const streakEndBankroll = trades[maxLosingStreakStart + maxLosingStreak - 1].bankroll;
  const streakLoss = ((streakEndBankroll - streakStartBankroll) / streakStartBankroll * 100);

  console.log(`\n   Bankroll before streak: ${streakStartBankroll.toFixed(4)} BNB`);
  console.log(`   Bankroll after streak: ${streakEndBankroll.toFixed(4)} BNB`);
  console.log(`   Total drawdown: ${streakLoss.toFixed(2)}%\n`);
}

// Find longest winning streak
currentStreak = 0;
let maxWinningStreak = 0;
let maxWinningStreakStart = 0;

for (let i = 0; i < trades.length; i++) {
  if (trades[i].won) {
    currentStreak++;
    if (currentStreak > maxWinningStreak) {
      maxWinningStreak = currentStreak;
      maxWinningStreakStart = i - currentStreak + 1;
    }
  } else {
    currentStreak = 0;
  }
}

console.log(`Longest Winning Streak: ${maxWinningStreak} trades in a row\n`);

if (maxWinningStreak > 0) {
  const streakStartBankroll = maxWinningStreakStart > 0 ? trades[maxWinningStreakStart - 1].bankroll : 1.0;
  const streakEndBankroll = trades[maxWinningStreakStart + maxWinningStreak - 1].bankroll;
  const streakGain = ((streakEndBankroll - streakStartBankroll) / streakStartBankroll * 100);

  console.log(`   Trades: ${maxWinningStreakStart + 1} to ${maxWinningStreakStart + maxWinningStreak}`);
  console.log(`   Bankroll before streak: ${streakStartBankroll.toFixed(4)} BNB`);
  console.log(`   Bankroll after streak: ${streakEndBankroll.toFixed(4)} BNB`);
  console.log(`   Total gain: +${streakGain.toFixed(2)}%\n`);
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('📊 SUMMARY');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`✅ Strategy Configuration (6.5% position size):`);
console.log(`   Win Rate: ${winRate.toFixed(2)}%`);
console.log(`   ROI: +${roi.toFixed(2)}%`);
console.log(`   Final Bankroll: ${bankroll.toFixed(4)} BNB`);
console.log(`   Total Profit: +${profit.toFixed(4)} BNB\n`);

console.log(`📅 Daily Performance:`);
console.log(`   ${winningDays.length}/${dailyArray.length} winning days (${(winningDays.length / dailyArray.length * 100).toFixed(1)}%)`);
console.log(`   ${losingDays.length}/${dailyArray.length} losing days (${(losingDays.length / dailyArray.length * 100).toFixed(1)}%)\n`);

console.log(`⚠️  Risk Metrics:`);
console.log(`   Max losing streak: ${maxLosingStreak} trades`);
console.log(`   Max winning streak: ${maxWinningStreak} trades`);
if (maxLosingStreak > 0) {
  const streakStartBankroll = maxLosingStreakStart > 0 ? trades[maxLosingStreakStart - 1].bankroll : 1.0;
  const streakEndBankroll = trades[maxLosingStreakStart + maxLosingStreak - 1].bankroll;
  const streakLoss = ((streakEndBankroll - streakStartBankroll) / streakStartBankroll * 100);
  console.log(`   Worst drawdown: ${streakLoss.toFixed(2)}%`);
}

console.log('\n📄 Data saved to: ./data/6-5-percent-analysis.json\n');

// Save data
const analysisData = {
  configuration: {
    positionSize: '6.5%',
    ema: '3/7',
    gap: '0.05%',
    crowd: '65%',
    snapshot: 'T-20s'
  },
  performance: {
    totalRounds: allRoundsData.length,
    totalTrades,
    wins,
    losses,
    winRate: winRate.toFixed(2) + '%',
    roi: '+' + roi.toFixed(2) + '%',
    startBankroll: '1.0000 BNB',
    endBankroll: bankroll.toFixed(4) + ' BNB',
    profit: '+' + profit.toFixed(4) + ' BNB'
  },
  dailyResults: dailyArray,
  losingDays: losingDays.map(d => ({
    date: d.date,
    trades: d.trades,
    wins: d.wins,
    losses: d.losses,
    profit: d.totalProfit.toFixed(4),
    roi: ((d.endBankroll - d.startBankroll) / d.startBankroll * 100).toFixed(2) + '%'
  })),
  trades: trades
};

writeFileSync('./data/6-5-percent-analysis.json', JSON.stringify(analysisData, null, 2));
