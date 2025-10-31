import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('=== UNKNOWN Rounds ===\n');

const stmt = db.prepare(`
  SELECT epoch
  FROM rounds
  WHERE winner = 'UNKNOWN'
  ORDER BY epoch
`);

const unknowns = [];
while (stmt.step()) {
  unknowns.push(stmt.getAsObject().epoch);
}
stmt.free();

console.log(`Total UNKNOWN: ${unknowns.length}\n`);

if (unknowns.length > 0) {
  console.log(`First UNKNOWN: ${unknowns[0]}`);
  console.log(`Last UNKNOWN: ${unknowns[unknowns.length - 1]}`);

  console.log('\nAll UNKNOWN epochs:');
  unknowns.forEach(e => console.log(`  ${e}`));
}

db.close();
