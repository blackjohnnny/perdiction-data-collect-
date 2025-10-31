import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

// Get table names
const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
console.log('Tables:', tables[0].values);

// Get schema for rounds table
const schema = db.exec("PRAGMA table_info(rounds)");
console.log('\nRounds table columns:');
for (const col of schema[0].values) {
  console.log(`  ${col[1]} (${col[2]})`);
}

db.close();
