import initSqlJs from 'sql.js';
import fs from 'fs';

const sqlJs = await initSqlJs();
const buf = fs.readFileSync('../data/prediction-data.db');
const db = new sqlJs.Database(buf);

// Get ALL rounds with snapshots (T-20s OR T-25s) AND results
const query = `
  SELECT
    r.epoch,
    r.lock_ts,
    r.winner,
    s.snapshot_type,
    s.bull_amount_wei,
    s.bear_amount_wei,
    s.implied_up_multiple,
    s.implied_down_multiple,
    r.bull_amount_wei as final_bull_wei,
    r.bear_amount_wei as final_bear_wei,
    r.winner_multiple
  FROM snapshots s
  JOIN rounds r ON s.epoch = r.epoch
  WHERE (s.snapshot_type = 'T_MINUS_20S' OR s.snapshot_type = 'T_MINUS_25S')
    AND r.winner != 'UNKNOWN'
  ORDER BY r.epoch
`;

const result = db.exec(query);

if (result.length === 0) {
  console.log('No data found');
  process.exit(0);
}

const rows = result[0].values;
console.log(`Found ${rows.length} rounds with T-20s/T-25s snapshots and results\n`);

// Fetch EMA data for all rounds
console.log('Fetching EMA data from TradingView...');
const lockTimestamps = rows.map(row => row[1]);
const minLockTs = Math.min(...lockTimestamps);
const maxLockTs = Math.max(...lockTimestamps);

const startTime = minLockTs - 3600; // 1 hour before first lock
const endTime = maxLockTs + 3600; // 1 hour after last lock

const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.BNB/USD&resolution=5&from=${startTime}&to=${endTime}`;
const response = await globalThis.fetch(url);
const candles = await response.json();

console.log(`Fetched ${candles.t.length} 5-minute candles\n`);

// Calculate EMA 5 and EMA 13
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const emaArray = [prices[0]];

  for (let i = 1; i < prices.length; i++) {
    emaArray.push(prices[i] * k + emaArray[i - 1] * (1 - k));
  }

  return emaArray;
}

const closes = candles.c;
const ema5 = calculateEMA(closes, 5);
const ema13 = calculateEMA(closes, 13);

// Create timestamp -> EMA mapping
const emaMap = new Map();
for (let i = 0; i < candles.t.length; i++) {
  emaMap.set(candles.t[i], {
    ema5: ema5[i],
    ema13: ema13[i],
    close: closes[i]
  });
}

// Strategy simulation
let bankroll = 1.0;
let wins = 0;
let losses = 0;
let totalBets = 0;
let totalWagered = 0;
let totalReturned = 0;
let skippedNoEMA = 0;
let skippedNoCrowd = 0;
let skippedDisagree = 0;

const BET_PERCENTAGE = 0.02;
const CROWD_THRESHOLD = 0.55;
const MAX_BANKROLL = 1000000;

rows.forEach(row => {
  const [epoch, lockTs, winner, snapshotType, bullWei, bearWei, upPayout, downPayout, finalBullWei, finalBearWei, winnerMultiple] = row;

  const bullAmount = parseFloat(bullWei) / 1e18;
  const bearAmount = parseFloat(bearWei) / 1e18;
  const totalPool = bullAmount + bearAmount;

  const bullPct = bullAmount / totalPool;
  const bearPct = bearAmount / totalPool;

  // Calculate final payouts
  const finalBull = parseFloat(finalBullWei) / 1e18;
  const finalBear = parseFloat(finalBearWei) / 1e18;
  const finalTotal = finalBull + finalBear;
  const finalUpPayout = (finalTotal * 0.97) / finalBull;
  const finalDownPayout = (finalTotal * 0.97) / finalBear;

  // Determine crowd
  let crowd = null;
  if (bullPct >= CROWD_THRESHOLD) crowd = 'UP';
  else if (bearPct >= CROWD_THRESHOLD) crowd = 'DOWN';

  if (!crowd) {
    skippedNoCrowd++;
    return;
  }

  // Find closest EMA candle (round to nearest 5-minute interval)
  const roundedLockTs = Math.floor(lockTs / 300) * 300;
  const emaData = emaMap.get(roundedLockTs);

  if (!emaData) {
    skippedNoEMA++;
    return;
  }

  // Determine EMA signal
  const emaSignal = emaData.ema5 > emaData.ema13 ? 'UP' : 'DOWN';

  // Only bet if EMA and crowd agree
  if (emaSignal !== crowd) {
    skippedDisagree++;
    return;
  }

  // Place bet
  const ourBet = crowd; // Bet WITH both EMA and crowd
  const won = (ourBet === winner);

  const betSize = Math.min(bankroll * BET_PERCENTAGE, bankroll);
  totalWagered += betSize;
  totalBets++;

  bankroll -= betSize;

  if (won) {
    const payout = ourBet === 'UP' ? finalUpPayout : finalDownPayout;
    const totalReturn = betSize * payout;
    bankroll += totalReturn;
    totalReturned += totalReturn;
    wins++;
  } else {
    losses++;
  }

  if (bankroll > MAX_BANKROLL) bankroll = MAX_BANKROLL;
});

const winRate = (wins / totalBets * 100).toFixed(2);
const avgReturn = totalBets > 0 ? (totalReturned / totalWagered).toFixed(4) : 0;
const edge = totalBets > 0 ? ((totalReturned / totalWagered - 1) * 100).toFixed(2) : 0;
const roi = ((bankroll - 1) * 100).toFixed(2);

console.log('=== EMA 5/13 + T-20s/T-25s Crowd Strategy (All 285 Rounds) ===');
console.log(`Total rounds analyzed:  ${rows.length}`);
console.log(`Skipped (no crowd):     ${skippedNoCrowd}`);
console.log(`Skipped (no EMA data):  ${skippedNoEMA}`);
console.log(`Skipped (EMA disagree): ${skippedDisagree}`);
console.log(`\nTotal Bets:            ${totalBets}`);
console.log(`Wins / Losses:         ${wins} / ${losses}`);
console.log(`Win Rate:              ${winRate}%`);
console.log(`Total Wagered:         ${totalWagered.toFixed(4)} BNB`);
console.log(`Total Returned:        ${totalReturned.toFixed(4)} BNB`);
console.log(`Avg Return per BNB:    ${avgReturn} BNB`);
console.log(`Edge per bet:          ${edge}%`);
console.log(`\nStarting Bankroll:     1.00 BNB`);
console.log(`Ending Bankroll:       ${bankroll.toFixed(4)} BNB`);
console.log(`ROI:                   ${roi}%`);

db.close();
