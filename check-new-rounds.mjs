import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

const total = db.exec('SELECT COUNT(*) as count FROM rounds')[0]?.values[0][0];
console.log('Total rounds:', total);

const withT20s = db.exec('SELECT COUNT(*) as count FROM rounds WHERE t20s_taken_at IS NOT NULL')[0]?.values[0][0];
console.log('Rounds with T-20s:', withT20s);

const latestResult = db.exec('SELECT epoch FROM rounds ORDER BY epoch DESC LIMIT 1')[0];
if (latestResult) {
  const latest = { epoch: latestResult.values[0][0] };
  console.log('Latest epoch:', latest.epoch);
}

// Check when monitoring started (around epoch 425908 based on previous session)
const newRounds = db.exec('SELECT COUNT(*) as count FROM rounds WHERE epoch >= 425908')[0]?.values[0][0];
console.log('\nNew rounds since monitoring started (epoch 425908+):', newRounds);

const newWithT20s = db.exec('SELECT COUNT(*) as count FROM rounds WHERE epoch >= 425908 AND t20s_taken_at IS NOT NULL')[0]?.values[0][0];
console.log('New rounds with T-20s data:', newWithT20s);

db.close();
