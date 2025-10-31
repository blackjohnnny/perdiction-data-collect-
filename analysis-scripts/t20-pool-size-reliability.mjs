import initSqlJs from 'sql.js';
import fs from 'fs';

console.log('=== T-20S POOL SIZE RELIABILITY ===\n');
console.log('Checking if T-20s pool size is significant enough to trust\n');

const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync('prediction-data.db'));

// Get snapshots with their rounds
const results = db.exec(`
  SELECT
    s.epoch,
    s.total_amount_wei as snap_total,
    s.bull_amount_wei as snap_bull,
    s.bear_amount_wei as snap_bear,
    r.total_amount_wei as final_total,
    r.bull_amount_wei as final_bull,
    r.bear_amount_wei as final_bear,
    r.winner
  FROM snapshots s
  JOIN rounds r ON s.epoch = r.epoch
  WHERE s.snapshot_type = 'T_MINUS_20S'
  AND r.winner IN ('UP', 'DOWN')
`);

if (!results[0]) {
  console.log('No data found!');
  process.exit(0);
}

const snapshots = results[0].values.map(row => {
  const snapTotal = BigInt(row[1]);
  const snapBull = BigInt(row[2]);
  const snapBear = BigInt(row[3]);
  const finalTotal = BigInt(row[4]);
  const finalBull = BigInt(row[5]);
  const finalBear = BigInt(row[6]);

  const snapTotalBNB = Number(snapTotal) / 1e18;
  const finalTotalBNB = Number(finalTotal) / 1e18;
  const lastSecondBNB = finalTotalBNB - snapTotalBNB;
  const lastSecondPct = (lastSecondBNB / finalTotalBNB) * 100;

  const snapBullPct = Number((snapBull * 10000n) / snapTotal) / 100;
  const snapBearPct = 100 - snapBullPct;
  const snapCrowd = snapBull > snapBear ? 'UP' : 'DOWN';
  const snapThreshold = Math.max(snapBullPct, snapBearPct);

  const finalBullPct = Number((finalBull * 10000n) / finalTotal) / 100;
  const finalBearPct = 100 - finalBullPct;
  const finalCrowd = finalBull > finalBear ? 'UP' : 'DOWN';

  const crowdFlipped = snapCrowd !== finalCrowd;

  return {
    epoch: row[0],
    snapTotalBNB,
    finalTotalBNB,
    lastSecondBNB,
    lastSecondPct,
    snapThreshold,
    snapCrowd,
    finalCrowd,
    crowdFlipped,
    winner: row[7]
  };
});

console.log(`Total snapshots: ${snapshots.length}\n`);
console.log('='.repeat(80));

// Group by how much pool is at T-20s vs final
const groups = {
  veryEarly: [], // <20% of final pool at T-20s
  early: [],     // 20-40% of final pool
  normal: [],    // 40-60% of final pool
  late: [],      // 60-80% of final pool
  veryLate: []   // >80% of final pool
};

snapshots.forEach(snap => {
  const pctAlreadyIn = ((snap.snapTotalBNB / snap.finalTotalBNB) * 100);

  if (pctAlreadyIn < 20) groups.veryEarly.push(snap);
  else if (pctAlreadyIn < 40) groups.early.push(snap);
  else if (pctAlreadyIn < 60) groups.normal.push(snap);
  else if (pctAlreadyIn < 80) groups.late.push(snap);
  else groups.veryLate.push(snap);
});

console.log('\nPOOL COMPLETION AT T-20S:\n');
console.log('Group           | Count | % of Total | Avg Last-Second | Flip Rate');
console.log('----------------|-------|------------|-----------------|----------');

[
  { name: '<20% at T-20s', key: 'veryEarly' },
  { name: '20-40% at T-20s', key: 'early' },
  { name: '40-60% at T-20s', key: 'normal' },
  { name: '60-80% at T-20s', key: 'late' },
  { name: '>80% at T-20s', key: 'veryLate' }
].forEach(({ name, key }) => {
  const group = groups[key];
  if (group.length === 0) return;

  const pct = (group.length / snapshots.length) * 100;
  const avgLastSecond = group.reduce((sum, s) => sum + s.lastSecondPct, 0) / group.length;
  const flipRate = (group.filter(s => s.crowdFlipped).length / group.length) * 100;

  console.log(`${name.padEnd(15)} | ${group.length.toString().padStart(5)} | ` +
              `${pct.toFixed(1).padStart(9)}% | ` +
              `${avgLastSecond.toFixed(1).padStart(14)}% | ` +
              `${flipRate.toFixed(1).padStart(8)}%`);
});

console.log('\n' + '='.repeat(80));

// Test strategy performance by pool completion at T-20s
console.log('\nSTRATEGY PERFORMANCE BY POOL COMPLETION:\n');

// For each group, test the strategy (crowd + threshold)
[
  { name: '<20% at T-20s (UNRELIABLE)', key: 'veryEarly' },
  { name: '20-40% at T-20s', key: 'early' },
  { name: '40-60% at T-20s', key: 'normal' },
  { name: '60-80% at T-20s', key: 'late' },
  { name: '>80% at T-20s (RELIABLE)', key: 'veryLate' }
].forEach(({ name, key }) => {
  const group = groups[key];
  if (group.length === 0) return;

  // Test at 55% threshold
  const trades55 = group.filter(s => s.snapThreshold >= 55);
  const wins55 = trades55.filter(s => s.snapCrowd === s.winner).length;
  const winRate55 = trades55.length > 0 ? (wins55 / trades55.length) * 100 : 0;

  // Test at 70% threshold
  const trades70 = group.filter(s => s.snapThreshold >= 70);
  const wins70 = trades70.filter(s => s.snapCrowd === s.winner).length;
  const winRate70 = trades70.length > 0 ? (wins70 / trades70.length) * 100 : 0;

  console.log(`${name}:`);
  console.log(`  55% threshold: ${winRate55.toFixed(1)}% win rate (${wins55}/${trades55.length})`);
  console.log(`  70% threshold: ${winRate70.toFixed(1)}% win rate (${wins70}/${trades70.length})`);
  console.log(`  Flip rate: ${(group.filter(s => s.crowdFlipped).length / group.length * 100).toFixed(1)}%`);
  console.log('');
});

console.log('='.repeat(80));
console.log('\nCONCLUSION:\n');

// Check if early snapshots (where most BNB enters late) are unreliable
const unreliableGroups = [...groups.veryEarly, ...groups.early];
const reliableGroups = [...groups.late, ...groups.veryLate];

if (unreliableGroups.length > 0) {
  const unreliableTrades = unreliableGroups.filter(s => s.snapThreshold >= 55);
  const unreliableWins = unreliableTrades.filter(s => s.snapCrowd === s.winner).length;
  const unreliableWinRate = unreliableTrades.length > 0 ? (unreliableWins / unreliableTrades.length) * 100 : 0;

  const reliableTrades = reliableGroups.filter(s => s.snapThreshold >= 55);
  const reliableWins = reliableTrades.filter(s => s.snapCrowd === s.winner).length;
  const reliableWinRate = reliableTrades.length > 0 ? (reliableWins / reliableTrades.length) * 100 : 0;

  console.log(`When <40% of pool at T-20s (unreliable):`);
  console.log(`  Win rate: ${unreliableWinRate.toFixed(1)}% (${unreliableWins}/${unreliableTrades.length})`);
  console.log(`  → Pool will change significantly!\n`);

  console.log(`When >60% of pool at T-20s (reliable):`);
  console.log(`  Win rate: ${reliableWinRate.toFixed(1)}% (${reliableWins}/${reliableTrades.length})`);
  console.log(`  → Pool is mostly set!\n`);

  if (unreliableWinRate < 55 && reliableWinRate > 60) {
    console.log(`✓ YOU ARE CORRECT!`);
    console.log(`  T-20s snapshots are only reliable when most of the pool is already in.`);
    console.log(`  Should filter out rounds where <40% of final pool is at T-20s!`);
  } else if (Math.abs(unreliableWinRate - reliableWinRate) < 3) {
    console.log(`✗ Pool completion doesn't significantly affect win rate.`);
    console.log(`  Strategy works even when most BNB enters late.`);
  } else {
    console.log(`⚠ Mixed results - need more data to determine impact.`);
  }
}

db.close();
