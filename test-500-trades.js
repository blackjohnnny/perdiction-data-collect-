import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';

console.log('\n🧪 TESTING STRATEGY ON 500 TRADES (Original Settings)\n');
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
  ORDER BY sample_id ASC
`).all();

console.log(`📊 Found ${rounds.length} complete rounds with EMA data\n`);
console.log('─'.repeat(80) + '\n');

// Test ORIGINAL strategy: Bet WITH crowd ≥65% + EMA confirmation (gap > 0.05%)
console.log('🎯 TESTING ORIGINAL STRATEGY (Crowd ≥65% + EMA Gap > 0.05%):\n');

let totalTrades = 0;
let wins = 0;
let losses = 0;
let totalProfit = 0;
let skippedNoCrowd = 0;
let skippedNoConfirm = 0;

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];

  // Stop at 500 trades
  if (totalTrades >= 500) {
    console.log(`\n✅ Reached 500 trades limit\n`);
    break;
  }

  if (i % 50 === 0) {
    console.log(`Processing round ${i + 1}/${rounds.length}... (${totalTrades} trades so far)`);
  }

  // Calculate T-20s crowd
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

  // Use stored EMA signal
  const emaSignal = r.ema_signal;

  // ORIGINAL STRATEGY: Bet WITH crowd when EMA confirms
  let betSide = null;
  if (crowdSide === 'BULL' && emaSignal === 'BULL') {
    betSide = 'BULL';
  } else if (crowdSide === 'BEAR' && emaSignal === 'BEAR') {
    betSide = 'BEAR';
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
console.log('📊 FINAL RESULTS:\n');
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
