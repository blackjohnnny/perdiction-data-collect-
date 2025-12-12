import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('\n📊 FACT CHECK - Manual Count\n');

const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL
  AND winner IS NOT NULL
  ORDER BY sample_id ASC
`).all();

console.log('Total complete rounds:', rounds.length, '\n');

let tradesNoPayout = 0;
let tradesWithPayout = 0;
let filteredByPayout = 0;
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

  tradesNoPayout++;

  const netPool = total * 0.97;
  const t20sPayout = betSide === 'BULL' ? netPool / bull : netPool / bear;

  if (t20sPayout <= 1.85) {
    tradesWithPayout++;
    const won = betSide.toLowerCase() === r.winner;
    if (won) wins++;
    else losses++;
  } else {
    filteredByPayout++;
  }
}

const winRate = tradesWithPayout > 0 ? (wins / tradesWithPayout * 100).toFixed(2) : 0;

console.log('WITHOUT payout filter (crowd >=65% only):');
console.log('  Total trades:', tradesNoPayout);
console.log('');
console.log('WITH payout filter (<=1.85x at T-20s):');
console.log('  Trades:', tradesWithPayout);
console.log('  Wins:', wins, '| Losses:', losses);
console.log('  Win rate:', winRate + '%');
console.log('  Filtered by payout:', filteredByPayout, '(' + (filteredByPayout/tradesNoPayout*100).toFixed(1) + '%)');

console.log('\n⚠️  NOTE: This count does NOT include EMA filter!');
console.log('The actual test that showed 91 trades DOES use EMA filter.');

db.close();
