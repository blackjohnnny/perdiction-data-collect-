import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'fs';

console.log('═══════════════════════════════════════════════════════════');
console.log('CLEANING live.db - REMOVING ROUNDS WITHOUT T-20s DATA');
console.log('═══════════════════════════════════════════════════════════\n');

const SQL = await initSqlJs();
const liveBuf = readFileSync('./data/live.db');
const liveDb = new SQL.Database(liveBuf);

// Count before
const beforeTotal = liveDb.exec('SELECT COUNT(*) FROM rounds')[0].values[0][0];
const beforeT20s = liveDb.exec('SELECT COUNT(*) FROM rounds WHERE t20s_total_wei IS NOT NULL AND t20s_total_wei != "0"')[0].values[0][0];

console.log(`Before cleanup:`);
console.log(`  Total rounds: ${beforeTotal}`);
console.log(`  With T-20s: ${beforeT20s}`);
console.log(`  WITHOUT T-20s: ${beforeTotal - beforeT20s}\n`);

// Delete rounds without T-20s data
liveDb.run('DELETE FROM rounds WHERE t20s_total_wei IS NULL OR t20s_total_wei = "0"');

// Count after
const afterTotal = liveDb.exec('SELECT COUNT(*) FROM rounds')[0].values[0][0];
const afterT20s = liveDb.exec('SELECT COUNT(*) FROM rounds WHERE t20s_total_wei IS NOT NULL AND t20s_total_wei != "0"')[0].values[0][0];

console.log(`After cleanup:`);
console.log(`  Total rounds: ${afterTotal}`);
console.log(`  With T-20s: ${afterT20s}`);
console.log(`  Removed: ${beforeTotal - afterTotal} rounds\n`);

// Save cleaned database
const data = liveDb.export();
writeFileSync('./data/live.db', data);

console.log('✅ live.db cleaned - ONLY rounds with T-20s data remain\n');

// Show range
const range = liveDb.exec('SELECT MIN(epoch), MAX(epoch) FROM rounds')[0].values[0];
console.log(`Epoch range: ${range[0]} to ${range[1]}`);

liveDb.close();
