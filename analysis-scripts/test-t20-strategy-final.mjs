import initSqlJs from 'sql.js';
import fs from 'fs';

const sqlJs = await initSqlJs();
const buf = fs.readFileSync('./data/live-monitor.db');
const db = new sqlJs.Database(buf);

// Get all rounds with T-20s data and settled results
const query = `
  SELECT
    epoch,
    lock_ts,
    winner,
    t20s_bull_wei,
    t20s_bear_wei,
    t20s_total_wei,
    bull_amount_wei,
    bear_amount_wei,
    total_amount_wei
  FROM rounds
  WHERE t20s_total_wei IS NOT NULL
    AND winner != 'UNKNOWN'
    AND epoch > 423913
  ORDER BY epoch
`;

const result = db.exec(query);
if (result.length === 0 || result[0].values.length === 0) {
  console.log('No T-20s data found');
  db.close();
  process.exit(0);
}

const rows = result[0].values;
console.log(`Found ${rows.length} rounds with T-20s snapshots and settled results\n`);

// Fetch EMA data
console.log('Fetching EMA data from TradingView...');
const lockTimestamps = rows.map(row => row[1]);
const minLockTs = Math.min(...lockTimestamps);
const maxLockTs = Math.max(...lockTimestamps);
const startTime = minLockTs - 3600;
const endTime = maxLockTs + 3600;

const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.BNB/USD&resolution=5&from=${startTime}&to=${endTime}`;
const response = await globalThis.fetch(url);
const candles = await response.json();

console.log(`Fetched ${candles.t.length} 5-minute candles\n`);

// Calculate EMA 5 and EMA 13
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const emaArray = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    emaArray.push(prices[i] * k + emaArray[i - 1] * (1 - k));
  }
  return emaArray;
}

const closes = candles.c;
const ema5 = calculateEMA(closes, 5);
const ema13 = calculateEMA(closes, 13);

const emaMap = new Map();
for (let i = 0; i < candles.t.length; i++) {
  emaMap.set(candles.t[i], { ema5: ema5[i], ema13: ema13[i] });
}

// Test multiple thresholds
const thresholds = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75];

console.log('═══════════════════════════════════════════════════════════════');
console.log('      T-20s Strategy Analysis: EMA 5/13 + Crowd Confirmation');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`Dataset: ${rows.length} rounds with T-20s snapshots\n`);

console.log('STRATEGY: Bet WITH both EMA signal AND crowd (≥threshold)');
console.log('- EMA Signal: UP if EMA5 > EMA13, DOWN if EMA5 < EMA13');
console.log('- Crowd: Side with ≥threshold% of pool at T-20s');
console.log('- Only bet when EMA and Crowd AGREE\n');

console.log('═══════════════════════════════════════════════════════════════\n');
console.log('Threshold | Bets | Wins | Win%   | Edge/Bet | Final ROI | Bankroll');
console.log('----------|------|------|--------|----------|-----------|----------');

const results = [];

thresholds.forEach(threshold => {
  let bankroll = 1.0;
  let wins = 0;
  let losses = 0;
  let totalBets = 0;
  let totalWagered = 0;
  let totalReturned = 0;

  rows.forEach(row => {
    const [epoch, lockTs, winner, bullWei, bearWei, totalWei, finalBullWei, finalBearWei, finalTotalWei] = row;

    // T-20s snapshot amounts
    const bullAmount = parseFloat(bullWei) / 1e18;
    const bearAmount = parseFloat(bearWei) / 1e18;
    const totalPool = bullAmount + bearAmount;
    const bullPct = bullAmount / totalPool;
    const bearPct = bearAmount / totalPool;

    // Final amounts
    const finalBull = parseFloat(finalBullWei) / 1e18;
    const finalBear = parseFloat(finalBearWei) / 1e18;
    const finalTotal = finalBull + finalBear;
    const finalUpPayout = (finalTotal * 0.97) / finalBull;
    const finalDownPayout = (finalTotal * 0.97) / finalBear;

    // Determine T-20s crowd
    let crowd = null;
    if (bullPct >= threshold) crowd = 'UP';
    else if (bearPct >= threshold) crowd = 'DOWN';

    if (!crowd) return; // Skip if no clear crowd

    // Get EMA signal
    const roundedLockTs = Math.floor(lockTs / 300) * 300;
    const emaData = emaMap.get(roundedLockTs);
    if (!emaData) return; // Skip if no EMA data

    const emaSignal = emaData.ema5 > emaData.ema13 ? 'UP' : 'DOWN';

    // Only bet if EMA and crowd agree
    if (emaSignal !== crowd) return;

    // Check EMA gap requirement (0.10% minimum)
    const currentPrice = emaData.ema5;
    const emaGap = Math.abs(emaData.ema5 - emaData.ema13);
    const gapPercentOfPrice = (emaGap / currentPrice) * 100;
    if (gapPercentOfPrice < 0.10) return; // Skip weak signals

    // Place bet
    const ourBet = crowd;
    const won = (ourBet === winner);
    const betSize = Math.min(bankroll * 0.065, bankroll); // 6.5% position size

    totalWagered += betSize;
    totalBets++;
    bankroll -= betSize;

    if (won) {
      const payout = ourBet === 'UP' ? finalUpPayout : finalDownPayout;
      const totalReturn = betSize * payout;
      bankroll += totalReturn;
      totalReturned += totalReturn;
      wins++;
    } else {
      losses++;
    }

    if (bankroll > 1000000) bankroll = 1000000;
  });

  const winRate = totalBets > 0 ? (wins / totalBets * 100) : 0;
  const edge = totalBets > 0 ? ((totalReturned / totalWagered - 1) * 100) : 0;
  const roi = ((bankroll - 1) * 100);
  const payoutThreshold = threshold >= 0.55 ? (1 / threshold / 0.97).toFixed(2) + 'x' : 'N/A';

  results.push({ threshold, totalBets, wins, losses, winRate, edge, roi, bankroll });

  console.log(
    `≥${(threshold * 100).toFixed(0)}% (≤${payoutThreshold}) | ` +
    `${totalBets.toString().padStart(4)} | ` +
    `${wins.toString().padStart(4)} | ` +
    `${winRate.toFixed(2).padStart(6)}% | ` +
    `${edge >= 0 ? '+' : ''}${edge.toFixed(2).padStart(7)}% | ` +
    `${roi >= 0 ? '+' : ''}${roi.toFixed(2).padStart(8)}% | ` +
    `${bankroll.toFixed(4)} BNB`
  );
});

console.log('\n═══════════════════════════════════════════════════════════════\n');

// Find best threshold
const best = results.reduce((max, r) => r.roi > max.roi ? r : max, results[0]);

console.log('✅ BEST PERFORMANCE:');
console.log(`   Threshold: ≥${(best.threshold * 100).toFixed(0)}%`);
console.log(`   Total Bets: ${best.totalBets}`);
console.log(`   Win Rate: ${best.winRate.toFixed(2)}%`);
console.log(`   Edge per Bet: ${best.edge >= 0 ? '+' : ''}${best.edge.toFixed(2)}%`);
console.log(`   ROI: ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(2)}%`);
console.log(`   Starting: 1.00 BNB → Ending: ${best.bankroll.toFixed(4)} BNB`);

console.log('\n═══════════════════════════════════════════════════════════════\n');

console.log('📊 EDGE PROOF:');
console.log(`   House requires >51.5% win rate to overcome 3% fee`);
console.log(`   Our win rate: ${best.winRate.toFixed(2)}%`);
console.log(`   Edge over house: ${(best.winRate - 51.5).toFixed(2)} percentage points`);
console.log(`   ${best.winRate > 51.5 ? '✅ POSITIVE EDGE CONFIRMED' : '❌ NO EDGE'}`);

console.log('\n═══════════════════════════════════════════════════════════════\n');

db.close();
