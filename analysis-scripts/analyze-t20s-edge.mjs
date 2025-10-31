import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('         T-20s SNAPSHOT ANALYSIS - PROVING THE EDGE');
console.log('═══════════════════════════════════════════════════════════════\n');

// Get all rounds with T-20s snapshots and final results
const query = `
  SELECT
    r.epoch,
    r.winner,
    r.close_price,
    r.lock_price,
    s.snapshot_type,
    s.implied_up_multiple,
    s.implied_down_multiple,
    s.bull_amount_wei,
    s.bear_amount_wei,
    s.total_amount_wei
  FROM rounds r
  JOIN snapshots s ON r.epoch = s.epoch
  WHERE r.winner IN ('UP', 'DOWN')
    AND s.snapshot_type LIKE 'T_MINUS_%'
  ORDER BY r.epoch, s.snapshot_type
`;

const stmt = db.prepare(query);
const rows = [];
while (stmt.step()) {
  rows.push(stmt.getAsObject());
}
stmt.free();

console.log(`📊 Total snapshot records: ${rows.length}`);

// Group by epoch and snapshot type
const byEpoch = {};
for (const row of rows) {
  if (!byEpoch[row.epoch]) {
    byEpoch[row.epoch] = {
      winner: row.winner,
      closePrice: row.close_price,
      lockPrice: row.lock_price,
      snapshots: {}
    };
  }
  byEpoch[row.epoch].snapshots[row.snapshot_type] = {
    impliedUp: row.implied_up_multiple,
    impliedDown: row.implied_down_multiple,
    bullAmount: BigInt(row.bull_amount_wei),
    bearAmount: BigInt(row.bear_amount_wei),
    totalAmount: BigInt(row.total_amount_wei)
  };
}

const epochs = Object.keys(byEpoch).map(Number);
console.log(`🎯 Unique epochs with snapshots: ${epochs.length}\n`);

// Analyze each snapshot type
const snapshotTypes = ['T_MINUS_25S', 'T_MINUS_20S', 'T_MINUS_8S', 'T_MINUS_4S'];

for (const snapType of snapshotTypes) {
  console.log(`\n${'═'.repeat(63)}`);
  console.log(`   ${snapType} STRATEGY ANALYSIS`);
  console.log(`${'═'.repeat(63)}\n`);

  const strategies = [
    {
      name: 'Bet Underdog (Contrarian)',
      test: (snap) => true, // Always bet underdog
      pickSide: (snap) => snap.impliedUp > snap.impliedDown ? 'DOWN' : 'UP'
    },
    {
      name: 'High Imbalance Underdog (>2.5x)',
      test: (snap) => Math.max(snap.impliedUp, snap.impliedDown) > 2.5,
      pickSide: (snap) => snap.impliedUp > snap.impliedDown ? 'DOWN' : 'UP'
    },
    {
      name: 'Extreme Imbalance Underdog (>3x)',
      test: (snap) => Math.max(snap.impliedUp, snap.impliedDown) > 3.0,
      pickSide: (snap) => snap.impliedUp > snap.impliedDown ? 'DOWN' : 'UP'
    },
    {
      name: 'Very High Imbalance (>4x)',
      test: (snap) => Math.max(snap.impliedUp, snap.impliedDown) > 4.0,
      pickSide: (snap) => snap.impliedUp > snap.impliedDown ? 'DOWN' : 'UP'
    }
  ];

  for (const strategy of strategies) {
    let totalBets = 0;
    let wins = 0;
    let totalWagered = 0;
    let totalReturned = 0;

    for (const epoch of epochs) {
      const round = byEpoch[epoch];
      const snap = round.snapshots[snapType];

      if (!snap) continue;
      if (!strategy.test(snap)) continue;

      const betSide = strategy.pickSide(snap);
      const payout = betSide === 'UP' ? snap.impliedUp : snap.impliedDown;
      const won = round.winner === betSide;

      totalBets++;
      totalWagered += 1;
      if (won) {
        wins++;
        totalReturned += payout;
      }
    }

    if (totalBets === 0) continue;

    const winRate = (wins / totalBets) * 100;
    const netProfit = totalReturned - totalWagered;
    const roi = (netProfit / totalWagered) * 100;

    console.log(`\n📈 ${strategy.name}`);
    console.log(`${'─'.repeat(63)}`);
    console.log(`Total Bets:        ${totalBets}`);
    console.log(`Wins / Losses:     ${wins} / ${totalBets - wins}`);
    console.log(`Win Rate:          ${winRate.toFixed(2)}%`);
    console.log(`Total Wagered:     ${totalWagered.toFixed(2)} BNB`);
    console.log(`Total Returned:    ${totalReturned.toFixed(2)} BNB`);
    console.log(`Net Profit:        ${netProfit >= 0 ? '+' : ''}${netProfit.toFixed(2)} BNB`);
    console.log(`ROI:               ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`);
    console.log(`Avg Return/Bet:    ${(totalReturned / totalBets).toFixed(3)} BNB`);

    if (roi > 0) {
      console.log(`\n✅ PROFITABLE EDGE DETECTED! 🎯`);
    }
  }
}

// T-value change analysis
console.log(`\n\n${'═'.repeat(63)}`);
console.log('   T-VALUE MOVEMENT ANALYSIS');
console.log(`${'═'.repeat(63)}\n`);

const movements = [];
for (const epoch of epochs) {
  const round = byEpoch[epoch];
  const t25 = round.snapshots['T_MINUS_25S'];
  const t4 = round.snapshots['T_MINUS_4S'];

  if (!t25 || !t4) continue;

  const upMove = t4.impliedUp - t25.impliedUp;
  const downMove = t4.impliedDown - t25.impliedDown;

  movements.push({
    epoch,
    winner: round.winner,
    upMove,
    downMove,
    initialFavorite: t25.impliedUp < t25.impliedDown ? 'UP' : 'DOWN',
    finalFavorite: t4.impliedUp < t4.impliedDown ? 'UP' : 'DOWN'
  });
}

console.log(`Analyzed ${movements.length} rounds with T-25s and T-4s data\n`);

// Check if betting against late-money momentum works
let betAgainstMomentum = 0;
let winsAgainstMomentum = 0;

for (const mov of movements) {
  // If UP odds got worse (more money came in for UP), bet DOWN
  if (mov.upMove < -0.3) {
    betAgainstMomentum++;
    if (mov.winner === 'DOWN') winsAgainstMomentum++;
  }
  // If DOWN odds got worse (more money came in for DOWN), bet UP
  else if (mov.downMove < -0.3) {
    betAgainstMomentum++;
    if (mov.winner === 'UP') winsAgainstMomentum++;
  }
}

if (betAgainstMomentum > 0) {
  const winRate = (winsAgainstMomentum / betAgainstMomentum) * 100;
  console.log(`📊 Bet Against Late Momentum Strategy (T-25s to T-4s)`);
  console.log(`${'─'.repeat(63)}`);
  console.log(`Total Bets:        ${betAgainstMomentum}`);
  console.log(`Wins:              ${winsAgainstMomentum}`);
  console.log(`Win Rate:          ${winRate.toFixed(2)}%`);
  console.log(`Expected:          50.00% (if no edge)`);
  if (winRate > 52) {
    console.log(`\n✅ EDGE DETECTED - Late money is often wrong!\n`);
  }
}

db.close();

console.log(`\n${'═'.repeat(63)}`);
console.log('   CONCLUSION');
console.log(`${'═'.repeat(63)}\n`);
console.log(`We now have ${epochs.length} rounds with live T-value data.`);
console.log(`This allows us to test strategies that exploit:`);
console.log(`  • Pool imbalances at specific timeframes`);
console.log(`  • T-value movement patterns (crowd behavior)`);
console.log(`  • Contrarian betting opportunities\n`);
