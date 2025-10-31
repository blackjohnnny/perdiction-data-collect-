import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

// Check a specific epoch
const testEpoch = 424496;

console.log(`Testing epoch ${testEpoch}:\n`);

// Check if snapshot exists
const snapQuery = `SELECT * FROM snapshots WHERE epoch = ${testEpoch}`;
const stmt1 = db.prepare(snapQuery);
console.log('Snapshots:');
while (stmt1.step()) {
  console.log(stmt1.getAsObject());
}
stmt1.free();

// Check if round result exists
const roundQuery = `SELECT * FROM rounds WHERE epoch = ${testEpoch}`;
const stmt2 = db.prepare(roundQuery);
console.log('\nRound data:');
if (stmt2.step()) {
  console.log(stmt2.getAsObject());
} else {
  console.log('NO ROUND DATA FOUND');
}
stmt2.free();

db.close();
