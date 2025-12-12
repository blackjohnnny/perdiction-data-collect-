import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';

console.log('\n📊 BACKFILLING EMA DATA FOR MISSING ROUNDS\n');
console.log('═'.repeat(80) + '\n');

const db = initDatabase(DB_PATH);

// Get rounds missing EMA data
const missingEMA = db.prepare(`
  SELECT
    sample_id,
    epoch,
    lock_timestamp,
    winner
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND (ema_signal IS NULL OR ema_gap IS NULL)
  ORDER BY sample_id ASC
`).all();

console.log(`📌 Found ${missingEMA.length} rounds missing EMA data\n`);

if (missingEMA.length === 0) {
  console.log('✅ All rounds already have EMA data!\n');
  db.close();
  process.exit(0);
}

// Fetch BNB/USDT EMA from Binance API
async function getTradingViewEMA(timestamp) {
  try {
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
      gap: parseFloat(gap.toFixed(3)),
      ema3: parseFloat(ema3.toFixed(2)),
      ema7: parseFloat(ema7.toFixed(2)),
      closes // Store raw closes for future recalculation
    };

  } catch (err) {
    console.error(`   ❌ Error fetching EMA for timestamp ${timestamp}: ${err.message}`);
    return null;
  }
}

console.log('🔄 Starting backfill...\n');

let successCount = 0;
let failCount = 0;

for (let i = 0; i < missingEMA.length; i++) {
  const r = missingEMA[i];

  if (i % 50 === 0) {
    console.log(`Processing round ${i + 1}/${missingEMA.length}... (${successCount} success, ${failCount} fail)`);
  }

  // Fetch EMA data
  const emaData = await getTradingViewEMA(r.lock_timestamp);

  if (!emaData) {
    failCount++;
    continue;
  }

  // Store EMA in database
  try {
    db.prepare(`
      UPDATE rounds
      SET ema_signal = ?, ema_gap = ?, ema3 = ?, ema7 = ?
      WHERE sample_id = ?
    `).run(emaData.signal, emaData.gap, emaData.ema3, emaData.ema7, r.sample_id);

    successCount++;
  } catch (err) {
    console.error(`   ❌ Error updating round ${r.sample_id}: ${err.message}`);
    failCount++;
  }

  // Rate limit - 100ms delay between requests
  await new Promise(resolve => setTimeout(resolve, 100));
}

console.log('\n' + '═'.repeat(80) + '\n');
console.log('📊 BACKFILL COMPLETE:\n');
console.log(`  Total rounds processed: ${missingEMA.length}`);
console.log(`  Successfully updated: ${successCount}`);
console.log(`  Failed: ${failCount}`);
console.log('\n' + '═'.repeat(80) + '\n');

// Verify current state
const stats = db.prepare(`
  SELECT
    COUNT(*) as total,
    COUNT(CASE WHEN ema_signal IS NOT NULL THEN 1 END) as with_ema,
    COUNT(CASE WHEN ema_signal IS NULL THEN 1 END) as without_ema
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL
`).get();

console.log('📈 CURRENT DATABASE STATE:\n');
console.log(`  Total complete rounds: ${stats.total}`);
console.log(`  Rounds with EMA: ${stats.with_ema} (${((stats.with_ema / stats.total) * 100).toFixed(1)}%)`);
console.log(`  Rounds without EMA: ${stats.without_ema}\n`);

db.close();
