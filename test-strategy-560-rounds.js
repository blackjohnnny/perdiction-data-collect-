import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';

console.log('\n🧪 TESTING STRATEGY ON 560 BNB ROUNDS\n');
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
    winner_payout_multiple
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
  ORDER BY sample_id ASC
`).all();

console.log(`📊 Found ${rounds.length} complete rounds\n`);
console.log('─'.repeat(80) + '\n');

// Fetch BNB/USDT EMA from TradingView (using public API endpoint)
async function getTradingViewEMA(timestamp) {
  try {
    // TradingView doesn't have a public API for historical data
    // We'll use Binance API as it matches TradingView's BNB/USDT chart
    const endTime = timestamp * 1000;
    const startTime = endTime - (7 * 5 * 60 * 1000); // 7 candles × 5 minutes

    const url = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=7`;
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const candles = await response.json();

    if (!Array.isArray(candles) || candles.length < 7) {
      return null;
    }

    // Calculate EMA3 and EMA7 from closes
    const closes = candles.map(c => parseFloat(c[4]));
    const ema3 = closes.slice(-3).reduce((a, b) => a + b) / 3;
    const ema7 = closes.reduce((a, b) => a + b) / 7;
    const gap = ((ema3 - ema7) / ema7) * 100;

    // Signal: BULL if gap > 0.05%, BEAR if gap < -0.05%, else NEUTRAL
    const signal = gap > 0.05 ? 'BULL' : gap < -0.05 ? 'BEAR' : 'NEUTRAL';

    return {
      signal,
      gap: gap.toFixed(3),
      ema3: ema3.toFixed(2),
      ema7: ema7.toFixed(2),
      timestamp,
      candles: closes
    };

  } catch (err) {
    console.error(`   ❌ Error fetching EMA for timestamp ${timestamp}: ${err.message}`);
    return null;
  }
}

// Store EMA data in database (add column if needed)
console.log('📝 Adding EMA storage to database...\n');

try {
  db.prepare(`
    ALTER TABLE rounds ADD COLUMN ema_signal TEXT
  `).run();
  console.log('  ✅ Added ema_signal column\n');
} catch (err) {
  if (err.message.includes('duplicate column')) {
    console.log('  ℹ️  ema_signal column already exists\n');
  } else {
    console.log(`  ⚠️  Column add warning: ${err.message}\n`);
  }
}

try {
  db.prepare(`
    ALTER TABLE rounds ADD COLUMN ema_gap REAL
  `).run();
  console.log('  ✅ Added ema_gap column\n');
} catch (err) {
  if (err.message.includes('duplicate column')) {
    console.log('  ℹ️  ema_gap column already exists\n');
  } else {
    console.log(`  ⚠️  Column add warning: ${err.message}\n`);
  }
}

try {
  db.prepare(`
    ALTER TABLE rounds ADD COLUMN ema3 REAL
  `).run();
  console.log('  ✅ Added ema3 column\n');
} catch (err) {
  if (err.message.includes('duplicate column')) {
    console.log('  ℹ️  ema3 column already exists\n');
  } else {
    console.log(`  ⚠️  Column add warning: ${err.message}\n`);
  }
}

try {
  db.prepare(`
    ALTER TABLE rounds ADD COLUMN ema7 REAL
  `).run();
  console.log('  ✅ Added ema7 column\n');
} catch (err) {
  if (err.message.includes('duplicate column')) {
    console.log('  ℹ️  ema7 column already exists\n');
  } else {
    console.log(`  ⚠️  Column add warning: ${err.message}\n`);
  }
}

console.log('─'.repeat(80) + '\n');

// Test ORIGINAL strategy: Bet WITH crowd when EMA confirms
console.log('🎯 TESTING ORIGINAL STRATEGY (Bet WITH Crowd ≥65% + EMA Confirmation):\n');

let totalTrades = 0;
let wins = 0;
let losses = 0;
let totalProfit = 0;
let skippedNoEMA = 0;
let skippedNoCrowd = 0;
let skippedNoConfirm = 0;

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];

  if (i % 50 === 0) {
    console.log(`Processing round ${i + 1}/${rounds.length}...`);
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

  // Fetch EMA signal
  const emaData = await getTradingViewEMA(r.lock_timestamp);

  if (!emaData) {
    skippedNoEMA++;
    continue;
  }

  // Store EMA in database
  db.prepare(`
    UPDATE rounds
    SET ema_signal = ?, ema_gap = ?, ema3 = ?, ema7 = ?
    WHERE sample_id = ?
  `).run(emaData.signal, parseFloat(emaData.gap), parseFloat(emaData.ema3), parseFloat(emaData.ema7), r.sample_id);

  // ORIGINAL STRATEGY: Bet WITH crowd when EMA confirms
  let betSide = null;
  if (crowdSide === 'BULL' && emaData.signal === 'BULL') {
    betSide = 'BULL';
  } else if (crowdSide === 'BEAR' && emaData.signal === 'BEAR') {
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

  // Rate limit
  await new Promise(resolve => setTimeout(resolve, 100));
}

console.log('\n' + '═'.repeat(80) + '\n');
console.log('📊 FINAL RESULTS:\n');
console.log(`  Total rounds: ${rounds.length}`);
console.log(`  Skipped (no crowd ≥65%): ${skippedNoCrowd}`);
console.log(`  Skipped (no EMA data): ${skippedNoEMA}`);
console.log(`  Skipped (EMA ≠ crowd): ${skippedNoConfirm}`);
console.log(`  Total trades: ${totalTrades}`);
console.log(`  Wins: ${wins} (${totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : 0}%)`);
console.log(`  Losses: ${losses}`);
console.log(`  Total profit: ${totalProfit.toFixed(2)} units`);
console.log(`  ROI: ${totalTrades > 0 ? ((totalProfit / totalTrades) * 100).toFixed(2) : 0}%`);
console.log('\n' + '═'.repeat(80) + '\n');

db.close();
