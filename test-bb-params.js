import { initDatabase } from './db-init.js';

const db = initDatabase();

function calculateBollingerBands(prices, period, stdDevMult) {
  if (prices.length < period) return null;
  const recentPrices = prices.slice(-period);
  const avg = recentPrices.reduce((a, b) => a + b, 0) / period;
  const variance = recentPrices.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = avg + (stdDevMult * stdDev);
  const lower = avg - (stdDevMult * stdDev);
  const currentPrice = prices[prices.length - 1];
  const position = ((currentPrice - lower) / (upper - lower)) * 100;
  return { upper, lower, avg, position, currentPrice, stdDev };
}

const rounds = db.prepare(`
  SELECT epoch, close_price, winner, t20s_bull_wei, t20s_bear_wei
  FROM rounds
  WHERE close_price IS NOT NULL
    AND winner IS NOT NULL
    AND t20s_bull_wei IS NOT NULL
  ORDER BY epoch ASC
`).all();

console.log('🔬 Testing BB parameters for mean reversion\n');

const results = [];

// Test different BB configurations
for (const period of [8, 10, 14, 20]) {
  for (const stdDev of [1.5, 2.0, 2.5]) {
    for (const lowerThresh of [20, 25, 30, 35]) {
      for (const upperThresh of [65, 70, 75, 80]) {
        for (const minPayout of [1.50, 1.60, 1.70]) {

          const priceHistory = [];
          let wins = 0, total = 0;
          let totalProfit = 0;

          for (const r of rounds) {
            priceHistory.push(r.close_price);
            if (priceHistory.length > 50) priceHistory.shift();

            if (priceHistory.length < period) continue;

            const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
            const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
            const totalAmount = bullAmount + bearAmount;

            if (totalAmount === 0) continue;

            const bullPayout = totalAmount / bullAmount;
            const bearPayout = totalAmount / bearAmount;

            const bb = calculateBollingerBands(priceHistory, period, stdDev);
            if (!bb || isNaN(bb.position)) continue;

            let signal = null;
            let payout = 0;

            if (bb.position < lowerThresh && bullPayout >= minPayout) {
              signal = 'BULL';
              payout = bullPayout;
            } else if (bb.position > upperThresh && bearPayout >= minPayout) {
              signal = 'BEAR';
              payout = bearPayout;
            }

            if (!signal) continue;

            const won = (signal === 'BULL' && r.winner === 'bull') || (signal === 'BEAR' && r.winner === 'bear');

            if (won) {
              wins++;
              totalProfit += (payout - 1);
            } else {
              totalProfit -= 1;
            }
            total++;
          }

          if (total > 30) { // At least 30 trades for statistical significance
            const wr = (wins / total * 100);
            const avgProfit = totalProfit / total;

            results.push({
              period,
              stdDev,
              lowerThresh,
              upperThresh,
              minPayout,
              total,
              wins,
              wr,
              avgProfit,
              totalProfit
            });
          }
        }
      }
    }
  }
}

// Sort by win rate first, then profit
results.sort((a, b) => b.wr - a.wr || b.totalProfit - a.totalProfit);

console.log('📊 TOP 20 BB CONFIGURATIONS (by win rate):\n');
console.log('Period │ StdDev │ Lower │ Upper │ MinPay │ Trades │  WR   │ Profit │ Avg P/T');
console.log('───────┼────────┼───────┼───────┼────────┼────────┼───────┼────────┼────────');

results.slice(0, 20).forEach(r => {
  console.log(
    `${String(r.period).padStart(6)} │ ${r.stdDev.toFixed(1).padStart(6)} │ ${String(r.lowerThresh).padStart(5)} │ ${String(r.upperThresh).padStart(5)} │ ${r.minPayout.toFixed(2).padStart(6)} │ ${String(r.total).padStart(6)} │ ${r.wr.toFixed(1).padStart(5)}% │ ${r.totalProfit.toFixed(1).padStart(6)} │ ${r.avgProfit.toFixed(3).padStart(7)}`
  );
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const best = results[0];
console.log('🏆 BEST BB CONFIGURATION:\n');
console.log(`Period: ${best.period}`);
console.log(`Std Dev Multiplier: ${best.stdDev}x`);
console.log(`Lower Threshold: ${best.lowerThresh}% (oversold)`);
console.log(`Upper Threshold: ${best.upperThresh}% (overbought)`);
console.log(`Min Payout: ${best.minPayout}x`);
console.log(`\nPerformance:`);
console.log(`  Trades: ${best.total}`);
console.log(`  Win Rate: ${best.wr.toFixed(1)}%`);
console.log(`  Total Profit: ${best.totalProfit.toFixed(1)} units`);
console.log(`  Avg Profit/Trade: ${best.avgProfit.toFixed(3)}`);

if (best.wr < 55) {
  console.log(`\n❌ PROBLEM: Even best BB config has <55% WR`);
  console.log(`This confirms BB mean reversion doesn't work well during cooldowns.`);
} else {
  console.log(`\n✅ Found profitable BB configuration!`);
}
