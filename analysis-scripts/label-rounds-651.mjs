import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'fs';

console.log('=== Labeling All 651 Rounds with Sequential Numbers ===\n');

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

// Check current table structure
const tableInfoStmt = db.prepare("PRAGMA table_info(rounds)");
const columns = [];
while (tableInfoStmt.step()) {
  columns.push(tableInfoStmt.getAsObject().name);
}
tableInfoStmt.free();

console.log('Checking for round_number column...');

if (!columns.includes('round_number')) {
  console.log('Adding round_number column...');
  db.exec('ALTER TABLE rounds ADD COLUMN round_number INTEGER');
  console.log('✅ Column added\n');
} else {
  console.log('✅ Column already exists\n');
}

// Get all epochs sorted
console.log('Getting all rounds sorted by epoch...');
const epochsStmt = db.prepare('SELECT epoch FROM rounds ORDER BY epoch');
const epochs = [];
while (epochsStmt.step()) {
  epochs.push(epochsStmt.getAsObject().epoch);
}
epochsStmt.free();

console.log(`Found ${epochs.length} rounds\n`);

// Update each with sequential number
console.log('Assigning sequential numbers...');
const updateStmt = db.prepare('UPDATE rounds SET round_number = ? WHERE epoch = ?');

epochs.forEach((epoch, index) => {
  const roundNumber = index + 1;
  updateStmt.bind([roundNumber, epoch]);
  updateStmt.step();
  updateStmt.reset();

  if ((index + 1) % 100 === 0) {
    console.log(`  Labeled ${index + 1} rounds...`);
  }
});

updateStmt.free();

console.log(`✅ All ${epochs.length} rounds labeled (1 to ${epochs.length})\n`);

// Save to a NEW file to avoid conflicts with live monitoring
console.log('Saving to data/live-monitor-labeled.db...');
const data = db.export();
writeFileSync('./data/live-monitor-labeled.db', Buffer.from(data));
console.log('✅ Saved\n');

// Verify
console.log('=== Verification ===\n');
const verifyStmt = db.prepare('SELECT MIN(round_number) as min, MAX(round_number) as max, COUNT(*) as total FROM rounds');
verifyStmt.step();
const verify = verifyStmt.getAsObject();
verifyStmt.free();

console.log(`Total rounds: ${verify.total}`);
console.log(`Round numbers: #${verify.min} to #${verify.max}\n`);

// Show samples
console.log('First 5 rounds:');
const firstStmt = db.prepare('SELECT round_number, epoch FROM rounds ORDER BY round_number LIMIT 5');
while (firstStmt.step()) {
  const row = firstStmt.getAsObject();
  console.log(`  Round #${row.round_number}: Epoch ${row.epoch}`);
}
firstStmt.free();

console.log('\nLast 5 rounds:');
const lastStmt = db.prepare('SELECT round_number, epoch FROM rounds ORDER BY round_number DESC LIMIT 5');
while (lastStmt.step()) {
  const row = lastStmt.getAsObject();
  console.log(`  Round #${row.round_number}: Epoch ${row.epoch}`);
}
lastStmt.free();

db.close();

console.log('\n✅ Complete!');
console.log('\n📌 Database saved as: data/live-monitor-labeled.db');
console.log('   (Original live-monitor.db unchanged for live monitoring)');
