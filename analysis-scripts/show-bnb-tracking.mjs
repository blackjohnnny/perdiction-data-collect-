import initSqlJs from 'sql.js';
import fs from 'fs';

console.log('=== BNB POOL TRACKING DEMONSTRATION ===\n');

const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync('prediction-data.db'));

// Get epoch 424496 which has all 3 snapshots
const result = db.exec(`
  SELECT snapshot_type,
         CAST(total_amount_wei AS REAL) / 1e18 as total_bnb,
         CAST(bull_amount_wei AS REAL) / 1e18 as bull_bnb,
         CAST(bear_amount_wei AS REAL) / 1e18 as bear_bnb,
         implied_up_multiple, implied_down_multiple
  FROM snapshots
  WHERE epoch = 424496
  ORDER BY
    CASE snapshot_type
      WHEN 'T_MINUS_25S' THEN 1
      WHEN 'T_MINUS_8S' THEN 2
      WHEN 'T_MINUS_4S' THEN 3
    END
`);

console.log('Epoch 424496 - BNB Pool Evolution:\n');
console.log('Timeframe   | Total BNB | Bull BNB | Bear BNB | Bull %  | BNB Added | UP Payout | DOWN Payout');
console.log('------------|-----------|----------|----------|---------|-----------|-----------|------------');

let prevTotal = 0;

result[0].values.forEach((row, idx) => {
  const [type, total, bull, bear, upPayout, downPayout] = row;
  const bullPct = (bull / total) * 100;
  const bnbAdded = idx === 0 ? 0 : total - prevTotal;

  console.log(`${type.padEnd(11)} | ${total.toFixed(3).padStart(9)} | ` +
              `${bull.toFixed(3).padStart(8)} | ${bear.toFixed(3).padStart(8)} | ` +
              `${bullPct.toFixed(1).padStart(6)}% | ${bnbAdded.toFixed(3).padStart(9)} | ` +
              `${upPayout ? upPayout.toFixed(3).padStart(9) : '     null'} | ` +
              `${downPayout ? downPayout.toFixed(3).padStart(11) : '       null'}`);

  prevTotal = total;
});

console.log('\n' + '='.repeat(100));
console.log('\nWHAT THIS SHOWS:\n');

const t25 = result[0].values[0];
const t8 = result[0].values[1];
const t4 = result[0].values[2];

const totalAdded = t4[1] - t25[1];
const pctAdded = (totalAdded / t4[1]) * 100;

console.log(`1. Pool Growth in Last 25 Seconds:`);
console.log(`   - Started at T-25s: ${t25[1].toFixed(3)} BNB`);
console.log(`   - Ended at T-4s: ${t4[1].toFixed(3)} BNB`);
console.log(`   - Added: ${totalAdded.toFixed(3)} BNB (${pctAdded.toFixed(1)}% increase)`);

console.log(`\n2. Crowd Shift:`);
const t25BullPct = (t25[2] / t25[1]) * 100;
const t4BullPct = (t4[2] / t4[1]) * 100;
const shift = t4BullPct - t25BullPct;

console.log(`   - Bull % at T-25s: ${t25BullPct.toFixed(1)}%`);
console.log(`   - Bull % at T-4s: ${t4BullPct.toFixed(1)}%`);
console.log(`   - Shift: ${shift > 0 ? '+' : ''}${shift.toFixed(1)}% toward ${shift > 0 ? 'BULL' : 'BEAR'}`);

console.log(`\n3. Payout Changes:`);
console.log(`   - UP payout went from ${t25[4].toFixed(3)}x → ${t4[4].toFixed(3)}x`);
console.log(`   - DOWN payout went from ${t25[5].toFixed(3)}x → ${t4[5].toFixed(3)}x`);

console.log(`\n4. Last-Second Manipulation Detection:`);
const t8ToT4Added = t4[1] - t8[1];
const t8ToT4Pct = (t8ToT4Added / t4[1]) * 100;

console.log(`   - BNB added between T-8s and T-4s: ${t8ToT4Added.toFixed(3)} BNB`);
console.log(`   - Percentage of final pool: ${t8ToT4Pct.toFixed(1)}%`);

if (t8ToT4Pct > 30) {
  console.log(`   - ⚠ HIGH manipulation (>30% entered in final 4-8 seconds)`);
} else if (t8ToT4Pct > 15) {
  console.log(`   - ⚠ MEDIUM manipulation (15-30% in final 4-8 seconds)`);
} else {
  console.log(`   - ✓ LOW manipulation (<15% in final 4-8 seconds)`);
}

console.log('\n' + '='.repeat(100));
console.log('\n✅ YES - BNB POOL DATA IS CAPTURED AT ALL TIMEFRAMES!\n');
console.log('You can now:');
console.log('  • Track pool evolution from T-25s → T-8s → T-4s');
console.log('  • Detect last-second manipulation');
console.log('  • See how payouts shift');
console.log('  • Calculate crowd changes');
console.log('  • Analyze bot/sniper activity\n');

db.close();
