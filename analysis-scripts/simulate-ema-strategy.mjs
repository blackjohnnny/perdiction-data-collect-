import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('   EMA 5/13 + T-20s CROWD CONFIRMATION STRATEGY SIMULATION');
console.log('═══════════════════════════════════════════════════════════════\n');

// Get all rounds with T-20s snapshots and final results
const query = `
  SELECT
    r.epoch,
    r.winner,
    r.close_price,
    r.lock_price,
    s.implied_up_multiple,
    s.implied_down_multiple,
    s.bull_amount_wei,
    s.bear_amount_wei
  FROM rounds r
  JOIN snapshots s ON r.epoch = s.epoch
  WHERE r.winner IN ('UP', 'DOWN')
    AND s.snapshot_type = 'T_MINUS_20S'
  ORDER BY r.epoch ASC
`;

const stmt = db.prepare(query);
const rounds = [];
while (stmt.step()) {
  const row = stmt.getAsObject();
  rounds.push({
    epoch: row.epoch,
    winner: row.winner,
    closePrice: BigInt(row.close_price),
    lockPrice: BigInt(row.lock_price),
    impliedUp: row.implied_up_multiple,
    impliedDown: row.implied_down_multiple,
    bullAmount: BigInt(row.bull_amount_wei),
    bearAmount: BigInt(row.bear_amount_wei)
  });
}
stmt.free();
db.close();

console.log(`📊 Total rounds with T-20s + results: ${rounds.length}\n`);

// Calculate EMA
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = [];
  ema[0] = prices[0];

  for (let i = 1; i < prices.length; i++) {
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }

  return ema;
}

// Calculate price movements and EMAs
const closePrices = rounds.map(r => Number(r.closePrice) / 1e8); // Convert to readable format
const ema5 = calculateEMA(closePrices, 5);
const ema13 = calculateEMA(closePrices, 13);

// Strategy parameters
const IMBALANCE_THRESHOLD = 2.0; // Bet when one side has >2x payout
const INITIAL_BANKROLL = 1.0; // 1 BNB
const BET_SIZE_PERCENT = 0.02; // 2% of bankroll per bet (Kelly-inspired)

let bankroll = INITIAL_BANKROLL;
let totalBets = 0;
let wins = 0;
let losses = 0;
let skippedRounds = 0;
const history = [];

console.log('Strategy Rules:');
console.log('  1. EMA Signal: Bet UP if EMA5 > EMA13, DOWN if EMA5 < EMA13');
console.log('  2. Crowd Confirmation: Only bet if T-20s shows >2x payout (crowd disagrees)');
console.log('  3. Position Size: 2% of current bankroll per bet');
console.log('  4. Contrarian: Bet AGAINST the crowd (underdog)\n');
console.log(`${'─'.repeat(63)}\n`);

for (let i = 13; i < rounds.length; i++) { // Start after EMA13 warmup
  const round = rounds[i];

  // EMA signal
  const emaSignal = ema5[i] > ema13[i] ? 'UP' : 'DOWN';

  // T-20s crowd position (favorite = where more money is)
  const crowdFavorite = round.impliedUp < round.impliedDown ? 'UP' : 'DOWN';
  const maxPayout = Math.max(round.impliedUp, round.impliedDown);

  // Check if crowd is imbalanced enough
  if (maxPayout < IMBALANCE_THRESHOLD) {
    skippedRounds++;
    continue;
  }

  // Our bet: EMA signal that is ALSO the underdog
  let ourBet = null;
  let payout = 0;

  if (emaSignal === 'UP' && crowdFavorite === 'DOWN') {
    // EMA says UP, crowd favors DOWN -> bet UP (underdog)
    ourBet = 'UP';
    payout = round.impliedUp;
  } else if (emaSignal === 'DOWN' && crowdFavorite === 'UP') {
    // EMA says DOWN, crowd favors UP -> bet DOWN (underdog)
    ourBet = 'DOWN';
    payout = round.impliedDown;
  } else {
    // EMA and crowd agree, skip
    skippedRounds++;
    continue;
  }

  // Place bet
  const betSize = bankroll * BET_SIZE_PERCENT;
  const won = ourBet === round.winner;

  totalBets++;

  // Remove bet from bankroll first
  bankroll -= betSize;

  if (won) {
    // If win: get back betSize * payout
    // Example: bet 1 BNB at 2.0x = get 2 BNB back
    const totalReturn = betSize * payout;
    bankroll += totalReturn;
    const netProfit = totalReturn - betSize;
    wins++;
    history.push({
      epoch: round.epoch,
      bet: ourBet,
      result: 'WIN',
      betSize: betSize.toFixed(4),
      profit: netProfit.toFixed(4),
      bankroll: bankroll.toFixed(4),
      payout: payout.toFixed(2)
    });
  } else {
    // If loss: lose the bet (already removed above)
    losses++;
    history.push({
      epoch: round.epoch,
      bet: ourBet,
      result: 'LOSS',
      betSize: betSize.toFixed(4),
      profit: (-betSize).toFixed(4),
      bankroll: bankroll.toFixed(4),
      payout: payout.toFixed(2)
    });
  }
}

// Results
console.log('═══════════════════════════════════════════════════════════════');
console.log('                     SIMULATION RESULTS');
console.log('═══════════════════════════════════════════════════════════════\n');

const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;
const finalProfit = bankroll - INITIAL_BANKROLL;
const roi = ((bankroll - INITIAL_BANKROLL) / INITIAL_BANKROLL) * 100;

console.log(`Starting Bankroll:     ${INITIAL_BANKROLL.toFixed(4)} BNB`);
console.log(`Final Bankroll:        ${bankroll.toFixed(4)} BNB`);
console.log(`Net Profit/Loss:       ${finalProfit >= 0 ? '+' : ''}${finalProfit.toFixed(4)} BNB`);
console.log(`ROI:                   ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%\n`);

console.log(`Total Rounds:          ${rounds.length - 13} (after EMA warmup)`);
console.log(`Bets Placed:           ${totalBets}`);
console.log(`Rounds Skipped:        ${skippedRounds}`);
console.log(`Wins / Losses:         ${wins} / ${losses}`);
console.log(`Win Rate:              ${winRate.toFixed(2)}%\n`);

if (roi > 0) {
  console.log('✅ PROFITABLE STRATEGY! 🎯\n');
} else {
  console.log('❌ Strategy not profitable on this dataset\n');
}

// Show first 10 and last 10 bets
console.log('═══════════════════════════════════════════════════════════════');
console.log('                   BET HISTORY (First 10)');
console.log('═══════════════════════════════════════════════════════════════\n');

history.slice(0, 10).forEach((h, i) => {
  console.log(`${i + 1}. Epoch ${h.epoch}: ${h.result} (${h.bet}) | Bet: ${h.betSize} BNB | P/L: ${h.profit} BNB | Bankroll: ${h.bankroll} BNB`);
});

if (history.length > 20) {
  console.log('\n...\n');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                   BET HISTORY (Last 10)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  history.slice(-10).forEach((h, i) => {
    console.log(`${history.length - 10 + i + 1}. Epoch ${h.epoch}: ${h.result} (${h.bet}) | Bet: ${h.betSize} BNB | P/L: ${h.profit} BNB | Bankroll: ${h.bankroll} BNB`);
  });
}

console.log('\n═══════════════════════════════════════════════════════════════\n');
