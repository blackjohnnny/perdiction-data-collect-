import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/live-monitor.db');
const db = new SQL.Database(buffer);

// Strategy: EMA 5/13 + T-20s Crowd ≥55% Agreement
// Position Size: 6.5% of portfolio per trade

const CROWD_THRESHOLD = 0.55; // 55%
const POSITION_SIZE = 0.065; // 6.5%
const STARTING_BANKROLL = 1.0; // 1 BNB

// Fetch all rounds with T-20s data, ordered by epoch
const query = `
  SELECT
    epoch,
    lock_price,
    close_price,
    winner,
    t20s_bull_wei,
    t20s_bear_wei,
    t20s_total_wei,
    bull_amount_wei,
    bear_amount_wei,
    total_amount_wei
  FROM rounds
  WHERE t20s_total_wei IS NOT NULL
    AND winner IN ('UP', 'DOWN')
  ORDER BY epoch ASC
`;

const stmt = db.prepare(query);
const rounds = [];
while (stmt.step()) {
  const row = stmt.getAsObject();
  rounds.push({
    epoch: row.epoch,
    lockPrice: BigInt(row.lock_price),
    closePrice: BigInt(row.close_price),
    winner: row.winner,
    t20sBullWei: BigInt(row.t20s_bull_wei),
    t20sBearWei: BigInt(row.t20s_bear_wei),
    t20sTotalWei: BigInt(row.t20s_total_wei),
    finalBullWei: BigInt(row.bull_amount_wei),
    finalBearWei: BigInt(row.bear_amount_wei),
    finalTotalWei: BigInt(row.total_amount_wei),
  });
}
stmt.free();
db.close();

console.log(`Loaded ${rounds.length} rounds with T-20s data\n`);

// Calculate EMA
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = [];

  // Start with SMA for first value
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i];
  }
  ema[period - 1] = sum / period;

  // Calculate EMA for rest
  for (let i = period; i < prices.length; i++) {
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }

  return ema;
}

// Get EMA signal
function getEMASignal(prices) {
  if (prices.length < 13) return null;

  const ema5 = calculateEMA(prices, 5);
  const ema13 = calculateEMA(prices, 13);

  const lastEma5 = ema5[ema5.length - 1];
  const lastEma13 = ema13[ema13.length - 1];

  return lastEma5 > lastEma13 ? 'UP' : 'DOWN';
}

// Get T-20s crowd direction
function getT20sCrowdDirection(bullWei, bearWei, totalWei) {
  const bullPercent = Number(bullWei) / Number(totalWei);
  const bearPercent = Number(bearWei) / Number(totalWei);

  if (bullPercent >= CROWD_THRESHOLD) return 'UP';
  if (bearPercent >= CROWD_THRESHOLD) return 'DOWN';
  return null; // No clear crowd
}

// Calculate payout for a bet
function calculatePayout(betDirection, betAmount, finalBullWei, finalBearWei, finalTotalWei) {
  const houseEdge = 0.03; // 3%
  const rewardPool = Number(finalTotalWei) * (1 - houseEdge);

  if (betDirection === 'UP') {
    const totalBullWei = Number(finalBullWei);
    const payout = (rewardPool / totalBullWei) * betAmount;
    return payout;
  } else {
    const totalBearWei = Number(finalBearWei);
    const payout = (rewardPool / totalBearWei) * betAmount;
    return payout;
  }
}

// Run simulation
let bankroll = STARTING_BANKROLL;
let totalTrades = 0;
let wins = 0;
let losses = 0;
let totalWagered = 0;
let totalReturned = 0;
let skippedRounds = 0;

const prices = [];
const tradeLog = [];

console.log('=== STRATEGY SIMULATION ===');
console.log(`Starting Bankroll: ${STARTING_BANKROLL} BNB`);
console.log(`Position Size: ${POSITION_SIZE * 100}% per trade`);
console.log(`Crowd Threshold: ≥${CROWD_THRESHOLD * 100}%`);
console.log(`Strategy: EMA 5/13 + T-20s Crowd Agreement\n`);

for (const round of rounds) {
  // Need at least 13 PREVIOUS prices for EMA calculation at T-20s decision time
  if (prices.length < 13) {
    const lockPrice = Number(round.lockPrice) / 1e8;
    prices.push(lockPrice);
    skippedRounds++;
    continue;
  }

  // Get EMA signal using ONLY prices available BEFORE T-20s (previous rounds)
  const emaSignal = getEMASignal(prices);
  if (!emaSignal) {
    skippedRounds++;
    continue;
  }

  // Get T-20s crowd direction
  const crowdDirection = getT20sCrowdDirection(
    round.t20sBullWei,
    round.t20sBearWei,
    round.t20sTotalWei
  );

  // Check if EMA and crowd agree
  if (!crowdDirection || emaSignal !== crowdDirection) {
    // Add current lock price to history even if we skip
    const lockPrice = Number(round.lockPrice) / 1e8;
    prices.push(lockPrice);
    skippedRounds++;
    continue;
  }

  // Place bet!
  const betAmount = bankroll * POSITION_SIZE;
  const betDirection = emaSignal;

  totalTrades++;
  totalWagered += betAmount;

  // Calculate result
  const won = betDirection === round.winner;
  const payout = won ? calculatePayout(
    betDirection,
    betAmount,
    round.finalBullWei,
    round.finalBearWei,
    round.finalTotalWei
  ) : 0;

  totalReturned += payout;

  // Update bankroll
  const profit = payout - betAmount;
  bankroll += profit;

  if (won) {
    wins++;
  } else {
    losses++;
  }

  // Log trade
  tradeLog.push({
    epoch: round.epoch,
    betDirection,
    betAmount,
    won,
    payout,
    profit,
    bankroll,
    multiple: payout / betAmount,
  });

  // Show every 50th trade or significant changes
  if (totalTrades % 50 === 0 || totalTrades <= 10) {
    const multiple = won ? (payout / betAmount).toFixed(3) : '0.000';
    console.log(
      `Trade #${totalTrades} | Epoch ${round.epoch} | ${betDirection} | ` +
      `Bet: ${betAmount.toFixed(4)} | ${won ? 'WIN' : 'LOSS'} | ` +
      `${multiple}x | Bankroll: ${bankroll.toFixed(4)} BNB`
    );
  }

  // Add current round's lock price to history AFTER the trade
  const lockPrice = Number(round.lockPrice) / 1e8;
  prices.push(lockPrice);
}

// Final results
console.log('\n=== FINAL RESULTS ===');
console.log(`Total Rounds: ${rounds.length}`);
console.log(`Skipped (EMA warmup / no signal): ${skippedRounds}`);
console.log(`Total Trades: ${totalTrades}`);
console.log(`Wins: ${wins}`);
console.log(`Losses: ${losses}`);
console.log(`Win Rate: ${((wins / totalTrades) * 100).toFixed(2)}%\n`);

console.log(`Starting Bankroll: ${STARTING_BANKROLL.toFixed(4)} BNB`);
console.log(`Final Bankroll: ${bankroll.toFixed(4)} BNB`);
console.log(`Total Profit/Loss: ${(bankroll - STARTING_BANKROLL).toFixed(4)} BNB`);
console.log(`ROI: ${((bankroll - STARTING_BANKROLL) / STARTING_BANKROLL * 100).toFixed(2)}%\n`);

console.log(`Total Wagered: ${totalWagered.toFixed(4)} BNB`);
console.log(`Total Returned: ${totalReturned.toFixed(4)} BNB`);
console.log(`Avg Return per Trade: ${(totalReturned / totalWagered).toFixed(4)}x\n`);

// Show last 10 trades
console.log('=== LAST 10 TRADES ===');
const last10 = tradeLog.slice(-10);
last10.forEach((trade, i) => {
  console.log(
    `${tradeLog.length - 9 + i}. Epoch ${trade.epoch} | ${trade.betDirection} | ` +
    `Bet: ${trade.betAmount.toFixed(4)} | ${trade.won ? 'WIN' : 'LOSS'} | ` +
    `${trade.multiple.toFixed(3)}x | Bankroll: ${trade.bankroll.toFixed(4)}`
  );
});

// Drawdown analysis
let maxBankroll = STARTING_BANKROLL;
let maxDrawdown = 0;
let currentStreak = 0;
let maxWinStreak = 0;
let maxLoseStreak = 0;

for (const trade of tradeLog) {
  if (trade.bankroll > maxBankroll) {
    maxBankroll = trade.bankroll;
  }

  const drawdown = (maxBankroll - trade.bankroll) / maxBankroll;
  if (drawdown > maxDrawdown) {
    maxDrawdown = drawdown;
  }

  if (trade.won) {
    if (currentStreak >= 0) {
      currentStreak++;
    } else {
      currentStreak = 1;
    }
    if (currentStreak > maxWinStreak) {
      maxWinStreak = currentStreak;
    }
  } else {
    if (currentStreak <= 0) {
      currentStreak--;
    } else {
      currentStreak = -1;
    }
    if (Math.abs(currentStreak) > maxLoseStreak) {
      maxLoseStreak = Math.abs(currentStreak);
    }
  }
}

console.log('\n=== RISK METRICS ===');
console.log(`Max Drawdown: ${(maxDrawdown * 100).toFixed(2)}%`);
console.log(`Max Win Streak: ${maxWinStreak}`);
console.log(`Max Loss Streak: ${maxLoseStreak}`);
console.log(`Peak Bankroll: ${maxBankroll.toFixed(4)} BNB`);
