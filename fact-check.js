import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('\n📊 FACT CHECK - Settlement Payout vs T-20s Payout\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL
  AND winner IS NOT NULL
  ORDER BY sample_id ASC
`).all();

console.log('Total rounds:', rounds.length, '\n');

// Test 1: Filter by SETTLEMENT payout (WRONG - what I was doing before)
console.log('❌ WRONG METHOD: Filter by settlement payout\n');

const thresholds = [1.85, 2.0, 2.5];

for (const threshold of thresholds) {
  let trades = 0;
  let wins = 0;
  let losses = 0;

  for (const r of rounds) {
    const settlementPayout = r.winner_payout_multiple;

    if (settlementPayout > threshold) continue;

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

    trades++;
    const won = betSide.toLowerCase() === r.winner;
    if (won) wins++;
    else losses++;
  }

  const winRate = trades > 0 ? (wins / trades * 100).toFixed(2) : 0;
  console.log(`  Max ${threshold}x: ${trades} trades, ${wins}W/${losses}L, ${winRate}% win rate`);
}

// Test 2: Filter by T-20S payout (CORRECT)
console.log('\n✅ CORRECT METHOD: Filter by T-20s payout\n');

for (const threshold of thresholds) {
  let trades = 0;
  let wins = 0;
  let losses = 0;

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

    // Calculate T-20s payout
    const netPool = total * 0.97;
    const t20sPayout = betSide === 'BULL' ? netPool / bull : netPool / bear;

    if (t20sPayout > threshold) continue;

    trades++;
    const won = betSide.toLowerCase() === r.winner;
    if (won) wins++;
    else losses++;
  }

  const winRate = trades > 0 ? (wins / trades * 100).toFixed(2) : 0;
  console.log(`  Max ${threshold}x: ${trades} trades, ${wins}W/${losses}L, ${winRate}% win rate`);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('💡 KEY DIFFERENCE:\n');
console.log('WRONG: Uses winner_payout_multiple (settlement payout at lock)');
console.log('RIGHT: Calculates payout from T-20s pool amounts\n');
console.log('⚠️  NOTE: Both tests above use NO EMA filter (just crowd >=65%)\n');

db.close();
