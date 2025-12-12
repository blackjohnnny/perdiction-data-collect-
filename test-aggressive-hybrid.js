import { initDatabase } from './db-init.js';

const db = initDatabase();

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const changes = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? -c : 0);
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

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
  return { upper, lower, avg, position };
}

const rounds = db.prepare(`
  SELECT epoch, close_price, winner, t20s_bull_wei, t20s_bear_wei
  FROM rounds
  WHERE close_price IS NOT NULL
    AND winner IS NOT NULL
    AND t20s_bull_wei IS NOT NULL
  ORDER BY epoch ASC
`).all();

console.log('🔬 Testing AGGRESSIVE hybrid strategies (more trades, lower payouts)\n');

const configs = [
  // Lower payout thresholds
  { name: 'RSI(14,30/70) ≥1.4x', rsi: [14, 30, 70], minPay: 1.4 },
  { name: 'RSI(14,35/65) ≥1.4x', rsi: [14, 35, 65], minPay: 1.4 },
  { name: 'RSI(14,40/60) ≥1.3x', rsi: [14, 40, 60], minPay: 1.3 },
  { name: 'BB(14,2.0,30/70) ≥1.4x', bb: [14, 2.0, 30, 70], minPay: 1.4 },
  { name: 'BB(14,2.0,35/65) ≥1.4x', bb: [14, 2.0, 35, 65], minPay: 1.4 },
  { name: 'BB(20,2.0,30/70) ≥1.4x', bb: [20, 2.0, 30, 70], minPay: 1.4 },

  // Combined with AND logic (more conservative)
  { name: 'RSI<30 AND BB<30 ≥1.5x', combo: 'rsi_bb_and', minPay: 1.5 },
  { name: 'RSI<35 AND BB<35 ≥1.4x', combo: 'rsi_bb_and_loose', minPay: 1.4 },
];

const results = [];

for (const config of configs) {
  const priceHistory = [];
  let wins = 0, total = 0, totalProfit = 0;

  for (const r of rounds) {
    priceHistory.push(r.close_price);
    if (priceHistory.length > 50) priceHistory.shift();
    if (priceHistory.length < 20) continue;

    const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;
    if (totalAmount === 0) continue;

    const bullPayout = totalAmount / bullAmount;
    const bearPayout = totalAmount / bearAmount;

    let signal = null;
    let payout = 0;

    if (config.rsi) {
      const [period, lower, upper] = config.rsi;
      const rsi = calculateRSI(priceHistory, period);
      if (rsi !== null && !isNaN(rsi)) {
        if (rsi < lower && bullPayout >= config.minPay) {
          signal = 'BULL';
          payout = bullPayout;
        } else if (rsi > upper && bearPayout >= config.minPay) {
          signal = 'BEAR';
          payout = bearPayout;
        }
      }
    }

    if (config.bb) {
      const [period, stdDev, lower, upper] = config.bb;
      const bb = calculateBollingerBands(priceHistory, period, stdDev);
      if (bb && !isNaN(bb.position)) {
        if (bb.position < lower && bullPayout >= config.minPay) {
          signal = 'BULL';
          payout = bullPayout;
        } else if (bb.position > upper && bearPayout >= config.minPay) {
          signal = 'BEAR';
          payout = bearPayout;
        }
      }
    }

    if (config.combo === 'rsi_bb_and') {
      const rsi = calculateRSI(priceHistory, 14);
      const bb = calculateBollingerBands(priceHistory, 14, 2.0);
      if (rsi && bb && !isNaN(rsi) && !isNaN(bb.position)) {
        if (rsi < 30 && bb.position < 30 && bullPayout >= config.minPay) {
          signal = 'BULL';
          payout = bullPayout;
        } else if (rsi > 70 && bb.position > 70 && bearPayout >= config.minPay) {
          signal = 'BEAR';
          payout = bearPayout;
        }
      }
    }

    if (config.combo === 'rsi_bb_and_loose') {
      const rsi = calculateRSI(priceHistory, 14);
      const bb = calculateBollingerBands(priceHistory, 14, 2.0);
      if (rsi && bb && !isNaN(rsi) && !isNaN(bb.position)) {
        if (rsi < 35 && bb.position < 35 && bullPayout >= config.minPay) {
          signal = 'BULL';
          payout = bullPayout;
        } else if (rsi > 65 && bb.position > 65 && bearPayout >= config.minPay) {
          signal = 'BEAR';
          payout = bearPayout;
        }
      }
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

  if (total > 0) {
    const wr = (wins / total * 100);
    results.push({
      name: config.name,
      total,
      wins,
      wr,
      totalProfit,
      avgProfit: totalProfit / total
    });
  }
}

results.sort((a, b) => {
  // Prioritize ≥52% WR with most trades
  const aGood = a.wr >= 52;
  const bGood = b.wr >= 52;
  if (aGood && !bGood) return -1;
  if (!aGood && bGood) return 1;
  return b.total - a.total;
});

console.log('📊 AGGRESSIVE HYBRID STRATEGIES:\n');
console.log('Strategy                      │ Trades │ Wins │  WR   │ Total P │ Avg P/T');
console.log('──────────────────────────────┼────────┼──────┼───────┼─────────┼────────');

results.forEach(r => {
  const wrMark = r.wr >= 52 ? ' ✅' : '';
  console.log(
    `${r.name.padEnd(29)} │ ${String(r.total).padStart(6)} │ ${String(r.wins).padStart(4)} │ ${r.wr.toFixed(1).padStart(5)}%${wrMark} │ ${r.totalProfit.toFixed(1).padStart(7)} │ ${r.avgProfit.toFixed(3).padStart(7)}`
  );
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const goodOnes = results.filter(r => r.wr >= 52 && r.total >= 100);
if (goodOnes.length > 0) {
  console.log(`✅ Found ${goodOnes.length} strategies with ≥52% WR and ≥100 trades:\n`);
  goodOnes.forEach((r, i) => {
    console.log(`${i + 1}. ${r.name}: ${r.total} trades, ${r.wr.toFixed(1)}% WR, ${r.totalProfit.toFixed(1)} profit`);
  });
} else {
  console.log(`❌ No strategy achieves ≥52% WR with ≥100 trades`);
  console.log(`\nBest compromise:`);
  const best = results[0];
  console.log(`   ${best.name}: ${best.total} trades, ${best.wr.toFixed(1)}% WR`);
}
