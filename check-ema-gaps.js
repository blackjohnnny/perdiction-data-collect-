import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

const db = initDatabase(DB_PATH);

// Get EMA gap statistics
const stats = db.prepare(`
  SELECT
    MIN(ema_gap) as min_gap,
    MAX(ema_gap) as max_gap,
    AVG(ema_gap) as avg_gap,
    COUNT(*) as total_rounds,
    COUNT(CASE WHEN ema_gap IS NOT NULL THEN 1 END) as with_ema,
    COUNT(CASE WHEN ema_gap IS NULL THEN 1 END) as without_ema
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
`).get();

console.log('\n📊 EMA Gap Statistics:\n');
console.log(`  Total rounds: ${stats.total_rounds}`);
console.log(`  Rounds with EMA: ${stats.with_ema}`);
console.log(`  Rounds without EMA: ${stats.without_ema}`);
console.log(`  Min gap: ${stats.min_gap !== null ? stats.min_gap.toFixed(3) : 'N/A'}%`);
console.log(`  Max gap: ${stats.max_gap !== null ? stats.max_gap.toFixed(3) : 'N/A'}%`);
console.log(`  Avg gap: ${stats.avg_gap !== null ? stats.avg_gap.toFixed(3) : 'N/A'}%\n`);

// Get distribution of EMA gaps
const distribution = db.prepare(`
  SELECT
    COUNT(CASE WHEN ABS(ema_gap) < 0.01 THEN 1 END) as gap_0_01,
    COUNT(CASE WHEN ABS(ema_gap) >= 0.01 AND ABS(ema_gap) < 0.03 THEN 1 END) as gap_01_03,
    COUNT(CASE WHEN ABS(ema_gap) >= 0.03 AND ABS(ema_gap) < 0.05 THEN 1 END) as gap_03_05,
    COUNT(CASE WHEN ABS(ema_gap) >= 0.05 THEN 1 END) as gap_05_plus
  FROM rounds
  WHERE ema_gap IS NOT NULL
`).get();

console.log('📈 EMA Gap Distribution:\n');
console.log(`  Gap < 0.01%: ${distribution.gap_0_01} rounds`);
console.log(`  Gap 0.01-0.03%: ${distribution.gap_01_03} rounds`);
console.log(`  Gap 0.03-0.05%: ${distribution.gap_03_05} rounds`);
console.log(`  Gap ≥ 0.05%: ${distribution.gap_05_plus} rounds\n`);

// Sample some actual EMA gaps
const samples = db.prepare(`
  SELECT sample_id, epoch, ema_gap, ema_signal, winner
  FROM rounds
  WHERE ema_gap IS NOT NULL
  ORDER BY sample_id ASC
  LIMIT 20
`).all();

console.log('📋 Sample EMA Gaps (first 20 rounds):\n');
samples.forEach(s => {
  console.log(`  Epoch ${s.epoch}: gap=${s.ema_gap}%, signal=${s.ema_signal}, winner=${s.winner}`);
});

db.close();
