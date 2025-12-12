import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🧪 TESTING STRATEGY: EMA Gap 0.03%, No Crowd Requirement, No Momentum\n');
console.log('═'.repeat(80) + '\n');

const db = initDatabase(DB_PATH);

// Get all complete rounds (T-20s + Winner)
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
    AND ema_gap IS NOT NULL
  ORDER BY sample_id ASC
`).all();

console.log(`📊 Found ${rounds.length} complete rounds with EMA data\n`);
console.log('─'.repeat(80) + '\n');

// Test NEW strategy: EMA gap > 0.03% (BULL) or < -0.03% (BEAR), no crowd requirement
console.log('🎯 TESTING NEW STRATEGY:\n');
console.log('  📌 Entry: EMA gap > 0.03% = BULL, gap < -0.03% = BEAR');
console.log('  📌 No crowd requirement (ignore crowd %)');
console.log('  📌 No momentum filter\n');

let totalTrades = 0;
let wins = 0;
let losses = 0;
let totalProfit = 0;
let skippedNoSignal = 0;

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];

  if (i % 50 === 0) {
    console.log(`Processing round ${i + 1}/${rounds.length}... (${totalTrades} trades so far)`);
  }

  // NEW STRATEGY: Only use EMA gap threshold of 0.03%
  const emaGap = parseFloat(r.ema_gap);

  let betSide = null;
  if (emaGap > 0.03) {
    betSide = 'BULL';
  } else if (emaGap < -0.03) {
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
console.log('📊 FINAL RESULTS:\n');
console.log(`  Total rounds processed: ${rounds.length}`);
console.log(`  Skipped (EMA gap < 0.03%): ${skippedNoSignal}`);
console.log(`  Total trades: ${totalTrades}`);
console.log(`  Wins: ${wins} (${totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : 0}%)`);
console.log(`  Losses: ${losses}`);
console.log(`  Total profit: ${totalProfit.toFixed(2)} units`);
console.log(`  ROI: ${totalTrades > 0 ? ((totalProfit / totalTrades) * 100).toFixed(2) : 0}%`);
console.log('\n' + '═'.repeat(80) + '\n');

db.close();
