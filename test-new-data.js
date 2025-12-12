import Database from 'better-sqlite3';

const db = new Database('./prediction.db');

console.log('🎯 TESTING REVERSE CROWD STRATEGY ON ALL COLLECTED DATA\n');

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

let bankroll = 100;
let wins = 0, losses = 0, skipped = 0;
let totalProfit = 0;
let maxBankroll = 100, maxDrawdown = 0;
let tradeLog = [];

rounds.forEach((r) => {
  if (!r.ema_signal || r.ema_signal === 'NEUTRAL') {
    skipped++;
    return;
  }

  // Calculate payouts from wei amounts
  const bullWei = BigInt(r.lock_bull_wei);
  const bearWei = BigInt(r.lock_bear_wei);
  const totalWei = BigInt(r.lock_total_wei);

  const bullPayout = totalWei > 0n ? Number(totalWei * 10000n / bullWei) / 10000 : 0;
  const bearPayout = totalWei > 0n ? Number(totalWei * 10000n / bearWei) / 10000 : 0;

  // REVERSE CROWD: Bet high payout side when EMA agrees
  let signal = null;
  if (r.ema_signal === 'BULL') {
    if (bullPayout > bearPayout && bullPayout >= 1.55) {
      signal = 'BULL';
    }
  } else if (r.ema_signal === 'BEAR') {
    if (bearPayout > bullPayout && bearPayout >= 1.55) {
      signal = 'BEAR';
    }
  }

  if (!signal) {
    skipped++;
    return;
  }

  // Base position size: 4.5%
  const betSize = bankroll * 0.045;
  const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
  const won = r.winner.toUpperCase() === signal;

  if (won) {
    const profit = betSize * (actualPayout - 1);
    bankroll += profit;
    totalProfit += profit;
    wins++;
  } else {
    bankroll -= betSize;
    totalProfit -= betSize;
    losses++;
  }

  // Track drawdown
  if (bankroll > maxBankroll) maxBankroll = bankroll;
  const dd = ((maxBankroll - bankroll) / maxBankroll * 100);
  if (dd > maxDrawdown) maxDrawdown = dd;

  // Log first and last 5 trades
  if (tradeLog.length < 5 || (wins + losses) > rounds.length - 5) {
    tradeLog.push({
      epoch: r.epoch,
      signal,
      won,
      payout: actualPayout.toFixed(2),
      bankroll: bankroll.toFixed(2)
    });
  }
});

const totalTrades = wins + losses;
const winRate = (wins / totalTrades * 100).toFixed(1);
const roi = ((bankroll - 100) / 100 * 100).toFixed(1);

console.log('📈 FINAL RESULTS:');
console.log('  Total rounds analyzed:', rounds.length);
console.log('  Trades taken:', totalTrades);
console.log('  Skipped (no signal/payout):', skipped);
console.log('');
console.log('🎯 PERFORMANCE:');
console.log('  Wins:', wins, '(' + winRate + '%)');
console.log('  Losses:', losses);
console.log('  Win Rate:', winRate + '%');
console.log('');
console.log('💰 PROFITABILITY:');
console.log('  Starting bankroll: 100 BNB');
console.log('  Final bankroll:', bankroll.toFixed(2), 'BNB');
console.log('  Total profit:', totalProfit.toFixed(2), 'BNB');
console.log('  ROI:', roi + '%');
console.log('  Max Drawdown:', maxDrawdown.toFixed(1) + '%');
console.log('');
console.log('💡 VERDICT:', bankroll > 100 ? '✅ PROFITABLE' : '❌ NOT PROFITABLE');
console.log('');
console.log('Sample trades:');
tradeLog.forEach(t => {
  console.log(`  Epoch ${t.epoch}: ${t.signal} @ ${t.payout}x → ${t.won ? '✅ WIN' : '❌ LOSS'} (Bankroll: ${t.bankroll} BNB)`);
});

db.close();
