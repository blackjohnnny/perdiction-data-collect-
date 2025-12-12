import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📊 COMPREHENSIVE ANALYSIS - CURRENT DATA');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Database stats
const stats = db.prepare(`
  SELECT
    COUNT(*) as total,
    COUNT(CASE WHEN winner IS NOT NULL THEN 1 END) as with_winner,
    COUNT(CASE WHEN t20s_timestamp IS NOT NULL THEN 1 END) as with_t20s,
    COUNT(CASE WHEN t20s_timestamp IS NOT NULL AND winner IS NOT NULL THEN 1 END) as complete
  FROM rounds
`).get();

console.log('DATABASE STATS:');
console.log('  Total samples:', stats.total);
console.log('  Complete rounds (T-20s + winner):', stats.complete);
console.log('  Data collection progress:', (stats.complete >= 1000 ? '✅' : '⏳'), stats.complete + '/1000 target\n');

const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL
  AND winner IS NOT NULL
  ORDER BY sample_id ASC
`).all();

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Analysis 1: Winning side payout
let winnerPayouts = [];
let loserPayouts = [];

for (const r of rounds) {
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

const sortedWinner = [...winnerPayouts].sort((a, b) => a - b);
const sortedLoser = [...loserPayouts].sort((a, b) => a - b);
const medianWinner = sortedWinner[Math.floor(sortedWinner.length / 2)];
const medianLoser = sortedLoser[Math.floor(sortedLoser.length / 2)];

console.log('1️⃣  WINNING SIDE PAYOUT ANALYSIS:\n');
console.log('  Winning side median payout:', medianWinner.toFixed(3) + 'x');
console.log('  Losing side median payout:', medianLoser.toFixed(3) + 'x');
console.log('  Interpretation:', medianWinner < medianLoser ?
  '✅ Underdog wins more often (contrarian opportunity)' :
  '❌ Favorite wins more often (trend following works)');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Analysis 2: Crowd >=65% win rate
let crowdTrades = 0;
let crowdWins = 0;

for (const r of rounds) {
  const bull = parseFloat(r.t20s_bull_wei) / 1e18;
  const bear = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bull + bear;

  if (total === 0) continue;

  const bullPct = (bull / total) * 100;
  const bearPct = (bear / total) * 100;

  let betSide = null;
  if (bullPct >= 65) betSide = 'BULL';
  else if (bearPct >= 65) betSide = 'BEAR';

  if (!betSide) continue;

  crowdTrades++;
  if (betSide.toLowerCase() === r.winner) crowdWins++;
}

const crowdWinRate = (crowdWins / crowdTrades * 100).toFixed(2);

console.log('2️⃣  BET WITH CROWD (≥65% at T-20s) STRATEGY:\n');
console.log('  Total trades:', crowdTrades, '(' + (crowdTrades/rounds.length*100).toFixed(1) + '% of rounds)');
console.log('  Wins:', crowdWins, '| Losses:', (crowdTrades - crowdWins));
console.log('  Win rate:', crowdWinRate + '%');
console.log('  Status:', parseFloat(crowdWinRate) > 52.5 ? '✅ Profitable' : '❌ Losing');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Analysis 3: Payout drift
let drifts = [];

for (const r of rounds) {
  const bull = parseFloat(r.t20s_bull_wei) / 1e18;
  const bear = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bull + bear;

  if (total === 0) continue;

  const bullPct = (bull / total) * 100;
  const bearPct = (bear / total) * 100;

  let betSide = null;
  if (bullPct >= 65) betSide = 'BULL';
  else if (bearPct >= 65) betSide = 'BEAR';

  if (!betSide) continue;

  const netPool = total * 0.97;
  const t20sPayout = betSide === 'BULL' ? netPool / bull : netPool / bear;
  const settlementPayout = r.winner_payout_multiple;
  const drift = settlementPayout - t20sPayout;
  const driftPercent = (drift / t20sPayout) * 100;

  drifts.push(driftPercent);
}

const avgDrift = drifts.reduce((sum, d) => sum + d, 0) / drifts.length;

console.log('3️⃣  PAYOUT DRIFT (T-20s → Settlement):\n');
console.log('  Average drift:', avgDrift.toFixed(2) + '%');
console.log('  Interpretation:', avgDrift > 0 ?
  '⚠️  Payouts increase (more people join your side = worse odds)' :
  '✅ Payouts decrease (good for you)');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

console.log('💡 SUMMARY:\n');
console.log('Sample size:', rounds.length, 'complete rounds');
console.log('Confidence level:', rounds.length >= 1000 ? '✅ HIGH' : rounds.length >= 500 ? '⚠️  MEDIUM' : '❌ LOW (need more data)');
console.log('\nKey findings:');
console.log('  • Crowd strategy win rate:', crowdWinRate + '%', parseFloat(crowdWinRate) < 50 ? '(LOSING)' : '(winning)');
console.log('  • Underdog advantage:', medianWinner < medianLoser ? 'YES (contrarian works)' : 'NO (trend following works)');
console.log('  • Payout drift:', avgDrift > 0 ? 'NEGATIVE (odds worsen)' : 'POSITIVE (odds improve)');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

db.close();
