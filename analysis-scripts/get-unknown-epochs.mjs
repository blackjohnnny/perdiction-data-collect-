import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('=== Finding UNKNOWN Rounds ===\n');

const stmt = db.prepare(`
  SELECT epoch, MIN(epoch) as min_epoch, MAX(epoch) as max_epoch, COUNT(*) as count
  FROM rounds
  WHERE winner = 'UNKNOWN'
`);

stmt.step();
const result = stmt.getAsObject();
stmt.free();

console.log(`UNKNOWN rounds: ${result.count}`);
console.log(`Epoch range: ${result.min_epoch} to ${result.max_epoch}\n`);

db.close();
