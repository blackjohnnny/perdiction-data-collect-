import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

const db = initDatabase(DB_PATH);

console.log('\n📊 LAST NIGHT DATA ANALYSIS\n');
console.log('═'.repeat(80) + '\n');

// Get data from last 24 hours
const yesterday = Math.floor(Date.now() / 1000) - (24 * 60 * 60);

const recentRounds = db.prepare(`
  SELECT
    sample_id,
    epoch,
    lock_timestamp,
    t20s_bull_wei,
    t20s_bear_wei,
    winner,
    winner_payout_multiple,
    ema_gap
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND lock_timestamp >= ?
  ORDER BY lock_timestamp ASC
`).all(yesterday);

console.log(`📅 Last 24 hours: ${recentRounds.length} complete rounds\n`);

if (recentRounds.length === 0) {
  console.log('No new complete rounds in last 24 hours.\n');
  db.close();
  process.exit(0);
}

const EMA_THRESHOLD = 0.05;
const PAYOUT_THRESHOLD = 1.45;

let tradesWithFilter = 0;
let winsWithFilter = 0;
let tradesNoFilter = 0;
let winsNoFilter = 0;

for (const r of recentRounds) {
  const emaGap = parseFloat(r.ema_gap || 0);

  // Check EMA signal
  let emaSide = null;
  if (emaGap > EMA_THRESHOLD) emaSide = 'BULL';
  else if (emaGap < -EMA_THRESHOLD) emaSide = 'BEAR';

  if (!emaSide) continue;

  const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;

  if (total === 0) continue;

  const estimatedPayout = emaSide === 'BULL' ? (total / bullWei) : (total / bearWei);

  // No filter - all EMA trades
  tradesNoFilter++;
  if (emaSide === r.winner.toUpperCase()) {
    winsNoFilter++;
  }

  // With payout filter ≥1.45x
  if (estimatedPayout >= PAYOUT_THRESHOLD) {
    tradesWithFilter++;
    if (emaSide === r.winner.toUpperCase()) {
      winsWithFilter++;
    }
  }
}

console.log('📈 PURE EMA STRATEGY (No filter):');
console.log(`  Trades: ${tradesNoFilter}`);
console.log(`  Wins: ${winsNoFilter}`);
console.log(`  Losses: ${tradesNoFilter - winsNoFilter}`);
console.log(`  Win Rate: ${tradesNoFilter > 0 ? ((winsNoFilter / tradesNoFilter) * 100).toFixed(2) : 0}%\n`);

console.log('📈 EMA + PAYOUT ≥1.45x (Contrarian):');
console.log(`  Trades: ${tradesWithFilter}`);
console.log(`  Wins: ${winsWithFilter}`);
console.log(`  Losses: ${tradesWithFilter - winsWithFilter}`);
console.log(`  Win Rate: ${tradesWithFilter > 0 ? ((winsWithFilter / tradesWithFilter) * 100).toFixed(2) : 0}%\n`);

console.log('═'.repeat(80) + '\n');

// Show time range
const firstRound = new Date(recentRounds[0].lock_timestamp * 1000);
const lastRound = new Date(recentRounds[recentRounds.length - 1].lock_timestamp * 1000);

console.log(`📅 Time Range:`);
console.log(`  From: ${firstRound.toISOString()}`);
console.log(`  To:   ${lastRound.toISOString()}\n`);

console.log('═'.repeat(80) + '\n');

db.close();
