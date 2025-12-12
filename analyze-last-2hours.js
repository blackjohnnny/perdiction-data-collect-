import Database from 'better-sqlite3';
const db = new Database('./prediction.db');

// Get current time and 2 hours ago
const now = Math.floor(Date.now() / 1000);
const twoHoursAgo = now - (2 * 60 * 60);

// Get all complete rounds from last 2 hours
const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE lock_timestamp >= ?
    AND t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND winner_payout_multiple IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all(twoHoursAgo);

// Helper function to calculate payout from wei amounts
function calculatePayouts(bullWei, bearWei, totalWei) {
  const bull = BigInt(bullWei);
  const bear = BigInt(bearWei);
  const total = BigInt(totalWei);

  const bullPayout = bull > 0n ? Number(total * 97n / (bull * 100n)) / 100 : 0;
  const bearPayout = bear > 0n ? Number(total * 97n / (bear * 100n)) / 100 : 0;

  return { bullPayout, bearPayout };
}

console.log(`📊 ANALYZING ${rounds.length} COMPLETE ROUNDS FROM LAST 2 HOURS\n`);

// Calculate EMAs
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

// Strategy simulation
let bankroll = 1000;
let trades = [];
let wins = 0, losses = 0;
const BASE_SIZE = 0.045;
const MOMENTUM_SIZE = 0.085;
const RECOVERY_MULTIPLIER = 1.5;
const MIN_PAYOUT = 1.45;
const MOMENTUM_THRESHOLD = 0.0015;

for (let i = 6; i < rounds.length; i++) {
  const window = rounds.slice(i - 6, i + 1);
  const lockPrices = window.map(r => parseFloat(r.lock_price));

  const ema3 = calculateEMA(lockPrices, 3);
  const ema7 = calculateEMA(lockPrices, 7);

  const currentEma3 = ema3[ema3.length - 1];
  const currentEma7 = ema7[ema7.length - 1];
  const emaGap = Math.abs(currentEma3 - currentEma7) / currentEma7;

  const current = window[window.length - 1];

  // Calculate payouts from wei amounts
  const payouts = calculatePayouts(
    current.t20s_bull_wei,
    current.t20s_bear_wei,
    current.t20s_total_wei
  );
  const bullPayout = payouts.bullPayout;
  const bearPayout = payouts.bearPayout;

  // Determine signal
  let signal = null;
  let contrarian = false;

  if (currentEma3 > currentEma7 && bearPayout >= MIN_PAYOUT) {
    signal = 'bear';
    contrarian = true;
  } else if (currentEma3 < currentEma7 && bullPayout >= MIN_PAYOUT) {
    signal = 'bull';
    contrarian = true;
  }

  if (!signal) continue;

  // Position sizing
  const lastTrade = trades[trades.length - 1];
  const lastWasLoss = lastTrade && !lastTrade.won;
  const hasMomentum = emaGap >= MOMENTUM_THRESHOLD;

  let sizePercent = hasMomentum ? MOMENTUM_SIZE : BASE_SIZE;
  if (lastWasLoss) sizePercent *= RECOVERY_MULTIPLIER;

  const betSize = bankroll * sizePercent;
  const payout = signal === 'bull' ? bullPayout : bearPayout;
  const won = current.winner === signal;
  const profit = won ? betSize * (payout - 1) : -betSize;

  bankroll += profit;
  if (won) wins++;
  else losses++;

  trades.push({
    epoch: current.epoch,
    lockTime: new Date(current.lock_timestamp * 1000).toLocaleTimeString(),
    signal,
    contrarian,
    hasMomentum,
    betSize: betSize.toFixed(2),
    payout: payout.toFixed(2),
    won,
    profit: profit.toFixed(2),
    bankroll: bankroll.toFixed(2),
    emaGap: (emaGap * 100).toFixed(3)
  });
}

// Display results
console.log('📈 STRATEGY PERFORMANCE:\n');
console.log(`Total Trades: ${trades.length}`);
console.log(`Wins: ${wins} | Losses: ${losses}`);
console.log(`Win Rate: ${((wins / trades.length) * 100).toFixed(2)}%`);
console.log(`ROI: ${(((bankroll - 1000) / 1000) * 100).toFixed(2)}%`);
console.log(`Final Bankroll: $${bankroll.toFixed(2)}`);
console.log(`Profit: $${(bankroll - 1000).toFixed(2)}\n`);

// Trade details
console.log('📋 TRADE DETAILS:\n');
trades.forEach(t => {
  const result = t.won ? '✅ WIN' : '❌ LOSS';
  const momentum = t.hasMomentum ? '🔥' : '  ';
  console.log(`${result} ${momentum} Epoch ${t.epoch} ${t.lockTime}`);
  console.log(`  ${t.signal.toUpperCase()} @ ${t.payout}x | Bet: $${t.betSize} | P/L: $${t.profit} | Bank: $${t.bankroll}`);
  console.log(`  EMA Gap: ${t.emaGap}%\n`);
});

// Additional stats
const contrarians = trades.filter(t => t.contrarian).length;
const momentumTrades = trades.filter(t => t.hasMomentum).length;
const emaAligned = trades.filter(t => t.won).length;

console.log('📊 ADDITIONAL STATS:\n');
console.log(`Contrarian Trades: ${contrarians} (${((contrarians / trades.length) * 100).toFixed(1)}%)`);
console.log(`Momentum Trades: ${momentumTrades} (${((momentumTrades / trades.length) * 100).toFixed(1)}%)`);
console.log(`Base Size Trades: ${trades.length - momentumTrades} (${(((trades.length - momentumTrades) / trades.length) * 100).toFixed(1)}%)`);

db.close();
