import Database from 'better-sqlite3';
const db = new Database('./prediction.db');

const now = Math.floor(Date.now() / 1000);
const twoHoursAgo = now - (2 * 60 * 60);

const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE lock_timestamp >= ?
    AND t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all(twoHoursAgo);

console.log(`📊 DEBUG: ${rounds.length} rounds in last 2 hours\n`);

function calculatePayouts(bullWei, bearWei, totalWei) {
  const bull = BigInt(bullWei);
  const bear = BigInt(bearWei);
  const total = BigInt(totalWei);

  const bullPayout = bull > 0n ? Number(total * 97n / (bull * 100n)) / 100 : 0;
  const bearPayout = bear > 0n ? Number(total * 97n / (bear * 100n)) / 100 : 0;

  return { bullPayout, bearPayout };
}

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

// Only analyze if we have at least 7 rounds for EMA
if (rounds.length >= 7) {
  for (let i = 6; i < Math.min(10, rounds.length); i++) {
    const window = rounds.slice(i - 6, i + 1);
    const lockPrices = window.map(r => parseFloat(r.lock_price));

    const ema3 = calculateEMA(lockPrices, 3);
    const ema7 = calculateEMA(lockPrices, 7);

    const currentEma3 = ema3[ema3.length - 1];
    const currentEma7 = ema7[ema7.length - 1];
    const emaGap = Math.abs(currentEma3 - currentEma7) / currentEma7;

    const current = window[window.length - 1];
    const payouts = calculatePayouts(
      current.t20s_bull_wei,
      current.t20s_bear_wei,
      current.t20s_total_wei
    );

    const emaSignal = currentEma3 > currentEma7 ? 'BULL' : 'BEAR';
    const contraBull = currentEma3 < currentEma7 && payouts.bullPayout >= 1.45;
    const contraBear = currentEma3 > currentEma7 && payouts.bearPayout >= 1.45;
    const hasTrade = contraBull || contraBear;

    console.log(`\nEpoch ${current.epoch}:`);
    console.log(`  Lock Price: $${current.lock_price}`);
    console.log(`  EMA3: $${currentEma3.toFixed(2)} | EMA7: $${currentEma7.toFixed(2)}`);
    console.log(`  EMA Signal: ${emaSignal} | Gap: ${(emaGap * 100).toFixed(3)}%`);
    console.log(`  T20s Payouts: Bull ${payouts.bullPayout.toFixed(2)}x | Bear ${payouts.bearPayout.toFixed(2)}x`);
    console.log(`  Contrarian Bull Opportunity: ${contraBull ? '✅ YES' : '❌ NO'}`);
    console.log(`  Contrarian Bear Opportunity: ${contraBear ? '✅ YES' : '❌ NO'}`);
    console.log(`  Winner: ${current.winner} @ ${current.winner_payout_multiple.toFixed(2)}x`);
    console.log(`  ${hasTrade ? '🎯 TRADE SIGNAL' : '⏭️  NO TRADE'}`);
  }
} else {
  console.log(`❌ Need at least 7 rounds for EMA calculation, only have ${rounds.length}`);
}

db.close();
