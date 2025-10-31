import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

const stmt = db.prepare('SELECT COUNT(*) as count FROM rounds');
stmt.step();
const count = stmt.getAsObject().count;
stmt.free();

console.log(`\n🔢 TOTAL ROUNDS: ${count}\n`);

db.close();
