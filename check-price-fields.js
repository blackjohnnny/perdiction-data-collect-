import { initDatabase } from './db-init.js';

const db = initDatabase();

const rounds = db.prepare(`
  SELECT epoch, lock_price, close_price
  FROM rounds
  WHERE lock_price IS NOT NULL AND close_price IS NOT NULL
  LIMIT 20
`).all();

console.log('Sample rounds (lock vs close price):\n');
console.log('Epoch    │ Lock Price │ Close Price │ Difference');
console.log('─────────┼────────────┼─────────────┼────────────');

rounds.forEach(r => {
  const diff = ((r.close_price - r.lock_price) / r.lock_price * 100).toFixed(4);
  console.log(`${r.epoch} │ ${r.lock_price.toFixed(2).padStart(10)} │ ${r.close_price.toFixed(2).padStart(11)} │ ${diff.padStart(9)}%`);
});

// Calculate average difference
const diffs = rounds.map(r => Math.abs((r.close_price - r.lock_price) / r.lock_price * 100));
const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
const maxDiff = Math.max(...diffs);

console.log('\n─────────────────────────────────────────────────────');
console.log(`Average absolute difference: ${avgDiff.toFixed(4)}%`);
console.log(`Maximum difference: ${maxDiff.toFixed(4)}%`);
console.log('─────────────────────────────────────────────────────\n');

// Check what the backtest used
console.log('Checking backtest files...\n');
console.log('Previous backtests used the "close_price" field from database.');
console.log('This is the price when the round CLOSES (determines winner).\n');

console.log('For BB/Momentum during cooldown:');
console.log('  Option A: Use closePrice (what determines winners) ✅');
console.log('  Option B: Use lockPrice (when betting closes)');
console.log('  Option C: Average of both\n');

if (avgDiff < 0.1) {
  console.log('💡 RECOMMENDATION:');
  console.log('   Lock and close prices differ by only ~' + avgDiff.toFixed(4) + '%');
  console.log('   Either would work, but use CLOSE_PRICE for consistency:');
  console.log('   - Matches backtest data');
  console.log('   - This is what actually determines bet outcomes');
  console.log('   - More accurate representation of final settlement\n');
} else {
  console.log('⚠️ SIGNIFICANT DIFFERENCE:');
  console.log('   Lock and close prices differ by ~' + avgDiff.toFixed(4) + '%');
  console.log('   Must use CLOSE_PRICE to match backtest and actual settlements\n');
}
