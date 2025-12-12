import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('\n📊 WINNING SIDE PAYOUT ANALYSIS\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL
  AND winner IS NOT NULL
  ORDER BY sample_id ASC
`).all();

console.log('Total rounds:', rounds.length, '\n');

let winnerPayouts = [];
let loserPayouts = [];

for (const r of rounds) {
  const settlementPayout = r.winner_payout_multiple;

  // Calculate what the loser payout would have been
  const lockBull = parseFloat(r.lock_bull_wei) / 1e18;
  const lockBear = parseFloat(r.lock_bear_wei) / 1e18;
  const totalPool = lockBull + lockBear;

  if (totalPool === 0) continue;

  const netPool = totalPool * 0.97;

  let winnerPayout, loserPayout;
  if (r.winner === 'bull') {
    winnerPayout = netPool / lockBull;
    loserPayout = netPool / lockBear;
  } else {
    winnerPayout = netPool / lockBear;
    loserPayout = netPool / lockBull;
  }

  winnerPayouts.push(winnerPayout);
  loserPayouts.push(loserPayout);
}

// Calculate averages
const avgWinner = winnerPayouts.reduce((sum, p) => sum + p, 0) / winnerPayouts.length;
const avgLoser = loserPayouts.reduce((sum, p) => sum + p, 0) / loserPayouts.length;

// Calculate medians
const sortedWinner = [...winnerPayouts].sort((a, b) => a - b);
const sortedLoser = [...loserPayouts].sort((a, b) => a - b);
const medianWinner = sortedWinner[Math.floor(sortedWinner.length / 2)];
const medianLoser = sortedLoser[Math.floor(sortedLoser.length / 2)];

console.log('Settlement Payout Statistics:\n');
console.log('WINNING side:');
console.log('  Average payout: ' + avgWinner.toFixed(3) + 'x');
console.log('  Median payout: ' + medianWinner.toFixed(3) + 'x\n');

console.log('LOSING side (what they would have gotten):');
console.log('  Average payout: ' + avgLoser.toFixed(3) + 'x');
console.log('  Median payout: ' + medianLoser.toFixed(3) + 'x\n');

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Count by payout buckets
let winnerLow = 0, winnerMid = 0, winnerHigh = 0;
let loserLow = 0, loserMid = 0, loserHigh = 0;

for (let i = 0; i < winnerPayouts.length; i++) {
  const wp = winnerPayouts[i];
  const lp = loserPayouts[i];

  if (wp < 1.5) winnerLow++;
  else if (wp < 2.0) winnerMid++;
  else winnerHigh++;

  if (lp < 1.5) loserLow++;
  else if (lp < 2.0) loserMid++;
  else loserHigh++;
}

console.log('Payout Distribution:\n');
console.log('WINNING side:');
console.log('  <1.5x: ' + winnerLow + ' (' + (winnerLow/winnerPayouts.length*100).toFixed(1) + '%)');
console.log('  1.5-2.0x: ' + winnerMid + ' (' + (winnerMid/winnerPayouts.length*100).toFixed(1) + '%)');
console.log('  >2.0x: ' + winnerHigh + ' (' + (winnerHigh/winnerPayouts.length*100).toFixed(1) + '%)\n');

console.log('LOSING side:');
console.log('  <1.5x: ' + loserLow + ' (' + (loserLow/loserPayouts.length*100).toFixed(1) + '%)');
console.log('  1.5-2.0x: ' + loserMid + ' (' + (loserMid/loserPayouts.length*100).toFixed(1) + '%)');
console.log('  >2.0x: ' + loserHigh + ' (' + (loserHigh/loserPayouts.length*100).toFixed(1) + '%)\n');

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('💡 KEY INSIGHT:\n');
if (avgWinner < avgLoser) {
  console.log('✅ Winners have LOWER payout = The MAJORITY (favorite) wins more often');
  console.log('   → The crowd is usually RIGHT');
} else {
  console.log('✅ Winners have HIGHER payout = The MINORITY (underdog) wins more often');
  console.log('   → The crowd is usually WRONG (contrarian opportunity)');
}
console.log();

db.close();
