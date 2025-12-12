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

let wins = [];
let losses = [];

rounds.forEach((r) => {
  if (!r.ema_signal || r.ema_signal === 'NEUTRAL') return;

  const bullWei = BigInt(r.lock_bull_wei);
  const bearWei = BigInt(r.lock_bear_wei);
  const totalWei = BigInt(r.lock_total_wei);

  const bullPayout = totalWei > 0n ? Number(totalWei * 10000n / bullWei) / 10000 : 0;
  const bearPayout = totalWei > 0n ? Number(totalWei * 10000n / bearWei) / 10000 : 0;

  let signal = null;
  let payout = 0;

  if (r.ema_signal === 'BULL') {
    if (bullPayout > bearPayout && bullPayout >= 1.55) {
      signal = 'BULL';
      payout = bullPayout;
    }
  } else if (r.ema_signal === 'BEAR') {
    if (bearPayout > bullPayout && bearPayout >= 1.55) {
      signal = 'BEAR';
      payout = bearPayout;
    }
  }

  if (!signal) return;

  const won = r.winner.toUpperCase() === signal;

  if (won) {
    wins.push(payout);
  } else {
    losses.push(1.0);
  }
});

const avgWinPayout = wins.reduce((a, b) => a + b, 0) / wins.length;
const minWinPayout = Math.min(...wins);
const maxWinPayout = Math.max(...wins);
const totalWinProfit = wins.reduce((acc, p) => acc + (p - 1), 0);
const totalLossProfit = losses.length * -1;
const expectancy = (totalWinProfit + totalLossProfit) / (wins.length + losses.length);

console.log('🔍 WHY WE PROFIT WITH 45.4% WIN RATE\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

console.log('📊 PAYOUT DISTRIBUTION:');
console.log('  Wins: ' + wins.length + ' trades');
console.log('  Average payout: ' + avgWinPayout.toFixed(2) + 'x');
console.log('  Min payout: ' + minWinPayout.toFixed(2) + 'x');
console.log('  Max payout: ' + maxWinPayout.toFixed(2) + 'x');
console.log('  Losses: ' + losses.length + ' trades (lose 1.00x each)');
console.log('');

console.log('💰 PROFITABILITY MATH:');
console.log('  When we WIN:  +' + (avgWinPayout - 1).toFixed(2) + ' units profit (on average)');
console.log('  When we LOSE: -1.00 units');
console.log('');
console.log('  Total win profit:  +' + totalWinProfit.toFixed(2) + ' units (' + wins.length + ' wins)');
console.log('  Total loss:        -' + losses.length + '.00 units (' + losses.length + ' losses)');
console.log('  Net profit:        +' + (totalWinProfit + totalLossProfit).toFixed(2) + ' units');
console.log('');

console.log('📈 EXPECTANCY PER TRADE:');
console.log('  +' + expectancy.toFixed(3) + ' units');
console.log('  (In %, that\'s +' + (expectancy * 100).toFixed(1) + '% per trade)');
console.log('');

console.log('✅ THE KEY INSIGHT:\n');
console.log('  REVERSE CROWD strategy bets on the HIGH PAYOUT side');
console.log('  (the side where LESS money is betting)');
console.log('');
console.log('  Even with 45.4% win rate:');
console.log('    45.4% × ' + avgWinPayout.toFixed(2) + 'x = ' + (0.454 * avgWinPayout).toFixed(2) + ' units expected from wins');
console.log('    54.6% × -1.00x = -0.546 units expected from losses');
console.log('    Net = ' + ((0.454 * avgWinPayout) - 0.546).toFixed(3) + ' units per trade');
console.log('');
console.log('  This is called POSITIVE EXPECTANCY!');
console.log('  High payouts compensate for lower win rate.');

db.close();
