import initSqlJs from 'sql.js';
import fs from 'fs';

const sqlJs = await initSqlJs();
const buf = fs.readFileSync('../data/live-monitor.db');
const db = new sqlJs.Database(buf);

// Get all rounds with at least one snapshot
const result = db.exec(`
  SELECT
    epoch,
    lock_ts,
    winner,
    winner_multiple,
    -- T-20s data
    t20s_bull_wei,
    t20s_bear_wei,
    t20s_total_wei,
    t20s_implied_up_multiple,
    t20s_implied_down_multiple,
    -- T-8s data
    t8s_bull_wei,
    t8s_bear_wei,
    t8s_total_wei,
    t8s_implied_up_multiple,
    t8s_implied_down_multiple,
    -- T-4s data
    t4s_bull_wei,
    t4s_bear_wei,
    t4s_total_wei,
    t4s_implied_up_multiple,
    t4s_implied_down_multiple,
    -- Final amounts
    bull_amount_wei,
    bear_amount_wei,
    total_amount_wei
  FROM rounds
  WHERE t20s_total_wei IS NOT NULL
     OR t8s_total_wei IS NOT NULL
     OR t4s_total_wei IS NOT NULL
  ORDER BY epoch
`);

if (result.length === 0) {
  console.log('No data found');
  process.exit(0);
}

const columns = result[0].columns;
const rows = result[0].values;

console.log(`Exporting ${rows.length} rounds to CSV...`);

// Create CSV header
const csvLines = [];
csvLines.push(columns.join(','));

// Add data rows
rows.forEach(row => {
  const csvRow = row.map(cell => {
    if (cell === null) return '';
    if (typeof cell === 'string' && cell.includes(',')) return `"${cell}"`;
    return cell;
  });
  csvLines.push(csvRow.join(','));
});

const csv = csvLines.join('\n');
fs.writeFileSync('../data/live-monitor-data.csv', csv);

console.log('✅ Exported to: live-monitor-data.csv');
console.log(`Total rows: ${rows.length}`);

db.close();
