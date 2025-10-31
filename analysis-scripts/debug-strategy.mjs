import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

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

console.log(`Total rounds: ${rounds.length}\n`);

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

const closePrices = rounds.map(r => Number(r.closePrice) / 1e8);
const ema5 = calculateEMA(closePrices, 5);
const ema13 = calculateEMA(closePrices, 13);

console.log('First 20 rounds analysis:\n');

for (let i = 13; i < Math.min(33, rounds.length); i++) {
  const round = rounds[i];

  const emaSignal = ema5[i] > ema13[i] ? 'UP' : 'DOWN';
  const crowdFavorite = round.impliedUp < round.impliedDown ? 'UP' : 'DOWN';
  const underdog = crowdFavorite === 'UP' ? 'DOWN' : 'UP';
  const maxPayout = Math.max(round.impliedUp, round.impliedDown);

  // Check EMA alone
  const emaCorrect = emaSignal === round.winner;

  // Check crowd (favorite)
  const crowdCorrect = crowdFavorite === round.winner;

  // Check our strategy (EMA + underdog)
  let ourBet = null;
  if (emaSignal === 'UP' && crowdFavorite === 'DOWN') {
    ourBet = 'UP';
  } else if (emaSignal === 'DOWN' && crowdFavorite === 'UP') {
    ourBet = 'DOWN';
  }

  const weWouldBet = ourBet !== null && maxPayout >= 2.0;
  const weWin = ourBet === round.winner;

  console.log(`Epoch ${round.epoch}:`);
  console.log(`  Winner: ${round.winner}`);
  console.log(`  EMA Signal: ${emaSignal} ${emaCorrect ? '✓' : '✗'}`);
  console.log(`  Crowd Favorite: ${crowdFavorite} ${crowdCorrect ? '✓' : '✗'}`);
  console.log(`  Underdog: ${underdog}`);
  console.log(`  Max Payout: ${maxPayout.toFixed(2)}x`);
  console.log(`  Our Bet: ${ourBet || 'SKIP'} ${weWouldBet ? (weWin ? '✓ WIN' : '✗ LOSS') : '(skipped)'}`);
  console.log('');
}

// Overall stats
let emaWins = 0;
let crowdWins = 0;
let strategyBets = 0;
let strategyWins = 0;

for (let i = 13; i < rounds.length; i++) {
  const round = rounds[i];

  const emaSignal = ema5[i] > ema13[i] ? 'UP' : 'DOWN';
  const crowdFavorite = round.impliedUp < round.impliedDown ? 'UP' : 'DOWN';
  const maxPayout = Math.max(round.impliedUp, round.impliedDown);

  if (emaSignal === round.winner) emaWins++;
  if (crowdFavorite === round.winner) crowdWins++;

  let ourBet = null;
  if (emaSignal === 'UP' && crowdFavorite === 'DOWN') {
    ourBet = 'UP';
  } else if (emaSignal === 'DOWN' && crowdFavorite === 'UP') {
    ourBet = 'DOWN';
  }

  if (ourBet && maxPayout >= 2.0) {
    strategyBets++;
    if (ourBet === round.winner) strategyWins++;
  }
}

const totalRounds = rounds.length - 13;
console.log('\n═══════════════════════════════════════════════════');
console.log('OVERALL STATISTICS (after EMA warmup)');
console.log('═══════════════════════════════════════════════════\n');
console.log(`Total Rounds: ${totalRounds}`);
console.log(`EMA Accuracy: ${emaWins}/${totalRounds} (${(emaWins/totalRounds*100).toFixed(2)}%)`);
console.log(`Crowd Accuracy: ${crowdWins}/${totalRounds} (${(crowdWins/totalRounds*100).toFixed(2)}%)`);
console.log(`Strategy Bets: ${strategyBets}`);
console.log(`Strategy Wins: ${strategyWins}/${strategyBets} (${(strategyWins/strategyBets*100).toFixed(2)}%)`);
