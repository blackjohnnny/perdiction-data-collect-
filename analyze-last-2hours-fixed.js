import Database from 'better-sqlite3';
const db = new Database('./prediction.db');

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
    AND (lock_price IS NOT NULL AND CAST(lock_price AS REAL) > 0 OR close_price IS NOT NULL AND CAST(close_price AS REAL) > 0)
  ORDER BY lock_timestamp ASC
`).all(twoHoursAgo);

console.log(`📊 ANALYZING ${rounds.length} COMPLETE ROUNDS WITH PRICE DATA FROM LAST 2 HOURS\n`);

// Use close_price if lock_price is 0, convert from wei to USD
function getPrice(round) {
  const lock = parseFloat(round.lock_price);
  const close = parseFloat(round.close_price);

  // If lock_price looks like wei (very large number), convert it
  if (lock > 1000000) return lock / 1e18;
  if (lock > 0) return lock;

  // Try close_price
  if (close > 1000000) return close / 1e18;
  if (close > 0) return close;

  return null;
}

// Helper function to calculate payout from wei amounts
function calculatePayouts(bullWei, bearWei, totalWei) {
  const bull = BigInt(bullWei);
  const bear = BigInt(bearWei);
  const total = BigInt(totalWei);

  const bullPayout = bull > 0n ? Number(total * 97n / (bull * 100n)) / 100 : 0;
  const bearPayout = bear > 0n ? Number(total * 97n / (bear * 100n)) / 100 : 0;

  return { bullPayout, bearPayout };
}

// Calculate EMAs
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

// Get prices for all rounds
const roundsWithPrices = rounds.map(r => ({...r, price: getPrice(r)})).filter(r => r.price !== null);

console.log(`Found ${roundsWithPrices.length} rounds with valid price data\n`);

if (roundsWithPrices.length < 7) {
  console.log(`❌ Need at least 7 rounds for EMA calculation, only have ${roundsWithPrices.length}`);
  console.log(`\nShowing available rounds:`);
  roundsWithPrices.forEach(r => {
    const payouts = calculatePayouts(r.t20s_bull_wei, r.t20s_bear_wei, r.t20s_total_wei);
    console.log(`\nEpoch ${r.epoch}:`);
    console.log(`  Price: $${r.price.toFixed(2)}`);
    console.log(`  T20s Payouts: Bull ${payouts.bullPayout.toFixed(2)}x | Bear ${payouts.bearPayout.toFixed(2)}x`);
    console.log(`  Winner: ${r.winner} @ ${r.winner_payout_multiple.toFixed(2)}x`);
  });
  db.close();
  process.exit(0);
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

for (let i = 6; i < roundsWithPrices.length; i++) {
  const window = roundsWithPrices.slice(i - 6, i + 1);
  const prices = window.map(r => r.price);

  const ema3 = calculateEMA(prices, 3);
  const ema7 = calculateEMA(prices, 7);

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

  // Determine signal - Bet WITH the trend, AGAINST the crowd
  let signal = null;
  let contrarian = false;

  // If EMA is bullish (EMA3 > EMA7) and crowd is bearish (bear payout high), bet BULL
  if (currentEma3 > currentEma7 && bearPayout >= MIN_PAYOUT) {
    signal = 'bull';
    contrarian = true;
  }
  // If EMA is bearish (EMA3 < EMA7) and crowd is bullish (bull payout high), bet BEAR
  else if (currentEma3 < currentEma7 && bullPayout >= MIN_PAYOUT) {
    signal = 'bear';
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
if (trades.length > 0) {
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

  console.log('📊 ADDITIONAL STATS:\n');
  console.log(`Contrarian Trades: ${contrarians} (${((contrarians / trades.length) * 100).toFixed(1)}%)`);
  console.log(`Momentum Trades: ${momentumTrades} (${((momentumTrades / trades.length) * 100).toFixed(1)}%)`);
  console.log(`Base Size Trades: ${trades.length - momentumTrades} (${(((trades.length - momentumTrades) / trades.length) * 100).toFixed(1)}%)`);
} else {
  console.log('❌ NO TRADE OPPORTUNITIES FOUND');
  console.log('\n💡 Strategy: Bet WITH the trend, AGAINST the crowd');
  console.log('  - EMA3 > EMA7 (bullish trend) AND Bear payout ≥ 1.45x (crowd bearish) → Bet BULL');
  console.log('  - EMA3 < EMA7 (bearish trend) AND Bull payout ≥ 1.45x (crowd bullish) → Bet BEAR');
  console.log('\nNone of the rounds in the last 2 hours met these criteria.');
}

db.close();
