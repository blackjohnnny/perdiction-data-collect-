import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🔄 CONTRARIAN STRATEGY TEST - BET AGAINST CROWD\n');
console.log('═'.repeat(80) + '\n');

const db = initDatabase(DB_PATH);

// Get all complete rounds with stored EMA data from TradingView/Binance API
const rounds = db.prepare(`
  SELECT
    sample_id,
    epoch,
    lock_timestamp,
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

console.log(`📊 Found ${rounds.length} complete rounds with TradingView EMA data\n`);
console.log('─'.repeat(80) + '\n');

// CONTRARIAN STRATEGY: Bet AGAINST crowd when ≥65% + EMA confirms opposite direction
console.log('🎯 CONTRARIAN STRATEGY:\n');
console.log('  📌 If crowd is BULL (≥65%) + EMA BULL → Bet BEAR (opposite)');
console.log('  📌 If crowd is BEAR (≥65%) + EMA BEAR → Bet BULL (opposite)');
console.log('  📌 Using TradingView/Binance EMA data stored in database\n');
console.log('─'.repeat(80) + '\n');

let totalTrades = 0;
let wins = 0;
let losses = 0;
let totalProfit = 0;
let skippedNoCrowd = 0;
let skippedNoConfirm = 0;

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];

  if (i % 100 === 0 && i > 0) {
    console.log(`  Processing round ${i}/${rounds.length}... (${totalTrades} trades so far)`);
  }

  // Calculate T-20s crowd from TradingView data collection
  const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;

  if (total === 0) {
    skippedNoCrowd++;
    continue;
  }

  const bullPercent = (bullWei / total) * 100;
  const bearPercent = (bearWei / total) * 100;

  // Filter: Strong crowd (≥65%)
  let crowdSide = null;
  if (bullPercent >= 65) {
    crowdSide = 'BULL';
  } else if (bearPercent >= 65) {
    crowdSide = 'BEAR';
  }

  if (!crowdSide) {
    skippedNoCrowd++;
    continue;
  }

  // Use stored EMA data (from TradingView/Binance API)
  const emaSignal = r.ema_signal;
  const emaGap = parseFloat(r.ema_gap);

  // CONTRARIAN STRATEGY: Bet AGAINST crowd when EMA confirms crowd direction
  let betSide = null;
  if (crowdSide === 'BULL' && emaSignal === 'BULL') {
    betSide = 'BEAR'; // Crowd + EMA say BULL → We bet BEAR
  } else if (crowdSide === 'BEAR' && emaSignal === 'BEAR') {
    betSide = 'BULL'; // Crowd + EMA say BEAR → We bet BULL
  }

  if (!betSide) {
    skippedNoConfirm++;
    continue;
  }

  // Execute trade
  totalTrades++;
  const won = betSide === r.winner.toUpperCase();

  if (won) {
    wins++;
    const payout = parseFloat(r.winner_payout_multiple);
    totalProfit += (payout - 1);
  } else {
    losses++;
    totalProfit -= 1;
  }
}

console.log('\n' + '═'.repeat(80) + '\n');
console.log('📊 CONTRARIAN STRATEGY RESULTS:\n');
console.log(`  Total rounds processed: ${rounds.length}`);
console.log(`  Skipped (no crowd ≥65%): ${skippedNoCrowd}`);
console.log(`  Skipped (EMA ≠ crowd): ${skippedNoConfirm}`);
console.log(`  Total trades: ${totalTrades}`);
console.log(`  Wins: ${wins} (${totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : 0}%)`);
console.log(`  Losses: ${losses}`);
console.log(`  Total profit: ${totalProfit.toFixed(2)} units`);
console.log(`  ROI: ${totalTrades > 0 ? ((totalProfit / totalTrades) * 100).toFixed(2) : 0}%`);
console.log('\n' + '═'.repeat(80) + '\n');

db.close();
