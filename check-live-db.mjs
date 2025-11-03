import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

const total = db.exec('SELECT COUNT(*) as count FROM rounds')[0]?.values[0][0];
console.log('Total rounds in live.db:', total);

const withT20s = db.exec('SELECT COUNT(*) as count FROM rounds WHERE t20s_total_wei != "0"')[0]?.values[0][0];
console.log('Rounds with T-20s data:', withT20s);

const latestResult = db.exec('SELECT epoch FROM rounds ORDER BY epoch DESC LIMIT 1')[0];
if (latestResult) {
  const latest = { epoch: latestResult.values[0][0] };
  console.log('Latest epoch:', latest.epoch);
}

const oldestResult = db.exec('SELECT epoch FROM rounds ORDER BY epoch ASC LIMIT 1')[0];
if (oldestResult) {
  const oldest = { epoch: oldestResult.values[0][0] };
  console.log('Oldest epoch:', oldest.epoch);
}

db.close();
