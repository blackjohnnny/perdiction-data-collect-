import Database from 'better-sqlite3';

const db = new Database('./prediction.db');

const fiveHoursAgo = Math.floor(Date.now() / 1000) - (5 * 60 * 60);

const recent = db.prepare(`
  SELECT COUNT(*) as count
  FROM rounds
  WHERE lock_timestamp >= ?
    AND is_complete = 1
    AND lock_price > 0
    AND close_price > 0
`).get(fiveHoursAgo);

const rounds = db.prepare(`
  SELECT epoch, lock_timestamp, lock_price, close_price, winner,
         winner_payout_multiple, ema_signal, ema_gap,
         lock_bull_wei, lock_bear_wei, lock_total_wei
  FROM rounds
  WHERE lock_timestamp >= ?
    AND is_complete = 1
    AND lock_price > 0
    AND close_price > 0
    AND ema_signal IS NOT NULL
  ORDER BY epoch
`).all(fiveHoursAgo);

console.log('📊 LAST 5 HOURS PERFORMANCE\n');
console.log('Complete rounds:', recent.count);
console.log('Rounds with EMA signals:', rounds.length);
console.log('');

let bankroll = 100;
let wins = 0, losses = 0, skipped = 0;
let trades = [];

rounds.forEach((r) => {
  if (!r.ema_signal || r.ema_signal === 'NEUTRAL') {
    skipped++;
    return;
  }

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

  if (!signal) {
    skipped++;
    return;
  }

  const betSize = bankroll * 0.045;
  const won = r.winner.toUpperCase() === signal;

  if (won) {
    const profit = betSize * (payout - 1);
    bankroll += profit;
    wins++;
    trades.push({
      epoch: r.epoch,
      signal,
      won: true,
      payout: payout.toFixed(2),
      profit: profit.toFixed(2),
      bankroll: bankroll.toFixed(2)
    });
  } else {
    bankroll -= betSize;
    losses++;
    trades.push({
      epoch: r.epoch,
      signal,
      won: false,
      payout: payout.toFixed(2),
      loss: betSize.toFixed(2),
      bankroll: bankroll.toFixed(2)
    });
  }
});

const totalTrades = wins + losses;
const winRate = totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : 0;
const profit = (bankroll - 100).toFixed(2);

console.log('🎯 RESULTS:');
console.log('  Trades taken:', totalTrades);
console.log('  Wins:', wins, '(' + winRate + '%)');
console.log('  Losses:', losses);
console.log('  Skipped:', skipped);
console.log('');
console.log('💰 P&L:');
console.log('  Starting: 100 BNB');
console.log('  Ending:', bankroll.toFixed(2), 'BNB');
console.log('  Profit:', (profit >= 0 ? '+' : '') + profit, 'BNB');
console.log('  Status:', profit >= 0 ? '✅ PROFITABLE' : '❌ LOSING');
console.log('');

if (trades.length > 0) {
  console.log('📝 All trades in last 5 hours:');
  trades.forEach(t => {
    if (t.won) {
      console.log(`  ${t.epoch}: ${t.signal} @ ${t.payout}x → ✅ WIN (+${t.profit} BNB) | Bankroll: ${t.bankroll}`);
    } else {
      console.log(`  ${t.epoch}: ${t.signal} @ ${t.payout}x → ❌ LOSS (-${t.loss} BNB) | Bankroll: ${t.bankroll}`);
    }
  });
}

db.close();
