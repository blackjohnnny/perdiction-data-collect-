import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('🔬 Testing EMA FOLLOW vs REVERSE win rates\n');

const rounds = db.prepare(`
  SELECT epoch, ema_signal, t20s_bull_wei, t20s_bear_wei, winner
  FROM rounds
  WHERE t20s_bull_wei IS NOT NULL
    AND t20s_bear_wei IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
  ORDER BY epoch ASC
`).all();

let followWins = 0, followTotal = 0;
let reverseWins = 0, reverseTotal = 0;

for (const r of rounds) {
  const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
  const totalAmount = bullAmount + bearAmount;

  const bullPayout = totalAmount / bullAmount;
  const bearPayout = totalAmount / bearAmount;

  // FOLLOW EMA (bet WITH the signal when payout >= 1.5x)
  let followSignal = null;
  if (r.ema_signal === 'BULL' && bullPayout >= 1.5) {
    followSignal = 'BULL';
  } else if (r.ema_signal === 'BEAR' && bearPayout >= 1.5) {
    followSignal = 'BEAR';
  }

  if (followSignal) {
    const won = (followSignal === 'BULL' && r.winner === 'bull') || (followSignal === 'BEAR' && r.winner === 'bear');
    if (won) followWins++;
    followTotal++;
  }

  // REVERSE EMA (bet AGAINST the signal when payout >= 1.5x)
  let reverseSignal = null;
  if (r.ema_signal === 'BULL' && bearPayout >= 1.5) {
    reverseSignal = 'BEAR';
  } else if (r.ema_signal === 'BEAR' && bullPayout >= 1.5) {
    reverseSignal = 'BULL';
  }

  if (reverseSignal) {
    const won = (reverseSignal === 'BULL' && r.winner === 'bull') || (reverseSignal === 'BEAR' && r.winner === 'bear');
    if (won) reverseWins++;
    reverseTotal++;
  }
}

const followWR = (followWins / followTotal * 100).toFixed(1);
const reverseWR = (reverseWins / reverseTotal * 100).toFixed(1);

console.log(`FOLLOW EMA (bet WITH signal, ≥1.5x payout):`);
console.log(`  Trades: ${followTotal}`);
console.log(`  Wins: ${followWins}`);
console.log(`  Win Rate: ${followWR}%\n`);

console.log(`REVERSE EMA (bet AGAINST signal, ≥1.5x payout):`);
console.log(`  Trades: ${reverseTotal}`);
console.log(`  Wins: ${reverseWins}`);
console.log(`  Win Rate: ${reverseWR}%\n`);

if (parseFloat(followWR) > parseFloat(reverseWR)) {
  console.log(`✅ FOLLOW strategy is better (+${(parseFloat(followWR) - parseFloat(reverseWR)).toFixed(1)}%)`);
  console.log(`\n🚨 BUG FOUND: We should FOLLOW EMA, not REVERSE!`);
} else {
  console.log(`✅ REVERSE strategy is better (+${(parseFloat(reverseWR) - parseFloat(followWR)).toFixed(1)}%)`);
}
