import { initDatabase } from './db-init.js';

const db = initDatabase();

function runBasicContrarian(useT20s) {
  const rounds = db.prepare(`
    SELECT epoch, ema_signal, ema_gap,
           ${useT20s ? 't20s_bull_wei, t20s_bear_wei' : 'lock_bull_wei, lock_bear_wei'},
           winner
    FROM rounds
    WHERE ${useT20s ? 't20s_bull_wei' : 'lock_bull_wei'} IS NOT NULL
      AND ${useT20s ? 't20s_bear_wei' : 'lock_bear_wei'} IS NOT NULL
      AND winner IS NOT NULL
      AND ema_signal IS NOT NULL
    ORDER BY epoch ASC
  `).all();

  let bankroll = 1.0;
  let trades = 0;
  let wins = 0;

  for (const r of rounds) {
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const bullWei = parseFloat(useT20s ? r.t20s_bull_wei : r.lock_bull_wei) / 1e18;
    const bearWei = parseFloat(useT20s ? r.t20s_bear_wei : r.lock_bear_wei) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    let signal = null;
    if (emaSignal === 'BULL' && bearPayout >= 1.45) {
      signal = 'BEAR';
    } else if (emaSignal === 'BEAR' && bullPayout >= 1.45) {
      signal = 'BULL';
    }

    if (!signal) continue;

    const betAmount = bankroll * 0.045;
    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const winner = r.winner.toLowerCase();
    const won = (signal === 'BULL' && winner === 'bull') || (signal === 'BEAR' && winner === 'bear');

    const profit = won ? betAmount * (actualPayout - 1) : -betAmount;
    bankroll += profit;

    trades++;
    if (won) wins++;

    if (bankroll <= 0) break;
  }

  return {
    source: useT20s ? 'T-20s' : 'Lock',
    rounds: rounds.length,
    trades,
    wins,
    winRate: ((wins / trades) * 100).toFixed(1),
    finalBankroll: bankroll.toFixed(2),
    roi: ((bankroll - 1) * 100).toFixed(1)
  };
}

console.log('Comparing T-20s vs Lock payout sources...\n');

const t20sResult = runBasicContrarian(true);
const lockResult = runBasicContrarian(false);

console.log('T-20s SNAPSHOT:');
console.log(`  Rounds available: ${t20sResult.rounds}`);
console.log(`  Trades: ${t20sResult.trades}`);
console.log(`  Win Rate: ${t20sResult.winRate}%`);
console.log(`  Final: ${t20sResult.finalBankroll} BNB`);
console.log(`  ROI: ${t20sResult.roi}%\n`);

console.log('LOCK AMOUNTS:');
console.log(`  Rounds available: ${lockResult.rounds}`);
console.log(`  Trades: ${lockResult.trades}`);
console.log(`  Win Rate: ${lockResult.winRate}%`);
console.log(`  Final: ${lockResult.finalBankroll} BNB`);
console.log(`  ROI: ${lockResult.roi}%\n`);

console.log('VERDICT:');
if (parseFloat(t20sResult.finalBankroll) > parseFloat(lockResult.finalBankroll)) {
  console.log(`✅ T-20s performs BETTER by ${(parseFloat(t20sResult.finalBankroll) - parseFloat(lockResult.finalBankroll)).toFixed(2)} BNB`);
  console.log('   Reason: T-20s snapshot captures better payout odds before late bets come in');
} else {
  console.log(`✅ Lock performs BETTER by ${(parseFloat(lockResult.finalBankroll) - parseFloat(t20sResult.finalBankroll)).toFixed(2)} BNB`);
  console.log('   Reason: Lock amounts are final, more accurate');
}
