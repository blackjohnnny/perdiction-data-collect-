import initSqlJs from 'sql.js';
import fs from 'fs';
import { formatEther } from 'viem';

const SQL = await initSqlJs();
const dbBuffer = fs.readFileSync('prediction-data.db');
const db = new SQL.Database(dbBuffer);

// Get snapshots WITH winners
const snapshots = db.exec(`
  SELECT
    s.epoch,
    s.snapshot_type,
    s.total_amount_wei,
    s.bull_amount_wei,
    s.bear_amount_wei,
    s.taken_at,
    r.winner
  FROM snapshots s
  INNER JOIN rounds r ON s.epoch = r.epoch
  WHERE r.winner IN ('UP', 'DOWN')
  ORDER BY s.epoch ASC, s.snapshot_type ASC
`);

if (!snapshots[0] || snapshots[0].values.length === 0) {
  console.log('❌ No snapshot data with winners found!');
  db.close();
  process.exit(1);
}

const data = snapshots[0].values.map(([epoch, type, total, bull, bear, ts, winner]) => ({
  epoch: Number(epoch),
  snapshotType: type,
  totalAmount: BigInt(total),
  bullAmount: BigInt(bull),
  bearAmount: BigInt(bear),
  timestamp: Number(ts),
  winner: winner
}));

console.log(`\n📊 Contrarian Strategy Analysis - Snapshot Data\n`);
console.log(`Total snapshots with winners: ${data.length}`);

const t25sData = data.filter(d => d.snapshotType === 'T_MINUS_25S');
const t8sData = data.filter(d => d.snapshotType === 'T_MINUS_8S');

console.log(`  T-25s snapshots: ${t25sData.length} (MANUAL BETTING)`);
console.log(`  T-8s snapshots: ${t8sData.length} (AUTOMATED BETTING)\n`);

function calculateImbalance(bullAmount, bearAmount) {
  const total = bullAmount + bearAmount;
  if (total === 0n) return { percent: 0, favoredSide: null };

  const bullPct = Number(bullAmount * 10000n / total) / 100;
  const bearPct = Number(bearAmount * 10000n / total) / 100;

  if (bullPct > bearPct) {
    return { percent: bullPct, favoredSide: 'UP' };
  } else {
    return { percent: bearPct, favoredSide: 'DOWN' };
  }
}

function testContrarianStrategy(data, imbalanceThreshold, label) {
  const TREASURY_FEE = 0.03; // 3%

  let totalBets = 0;
  let wins = 0;
  let totalStaked = 0n;
  let totalReturned = 0n;

  for (const snapshot of data) {
    const { percent, favoredSide } = calculateImbalance(snapshot.bullAmount, snapshot.bearAmount);

    if (percent < imbalanceThreshold) {
      continue; // Don't bet if imbalance too low
    }

    // CONTRARIAN: Bet AGAINST the crowd (bet the underdog)
    const betSide = favoredSide === 'UP' ? 'DOWN' : 'UP';
    const won = betSide === snapshot.winner;

    totalBets++;
    if (won) wins++;

    // Calculate payout
    const betAmount = 1n * 10n**18n; // 1 BNB
    totalStaked += betAmount;

    if (won) {
      const totalPool = snapshot.totalAmount;
      const winningSide = betSide === 'UP' ? snapshot.bullAmount : snapshot.bearAmount;

      // Payout = (totalPool * (1 - treasuryFee)) * (yourBet / winningSideTotal)
      const poolAfterFee = totalPool * BigInt(Math.floor((1 - TREASURY_FEE) * 10000)) / 10000n;
      const payout = poolAfterFee * betAmount / winningSide;
      totalReturned += payout;
    }
  }

  if (totalBets === 0) {
    console.log(`${label}: No bets taken`);
    return;
  }

  const winRate = (wins / totalBets * 100).toFixed(2);
  const stakedEther = Number(formatEther(totalStaked));
  const returnedEther = Number(formatEther(totalReturned));
  const profit = returnedEther - stakedEther;
  const roi = ((profit / stakedEther) * 100).toFixed(2);

  console.log(`${label}:`);
  console.log(`  Bets: ${totalBets}`);
  console.log(`  Wins: ${wins} (${winRate}%)`);
  console.log(`  Staked: ${stakedEther.toFixed(2)} BNB`);
  console.log(`  Returned: ${returnedEther.toFixed(2)} BNB`);
  console.log(`  Profit: ${profit >= 0 ? '+' : ''}${profit.toFixed(2)} BNB`);
  console.log(`  ROI: ${roi >= 0 ? '+' : ''}${roi}%`);
  console.log();
}

console.log('═'.repeat(60));
console.log('MANUAL BETTING STRATEGY (T-25s snapshots)');
console.log('Use this for manual betting (need 20-25s to submit tx)');
console.log('═'.repeat(60));
console.log();

testContrarianStrategy(t25sData, 70, '📍 T-25s: >70% imbalance (HIGH confidence)');
testContrarianStrategy(t25sData, 65, '📍 T-25s: >65% imbalance (MEDIUM-HIGH)');
testContrarianStrategy(t25sData, 60, '📍 T-25s: >60% imbalance (MEDIUM)');
testContrarianStrategy(t25sData, 55, '📍 T-25s: >55% imbalance (LOW confidence)');

console.log('═'.repeat(60));
console.log('AUTOMATED BETTING STRATEGY (T-8s snapshots)');
console.log('Use this for script-based betting (can bet up to 8s before lock)');
console.log('═'.repeat(60));
console.log();

testContrarianStrategy(t8sData, 70, '🤖 T-8s: >70% imbalance (HIGH confidence)');
testContrarianStrategy(t8sData, 65, '🤖 T-8s: >65% imbalance (MEDIUM-HIGH)');
testContrarianStrategy(t8sData, 60, '🤖 T-8s: >60% imbalance (MEDIUM)');
testContrarianStrategy(t8sData, 55, '🤖 T-8s: >55% imbalance (LOW confidence)');

console.log('═'.repeat(60));
console.log('⚠️  IMPORTANT NOTES:');
console.log('═'.repeat(60));
console.log(`• Sample size: ${t25sData.length} rounds (VERY SMALL - need 500+ for confidence)`);
console.log('• This is historical data - real-time may differ');
console.log('• 3% treasury fee included in calculations');
console.log('• Assumes 1 BNB bet per qualifying round');
console.log('• Gas fees NOT included');
console.log();

db.close();
