import initSqlJs from 'sql.js';
import fs from 'fs';

const sqlJs = await initSqlJs();
const buf = fs.readFileSync('../data/live-monitor.db');
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

// Test multiple thresholds and EMA gaps
const thresholds = [0.55, 0.60, 0.65, 0.70, 0.75];
const emaGaps = [0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18]; // % gap required - focusing around 0.10%

console.log('═══════════════════════════════════════════════════════════════════════════');
console.log('   T-20s Strategy Analysis: EMA 5/13 Gap Filter + Crowd (6.5% Position)');
console.log('═══════════════════════════════════════════════════════════════════════════\n');

console.log(`Dataset: ${rows.length} rounds with T-20s snapshots`);
console.log(`Position Size: 6.5% per trade\n`);

console.log('STRATEGY: Bet WITH both EMA signal AND crowd (≥threshold) + EMA Gap Filter');
console.log('- EMA Signal: UP if EMA5 > EMA13, DOWN if EMA5 < EMA13');
console.log('- EMA Gap: |EMA5 - EMA13| / Price >= gap% (filters weak signals)');
console.log('- Crowd: Side with ≥threshold% of pool at T-20s');
console.log('- Only bet when EMA and Crowd AGREE + Gap requirement met\n');

console.log('═══════════════════════════════════════════════════════════════════════════\n');

const allResults = [];

thresholds.forEach(threshold => {
  console.log(`\n${'═'.repeat(79)}`);
  console.log(`CROWD THRESHOLD: ≥${(threshold * 100).toFixed(0)}%`);
  console.log('═'.repeat(79));
  console.log('EMA Gap | Bets | Wins | Win%   | Edge/Bet | ROI      | Bankroll');
  console.log('--------|------|------|--------|----------|----------|----------');

  emaGaps.forEach(gapPercent => {
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

      // Check EMA gap requirement
      const currentPrice = closes[candles.t.indexOf(roundedLockTs)];
      if (!currentPrice) return;

      const emaGap = Math.abs(emaData.ema5 - emaData.ema13);
      const gapPercentOfPrice = (emaGap / currentPrice) * 100;

      if (gapPercentOfPrice < gapPercent) return; // Skip if gap too small

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
      if (bankroll < 0.0001) bankroll = 0.0001;
    });

    const winRate = totalBets > 0 ? (wins / totalBets * 100) : 0;
    const edge = totalBets > 0 ? ((totalReturned / totalWagered - 1) * 100) : 0;
    const roi = ((bankroll - 1) * 100);

    allResults.push({
      threshold,
      gapPercent,
      totalBets,
      wins,
      losses,
      winRate,
      edge,
      roi,
      bankroll
    });

    const gapLabel = gapPercent === 0 ? 'None   ' : `≥${gapPercent.toFixed(2)}%`;
    console.log(
      `${gapLabel} | ${String(totalBets).padStart(4)} | ${String(wins).padStart(4)} | ` +
      `${winRate.toFixed(2).padStart(6)}% | ${edge >= 0 ? '+' : ''}${edge.toFixed(2).padStart(7)}% | ` +
      `${roi >= 0 ? '+' : ''}${roi.toFixed(2).padStart(7)}% | ${bankroll.toFixed(4)} BNB`
    );
  });
});

// Find best overall
console.log('\n\n' + '═'.repeat(79));
console.log('BEST RESULTS ACROSS ALL COMBINATIONS');
console.log('═'.repeat(79));

const sorted = allResults.sort((a, b) => b.roi - a.roi);
const top5 = sorted.slice(0, 5);

console.log('\nTop 5 by ROI:');
console.log('Crowd   | EMA Gap | Bets | Wins | Win%   | ROI      | Bankroll');
console.log('--------|---------|------|------|--------|----------|----------');

top5.forEach(r => {
  const gapLabel = r.gapPercent === 0 ? 'None' : `≥${r.gapPercent}%`;
  console.log(
    `≥${(r.threshold * 100).toFixed(0)}%`.padEnd(8) + '| ' +
    gapLabel.padEnd(8) + '| ' +
    String(r.totalBets).padStart(4) + ' | ' +
    String(r.wins).padStart(4) + ' | ' +
    `${r.winRate.toFixed(2).padStart(6)}% | ` +
    `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2).padStart(7)}% | ` +
    `${r.bankroll.toFixed(4)} BNB`
  );
});

console.log('\n' + '═'.repeat(79));

db.close();
