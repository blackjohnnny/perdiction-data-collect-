import Database from 'better-sqlite3';

const db = new Database('./prediction.db');

const rounds = db.prepare(`
  SELECT epoch, lock_price, close_price, winner, winner_payout_multiple,
         ema_signal, ema_gap, lock_bull_wei, lock_bear_wei, lock_total_wei
  FROM rounds
  WHERE is_complete = 1
    AND lock_price > 0
    AND close_price > 0
    AND ema_signal IS NOT NULL
  ORDER BY epoch
`).all();

console.log('🔍 TESTING WITH vs WITHOUT CIRCUIT BREAKER\n');
console.log('═'.repeat(60));

// TEST 1: NO CIRCUIT BREAKER
let bankroll1 = 100;
let wins1 = 0, losses1 = 0, skipped1 = 0;
let consec1 = 0;

rounds.forEach((r) => {
  if (!r.ema_signal || r.ema_signal === 'NEUTRAL') {
    skipped1++;
    return;
  }

  const bullWei = BigInt(r.lock_bull_wei);
  const bearWei = BigInt(r.lock_bear_wei);
  const totalWei = BigInt(r.lock_total_wei);

  const bullPayout = totalWei > 0n ? Number(totalWei * 10000n / bullWei) / 10000 : 0;
  const bearPayout = totalWei > 0n ? Number(totalWei * 10000n / bearWei) / 10000 : 0;

  let signal = null;
  if (r.ema_signal === 'BULL') {
    if (bullPayout > bearPayout && bullPayout >= 1.55) signal = 'BULL';
  } else if (r.ema_signal === 'BEAR') {
    if (bearPayout > bullPayout && bearPayout >= 1.55) signal = 'BEAR';
  }

  if (!signal) {
    skipped1++;
    return;
  }

  const betSize = bankroll1 * 0.045;
  const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
  const won = r.winner.toUpperCase() === signal;

  if (won) {
    bankroll1 += betSize * (actualPayout - 1);
    wins1++;
  } else {
    bankroll1 -= betSize;
    losses1++;
  }
});

// TEST 2: WITH CIRCUIT BREAKER (3 losses = 9 rounds cooldown)
let bankroll2 = 100;
let wins2 = 0, losses2 = 0, skipped2 = 0;
let consecLosses = 0;
let cooldownUntil = 0;
let cooldownCount = 0;

rounds.forEach((r, idx) => {
  // Check cooldown
  if (idx < cooldownUntil) {
    skipped2++;
    return;
  }

  if (!r.ema_signal || r.ema_signal === 'NEUTRAL') {
    skipped2++;
    return;
  }

  const bullWei = BigInt(r.lock_bull_wei);
  const bearWei = BigInt(r.lock_bear_wei);
  const totalWei = BigInt(r.lock_total_wei);

  const bullPayout = totalWei > 0n ? Number(totalWei * 10000n / bullWei) / 10000 : 0;
  const bearPayout = totalWei > 0n ? Number(totalWei * 10000n / bearWei) / 10000 : 0;

  let signal = null;
  if (r.ema_signal === 'BULL') {
    if (bullPayout > bearPayout && bullPayout >= 1.55) signal = 'BULL';
  } else if (r.ema_signal === 'BEAR') {
    if (bearPayout > bullPayout && bearPayout >= 1.55) signal = 'BEAR';
  }

  if (!signal) {
    skipped2++;
    return;
  }

  const betSize = bankroll2 * 0.045;
  const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
  const won = r.winner.toUpperCase() === signal;

  if (won) {
    bankroll2 += betSize * (actualPayout - 1);
    wins2++;
    consecLosses = 0; // Reset streak
  } else {
    bankroll2 -= betSize;
    losses2++;
    consecLosses++;

    // Circuit breaker: 3 losses = pause 9 rounds (45 min)
    if (consecLosses >= 3) {
      cooldownUntil = idx + 9;
      cooldownCount++;
      consecLosses = 0; // Reset for next period
    }
  }
});

console.log('\n📊 RESULTS COMPARISON:\n');

console.log('WITHOUT Circuit Breaker:');
console.log('  Trades:', wins1 + losses1);
console.log('  Wins:', wins1, '(' + (wins1/(wins1+losses1)*100).toFixed(1) + '%)');
console.log('  Losses:', losses1);
console.log('  Final bankroll:', bankroll2.toFixed(2), 'BNB');
console.log('  Profit:', (bankroll1 - 100).toFixed(2), 'BNB');
console.log('');

console.log('WITH Circuit Breaker (3 losses = 9 rounds pause):');
console.log('  Trades:', wins2 + losses2);
console.log('  Wins:', wins2, '(' + (wins2/(wins2+losses2)*100).toFixed(1) + '%)');
console.log('  Losses:', losses2);
console.log('  Circuit breaker triggered:', cooldownCount, 'times');
console.log('  Final bankroll:', bankroll2.toFixed(2), 'BNB');
console.log('  Profit:', (bankroll2 - 100).toFixed(2), 'BNB');
console.log('');

const improvement = ((bankroll2 - bankroll1) / Math.abs(bankroll1 - 100) * 100);
console.log('💡 VERDICT:');
if (bankroll2 > bankroll1) {
  console.log('  ✅ Circuit breaker HELPED: +' + improvement.toFixed(1) + '% better');
} else if (bankroll2 < bankroll1) {
  console.log('  ❌ Circuit breaker HURT: ' + improvement.toFixed(1) + '% worse');
} else {
  console.log('  ➖ No difference');
}

console.log('\n' + '═'.repeat(60));

db.close();
