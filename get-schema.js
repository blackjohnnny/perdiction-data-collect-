import Database from 'better-sqlite3';
const db = new Database('./prediction.db');

const schema = db.prepare("PRAGMA table_info(rounds)").all();
console.log('📊 ROUNDS TABLE SCHEMA:\n');
schema.forEach(col => {
  console.log(`${col.name} (${col.type})`);
});

db.close();
