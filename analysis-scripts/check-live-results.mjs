import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('=== Live Monitor Results ===\n');

// Total rounds
const totalStmt = db.prepare('SELECT COUNT(*) as count FROM rounds');
totalStmt.step();
const total = totalStmt.getAsObject().count;
totalStmt.free();

console.log(`Total rounds: ${total}\n`);

// Breakdown by winner
console.log('Results by winner:');
const winnerStmt = db.prepare(`
  SELECT winner, COUNT(*) as count
  FROM rounds
  GROUP BY winner
  ORDER BY winner
`);

let withResults = 0;
let unknown = 0;

while (winnerStmt.step()) {
  const row = winnerStmt.getAsObject();
  console.log(`  ${row.winner}: ${row.count} rounds`);

  if (row.winner === 'UP' || row.winner === 'DOWN') {
    withResults += row.count;
  } else {
    unknown += row.count;
  }
}
winnerStmt.free();

console.log('\n=== Summary ===\n');
console.log(`✅ Rounds with known results (UP or DOWN): ${withResults}`);
console.log(`⏳ Rounds still UNKNOWN: ${unknown}`);
console.log(`📊 Percentage with results: ${((withResults / total) * 100).toFixed(1)}%`);

db.close();
