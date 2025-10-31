import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

// Get min and max epochs
const rangeStmt = db.prepare('SELECT MIN(epoch) as min, MAX(epoch) as max FROM rounds');
rangeStmt.step();
const range = rangeStmt.getAsObject();
rangeStmt.free();

console.log(`Database range: ${range.min} to ${range.max}\n`);

// Get all epochs
const epochsStmt = db.prepare('SELECT epoch FROM rounds ORDER BY epoch');
const epochs = [];
while (epochsStmt.step()) {
  epochs.push(epochsStmt.getAsObject().epoch);
}
epochsStmt.free();

// Find gaps
const gaps = [];
for (let i = 0; i < epochs.length - 1; i++) {
  const current = epochs[i];
  const next = epochs[i + 1];
  if (next - current > 1) {
    gaps.push({
      start: current + 1,
      end: next - 1,
      count: next - current - 1
    });
  }
}

if (gaps.length === 0) {
  console.log('✅ No gaps found - all epochs are consecutive!');
} else {
  console.log(`Found ${gaps.length} gap(s):\n`);
  gaps.forEach((gap, i) => {
    console.log(`Gap ${i + 1}: ${gap.start} to ${gap.end} (${gap.count} missing epochs)`);
  });

  const totalMissing = gaps.reduce((sum, gap) => sum + gap.count, 0);
  console.log(`\nTotal missing epochs: ${totalMissing}`);
}

db.close();
