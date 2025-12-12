import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🧹 DATABASE CLEANUP\n');
console.log('═'.repeat(60) + '\n');

const db = initDatabase(DB_PATH);

// Check what we have before cleanup
const before = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN t20s_timestamp IS NOT NULL AND winner IS NOT NULL THEN 1 ELSE 0 END) as complete,
    SUM(CASE WHEN t20s_timestamp IS NULL OR winner IS NULL THEN 1 ELSE 0 END) as incomplete
  FROM rounds
`).get();

console.log('📊 BEFORE CLEANUP:');
console.log(`  Total rounds: ${before.total}`);
console.log(`  Complete (T-20s + Winner): ${before.complete}`);
console.log(`  Incomplete (missing data): ${before.incomplete}`);
console.log('\n' + '─'.repeat(60) + '\n');

// Delete incomplete rounds
console.log('🗑️  REMOVING INCOMPLETE ROUNDS...\n');

const result = db.prepare(`
  DELETE FROM rounds
  WHERE t20s_timestamp IS NULL OR winner IS NULL
`).run();

console.log(`  Deleted ${result.changes} incomplete rounds\n`);
console.log('─'.repeat(60) + '\n');

// Check what we have after cleanup
const after = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN t20s_timestamp IS NOT NULL AND winner IS NOT NULL THEN 1 ELSE 0 END) as complete
  FROM rounds
`).get();

console.log('📊 AFTER CLEANUP:');
console.log(`  Total rounds: ${after.total}`);
console.log(`  Complete (T-20s + Winner): ${after.complete}`);
console.log('\n' + '═'.repeat(60) + '\n');

if (after.total === after.complete) {
  console.log('✅ Database cleaned! All rounds have T-20s data + winner results.\n');
} else {
  console.log('⚠️  Warning: Some incomplete rounds still exist.\n');
}

db.close();
