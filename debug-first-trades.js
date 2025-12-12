import { initDatabase } from './db-init.js';

const db = initDatabase('./prediction.db');
const rounds = db.prepare(`
  SELECT * FROM rounds
  WHERE t20s_timestamp IS NOT NULL AND winner IS NOT NULL AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC LIMIT 10
`).all();

let bankroll = 1.0;
let consecutiveLosses = 0;

console.log('First 10 trades debug:\n');

for (const r of rounds) {
  const emaSignal = r.ema_signal;
  const bull_wei = parseFloat(r.t20s_bull_wei) / 1e18;
  const bear_wei = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bull_wei + bear_wei;
  const bullPayout = (total * 0.97) / bull_wei;
  const bearPayout = (total * 0.97) / bear_wei;

  let signal = null;
  if (emaSignal === 'BULL' && bearPayout >= 1.45) signal = 'BULL';
  else if (emaSignal === 'BEAR' && bullPayout >= 1.45) signal = 'BEAR';

  if (!signal) {
    console.log(`Epoch ${r.epoch}: SKIPPED (no signal)`);
    continue;
  }

  let posSize = 0.045;
  const emaGap = parseFloat(r.ema_gap) || 0;
  if (Math.abs(emaGap) >= 0.15) posSize *= 1.889;
  if (consecutiveLosses >= 2) posSize *= 1.5;

  const bet = bankroll * posSize;
  const winner = r.winner.toLowerCase();
  const won = (signal === 'BULL' && winner === 'bull') || (signal === 'BEAR' && winner === 'bear');

  console.log(`Epoch ${r.epoch}: ${signal} | EMA:${emaSignal} | Gap:${emaGap}% | PosSize:${(posSize*100).toFixed(1)}% | Bet:${bet.toFixed(4)} | Winner:${winner} | Won:${won}`);

  if (won) {
    const payout = signal === 'BULL' ? bullPayout : bearPayout;
    const profit = bet * payout - bet;
    bankroll += profit;
    consecutiveLosses = 0;
    console.log(`  ✅ Payout:${payout.toFixed(2)}x | Profit:+${profit.toFixed(4)} | New Bankroll:${bankroll.toFixed(4)}`);
  } else {
    bankroll -= bet;
    consecutiveLosses++;
    console.log(`  ❌ Loss:-${bet.toFixed(4)} | New Bankroll:${bankroll.toFixed(4)}`);
  }
}

db.close();
