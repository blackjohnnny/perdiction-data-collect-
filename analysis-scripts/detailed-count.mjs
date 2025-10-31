import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('=== Detailed Round Count Analysis ===\n');

// Total rounds
const totalStmt = db.prepare('SELECT COUNT(*) as count FROM rounds');
totalStmt.step();
const total = totalStmt.getAsObject().count;
totalStmt.free();

console.log(`Total rounds in database: ${total}\n`);

// Breakdown by winner status
console.log('Breakdown by winner status:');
const winnerStmt = db.prepare(`
  SELECT winner, COUNT(*) as count
  FROM rounds
  GROUP BY winner
  ORDER BY winner
`);

while (winnerStmt.step()) {
  const row = winnerStmt.getAsObject();
  console.log(`  ${row.winner}: ${row.count}`);
}
winnerStmt.free();

// Show epoch ranges
console.log('\nEpoch ranges:');
const rangeStmt = db.prepare('SELECT MIN(epoch) as min, MAX(epoch) as max FROM rounds');
rangeStmt.step();
const range = rangeStmt.getAsObject();
rangeStmt.free();

console.log(`  Oldest: ${range.min}`);
console.log(`  Latest: ${range.max}`);
console.log(`  Range: ${range.max - range.min + 1} epochs if consecutive`);
console.log(`  Actual: ${total} rounds (gap of ${range.max - range.min + 1 - total} epochs)`);

// Show before and after backfill
console.log('\n=== Epoch Distribution ===\n');

const beforeStmt = db.prepare('SELECT COUNT(*) as count FROM rounds WHERE epoch < 425681');
beforeStmt.step();
const before = beforeStmt.getAsObject().count;
beforeStmt.free();

const gapStmt = db.prepare('SELECT COUNT(*) as count FROM rounds WHERE epoch >= 425681 AND epoch <= 425761');
gapStmt.step();
const gap = gapStmt.getAsObject().count;
gapStmt.free();

const afterStmt = db.prepare('SELECT COUNT(*) as count FROM rounds WHERE epoch > 425761');
afterStmt.step();
const after = afterStmt.getAsObject().count;
afterStmt.free();

console.log(`Before 425681: ${before} rounds`);
console.log(`Gap (425681-425761): ${gap} rounds (should be 81)`);
console.log(`After 425761: ${after} rounds`);
console.log(`\nTotal: ${before} + ${gap} + ${after} = ${before + gap + after}`);

db.close();
