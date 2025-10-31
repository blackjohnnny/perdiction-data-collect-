import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('   VERIFY: WHAT IS "CROWD"?');
console.log('═══════════════════════════════════════════════════════════════\n');

// Get sample rounds
const query = `
  SELECT
    r.epoch,
    r.winner,
    s.bull_amount_wei,
    s.bear_amount_wei,
    s.total_amount_wei,
    s.implied_up_multiple,
    s.implied_down_multiple
  FROM rounds r
  JOIN snapshots s ON r.epoch = s.epoch
  WHERE r.winner IN ('UP', 'DOWN')
    AND s.snapshot_type = 'T_MINUS_20S'
  ORDER BY r.epoch ASC
  LIMIT 10
`;

const stmt = db.prepare(query);

console.log('Sample T-20s data:\n');
console.log('Epoch | Bull BNB | Bear BNB | Up Payout | Down Payout | Winner');
console.log('─'.repeat(70));

while (stmt.step()) {
  const row = stmt.getAsObject();
  const bullBNB = (Number(BigInt(row.bull_amount_wei)) / 1e18).toFixed(2);
  const bearBNB = (Number(BigInt(row.bear_amount_wei)) / 1e18).toFixed(2);
  const totalBNB = (Number(BigInt(row.total_amount_wei)) / 1e18).toFixed(2);

  const bullPct = (Number(BigInt(row.bull_amount_wei) * 10000n / BigInt(row.total_amount_wei)) / 100).toFixed(1);
  const bearPct = (Number(BigInt(row.bear_amount_wei) * 10000n / BigInt(row.total_amount_wei)) / 100).toFixed(1);

  const moreMoney = BigInt(row.bull_amount_wei) > BigInt(row.bear_amount_wei) ? 'BULL (UP)' : 'BEAR (DOWN)';
  const lowerPayout = row.implied_up_multiple < row.implied_down_multiple ? 'UP' : 'DOWN';

  console.log(`${row.epoch} | ${bullBNB} (${bullPct}%) | ${bearBNB} (${bearPct}%) | ${row.implied_up_multiple.toFixed(2)}x | ${row.implied_down_multiple.toFixed(2)}x | ${row.winner}`);
  console.log(`         More money in: ${moreMoney}, Lower payout: ${lowerPayout}`);
}

stmt.free();
db.close();

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('DEFINITION CHECK:');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('Question: What is "crowd"?');
console.log('');
console.log('Option A: Side with MORE money = crowd (lower payout)');
console.log('  - Makes sense: More people betting = crowd');
console.log('  - Bull has more money → UP is crowd');
console.log('  - This side has LOWER payout (e.g., 1.2x)');
console.log('');
console.log('Option B: Side with LESS money = crowd (higher payout)');
console.log('  - Unlikely: This is the underdog');
console.log('');
console.log('✅ CONCLUSION: Crowd = side with MORE money (LOWER payout)');
console.log('   This is also called the "favorite"');
console.log('');
console.log('My simulation used: More bull_amount → UP is crowd ✓ CORRECT');
console.log('\n═══════════════════════════════════════════════════════════════\n');
