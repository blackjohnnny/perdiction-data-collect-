import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'fs';

console.log('=== Adding Sequential Round Numbers ===\n');

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

// First, check if the column already exists
const tableInfoStmt = db.prepare("PRAGMA table_info(rounds)");
const columns = [];
while (tableInfoStmt.step()) {
  columns.push(tableInfoStmt.getAsObject().name);
}
tableInfoStmt.free();

console.log('Current columns in rounds table:', columns.join(', '));

if (columns.includes('round_number')) {
  console.log('\n⚠️  round_number column already exists');
} else {
  console.log('\nAdding round_number column...');
  db.exec('ALTER TABLE rounds ADD COLUMN round_number INTEGER');
  console.log('✅ Column added');
}

// Get all epochs sorted
console.log('\nAssigning round numbers (sorted by epoch)...');
const epochsStmt = db.prepare('SELECT epoch FROM rounds ORDER BY epoch');
const epochs = [];
while (epochsStmt.step()) {
  epochs.push(epochsStmt.getAsObject().epoch);
}
epochsStmt.free();

console.log(`Found ${epochs.length} rounds to number\n`);

// Update each round with sequential number
const updateStmt = db.prepare('UPDATE rounds SET round_number = ? WHERE epoch = ?');

epochs.forEach((epoch, index) => {
  const roundNumber = index + 1;
  updateStmt.bind([roundNumber, epoch]);
  updateStmt.step();
  updateStmt.reset();

  if ((index + 1) % 100 === 0) {
    console.log(`  Numbered ${index + 1} rounds...`);
  }
});

updateStmt.free();

console.log(`✅ All ${epochs.length} rounds numbered\n`);

// Save database
console.log('Saving database...');
const data = db.export();
writeFileSync('./data/live-monitor.db', Buffer.from(data));
console.log('✅ Database saved\n');

// Show sample
console.log('=== Sample: First 10 Rounds ===\n');
const sampleStmt = db.prepare('SELECT round_number, epoch FROM rounds ORDER BY round_number LIMIT 10');

while (sampleStmt.step()) {
  const row = sampleStmt.getAsObject();
  console.log(`Round #${row.round_number}: Epoch ${row.epoch}`);
}
sampleStmt.free();

// Show summary
const summaryStmt = db.prepare('SELECT MIN(round_number) as min, MAX(round_number) as max, COUNT(*) as total FROM rounds');
summaryStmt.step();
const summary = summaryStmt.getAsObject();
summaryStmt.free();

console.log('\n=== Summary ===\n');
console.log(`Total rounds: ${summary.total}`);
console.log(`Round numbers: #${summary.min} to #${summary.max}`);

db.close();

console.log('\n✅ Round numbering complete!');
