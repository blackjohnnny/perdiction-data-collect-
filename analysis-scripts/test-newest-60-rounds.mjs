import { readFileSync } from 'fs';
import initSqlJs from 'sql.js';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('🎯 Testing EMA 5/13 + T-20s Crowd Strategy on Newest 60 Rounds\n');

// Get the newest 60 rounds with complete data
const rounds = db.exec(`
  SELECT
    epoch,
    lock_ts,
    lock_price,
    close_price,
    bull_amount_wei,
    bear_amount_wei,
    total_amount_wei,
    winner,
    winner_multiple,
    t20s_bull_wei,
    t20s_bear_wei,
    t20s_total_wei,
    t20s_implied_up_multiple,
    t20s_implied_down_multiple
  FROM rounds
  WHERE t20s_total_wei IS NOT NULL
    AND winner != 'UNKNOWN'
  ORDER BY epoch DESC
  LIMIT 60
`)[0];

if (!rounds || rounds.values.length === 0) {
  console.log('❌ No rounds found with T-20s data');
  db.close();
  process.exit(1);
}

// Reverse to process chronologically
const roundsData = rounds.values.reverse().map(row => ({
  epoch: row[0],
  lock_ts: row[1],
  lock_price: parseFloat(row[2]) / 1e8,  // Convert from TEXT to decimal
  close_price: parseFloat(row[3]) / 1e8,
  bull_amount: row[4],
  bear_amount: row[5],
  total_amount: row[6],
  winner: row[7],
  winner_multiple: row[8],
  t20s_bull: row[9],
  t20s_bear: row[10],
  t20s_total: row[11],
  t20s_up_multiple: row[12],
  t20s_down_multiple: row[13]
}));

console.log(`📊 Found ${roundsData.length} rounds with T-20s data`);
console.log(`📅 Date range: Epoch ${roundsData[0].epoch} to ${roundsData[roundsData.length - 1].epoch}\n`);

// Calculate EMAs for all rounds
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

// Use close prices for EMA calculation (already converted)
const closePrices = roundsData.map(r => r.close_price);
const ema5 = calculateEMA(closePrices, 5);
const ema13 = calculateEMA(closePrices, 13);

// Strategy configuration
const CROWD_THRESHOLD = 0.55; // 55% minimum
const MIN_EMA_GAP = 0.0010; // 0.10% minimum gap
const POSITION_SIZE = 0.02; // 2% of bankroll per bet

let bankroll = 1.0; // Start with 1 BNB
let totalWagered = 0;
let wins = 0;
let losses = 0;
let skipped = 0;
let trades = [];

console.log('⚙️  Strategy Parameters:');
console.log(`   Crowd Threshold: ${(CROWD_THRESHOLD * 100).toFixed(0)}%`);
console.log(`   Min EMA Gap: ${(MIN_EMA_GAP * 100).toFixed(2)}%`);
console.log(`   Position Size: ${(POSITION_SIZE * 100).toFixed(0)}% per bet`);
console.log(`   Starting Bankroll: ${bankroll.toFixed(4)} BNB\n`);

// Simulate trades (skip first 13 for EMA warmup)
for (let i = 13; i < roundsData.length; i++) {
  const round = roundsData[i];

  // Calculate EMA signal
  const currentEma5 = ema5[i - 1]; // Use previous round's close for decision
  const currentEma13 = ema13[i - 1];
  const emaGap = Math.abs(currentEma5 - currentEma13) / currentEma13;

  let emaSignal = null;
  if (currentEma5 > currentEma13) {
    emaSignal = 'UP';
  } else if (currentEma5 < currentEma13) {
    emaSignal = 'DOWN';
  }

  // Calculate T-20s crowd
  const t20sBullPct = parseFloat(round.t20s_bull) / parseFloat(round.t20s_total);
  const t20sBearPct = parseFloat(round.t20s_bear) / parseFloat(round.t20s_total);

  let crowdSignal = null;
  if (t20sBullPct >= CROWD_THRESHOLD) {
    crowdSignal = 'UP';
  } else if (t20sBearPct >= CROWD_THRESHOLD) {
    crowdSignal = 'DOWN';
  }

  // Check if EMA and crowd agree + meets gap threshold
  if (emaSignal && crowdSignal && emaSignal === crowdSignal && emaGap >= MIN_EMA_GAP) {
    // Place bet
    const betAmount = bankroll * POSITION_SIZE;
    totalWagered += betAmount;

    const actualWinner = round.winner;
    const won = emaSignal === actualWinner;

    let payout = 0;
    if (won) {
      payout = betAmount * round.winner_multiple;
      wins++;
      bankroll = bankroll - betAmount + payout;
    } else {
      losses++;
      bankroll = bankroll - betAmount;
    }

    trades.push({
      epoch: round.epoch,
      signal: emaSignal,
      crowdPct: emaSignal === 'UP' ? t20sBullPct : t20sBearPct,
      emaGap: emaGap,
      betAmount: betAmount,
      payout: payout,
      won: won,
      winner: actualWinner,
      multiple: round.winner_multiple,
      bankroll: bankroll
    });
  } else {
    skipped++;
  }
}

db.close();

// Calculate statistics
const totalTrades = wins + losses;
const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
const roi = ((bankroll - 1.0) / 1.0 * 100);
const avgBetSize = totalTrades > 0 ? (totalWagered / totalTrades) : 0;

console.log('═══════════════════════════════════════════════════════');
console.log('📈 RESULTS');
console.log('═══════════════════════════════════════════════════════');
console.log(`\n💰 Financial Performance:`);
console.log(`   Starting Bankroll: 1.0000 BNB`);
console.log(`   Ending Bankroll:   ${bankroll.toFixed(4)} BNB`);
console.log(`   Total Wagered:     ${totalWagered.toFixed(4)} BNB`);
console.log(`   ROI:               ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`);
console.log(`   Profit/Loss:       ${(bankroll - 1.0) >= 0 ? '+' : ''}${(bankroll - 1.0).toFixed(4)} BNB\n`);

console.log(`📊 Trade Statistics:`);
console.log(`   Total Rounds:      ${roundsData.length - 13}`);
console.log(`   Trades Taken:      ${totalTrades} (${(totalTrades / (roundsData.length - 13) * 100).toFixed(1)}%)`);
console.log(`   Trades Skipped:    ${skipped}`);
console.log(`   Wins:              ${wins}`);
console.log(`   Losses:            ${losses}`);
console.log(`   Win Rate:          ${winRate.toFixed(2)}%`);
console.log(`   Avg Bet Size:      ${avgBetSize.toFixed(4)} BNB\n`);

if (trades.length > 0) {
  console.log(`📋 Recent Trades (Last 10):`);
  const recentTrades = trades.slice(-10);
  console.log(`   Epoch      Signal  Crowd%  Gap%   Bet      Result  Payout   Bankroll`);
  console.log(`   ─────────────────────────────────────────────────────────────────────`);

  for (const trade of recentTrades) {
    const result = trade.won ? '✅ WIN' : '❌ LOSS';
    console.log(
      `   ${trade.epoch.toString().padEnd(10)} ` +
      `${trade.signal.padEnd(6)} ` +
      `${(trade.crowdPct * 100).toFixed(1).padStart(5)}%  ` +
      `${(trade.emaGap * 100).toFixed(2).padStart(5)}%  ` +
      `${trade.betAmount.toFixed(4)} ` +
      `${result}  ` +
      `${trade.payout.toFixed(4).padStart(7)}  ` +
      `${trade.bankroll.toFixed(4)}`
    );
  }

  console.log('\n');
}

console.log('═══════════════════════════════════════════════════════');
console.log('🎯 STRATEGY VALIDATION');
console.log('═══════════════════════════════════════════════════════');
console.log(`   Expected Win Rate: 68.18% (from historical data)`);
console.log(`   Actual Win Rate:   ${winRate.toFixed(2)}%`);
console.log(`   Difference:        ${(winRate - 68.18) >= 0 ? '+' : ''}${(winRate - 68.18).toFixed(2)}%\n`);

if (totalTrades < 20) {
  console.log('⚠️  WARNING: Small sample size (<20 trades). Results may not be reliable.\n');
}

if (winRate >= 65) {
  console.log('✅ Strategy performing well! Win rate meets expectations.\n');
} else if (winRate >= 55) {
  console.log('🟡 Strategy performing okay, but below expected win rate.\n');
} else {
  console.log('⚠️  Strategy underperforming. Review conditions and data quality.\n');
}
