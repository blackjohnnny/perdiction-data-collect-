import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('🔬 Testing baseline EMA Contrarian win rate (no circuit breaker, no hybrid)\n');

const rounds = db.prepare(`
  SELECT epoch, ema_signal, t20s_bull_wei, t20s_bear_wei, winner
  FROM rounds
  WHERE t20s_bull_wei IS NOT NULL
    AND t20s_bear_wei IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
  ORDER BY epoch ASC
`).all();

let wins = 0, total = 0;

for (const r of rounds) {
  const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
  const totalAmount = bullAmount + bearAmount;

  const bullPayout = totalAmount / bullAmount;
  const bearPayout = totalAmount / bearAmount;

  let signal = null;

  // Simple reversal: bet AGAINST EMA signal when payout >= 1.5x
  if (r.ema_signal === 'BULL' && bearPayout >= 1.5) {
    signal = 'BEAR';
  } else if (r.ema_signal === 'BEAR' && bullPayout >= 1.5) {
    signal = 'BULL';
  }

  if (!signal) continue;

  const won = (signal === 'BULL' && r.winner === 'bull') || (signal === 'BEAR' && r.winner === 'bear');

  if (won) wins++;
  total++;
}

const wr = (wins / total * 100).toFixed(1);

console.log(`Simple EMA Reversal (≥1.5x payout):`);
console.log(`  Trades: ${total}`);
console.log(`  Wins: ${wins}`);
console.log(`  Win Rate: ${wr}%`);
console.log(`\nExpected: ~54-58% WR from previous tests`);

if (parseFloat(wr) < 50) {
  console.log('\n❌ PROBLEM: Win rate too low! Something is wrong with the test logic.');
} else {
  console.log('\n✅ Win rate looks correct');
}
