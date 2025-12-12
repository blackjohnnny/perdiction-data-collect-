import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n📈 EMA-ONLY STRATEGY TEST - IGNORE CROWD COMPLETELY\n');
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

// EMA-ONLY STRATEGY: Trade purely based on EMA signal, ignore crowd completely
console.log('🎯 EMA-ONLY STRATEGY:\n');
console.log('  📌 If EMA gap > 0.05% → Bet BULL');
console.log('  📌 If EMA gap < -0.05% → Bet BEAR');
console.log('  📌 Ignore crowd sentiment completely');
console.log('  📌 Using TradingView/Binance EMA data stored in database\n');
console.log('─'.repeat(80) + '\n');

let totalTrades = 0;
let wins = 0;
let losses = 0;
let totalProfit = 0;
let skippedNoSignal = 0;

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];

  if (i % 100 === 0 && i > 0) {
    console.log(`  Processing round ${i}/${rounds.length}... (${totalTrades} trades so far)`);
  }

  // Use stored EMA data (from TradingView/Binance API)
  const emaSignal = r.ema_signal;
  const emaGap = parseFloat(r.ema_gap);

  // EMA-ONLY STRATEGY: Follow EMA signal regardless of crowd
  let betSide = null;
  if (emaSignal === 'BULL') {
    betSide = 'BULL';
  } else if (emaSignal === 'BEAR') {
    betSide = 'BEAR';
  }

  if (!betSide) {
    skippedNoSignal++;
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
console.log('📊 EMA-ONLY STRATEGY RESULTS:\n');
console.log(`  Total rounds processed: ${rounds.length}`);
console.log(`  Skipped (EMA neutral): ${skippedNoSignal}`);
console.log(`  Total trades: ${totalTrades}`);
console.log(`  Wins: ${wins} (${totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : 0}%)`);
console.log(`  Losses: ${losses}`);
console.log(`  Total profit: ${totalProfit.toFixed(2)} units`);
console.log(`  ROI: ${totalTrades > 0 ? ((totalProfit / totalTrades) * 100).toFixed(2) : 0}%`);
console.log('\n' + '═'.repeat(80) + '\n');

db.close();
