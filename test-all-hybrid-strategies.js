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
  return { upper, lower, avg, position };
}

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

function calculateMomentum(prices, period = 10) {
  if (prices.length < period + 1) return null;
  const oldPrice = prices[prices.length - period - 1];
  const currentPrice = prices[prices.length - 1];
  return ((currentPrice - oldPrice) / oldPrice) * 100;
}

function calculateStochastic(prices, period = 14) {
  if (prices.length < period) return null;
  const recentPrices = prices.slice(-period);
  const high = Math.max(...recentPrices);
  const low = Math.min(...recentPrices);
  const current = prices[prices.length - 1];

  if (high === low) return 50;
  return ((current - low) / (high - low)) * 100;
}

const rounds = db.prepare(`
  SELECT epoch, close_price, winner, t20s_bull_wei, t20s_bear_wei
  FROM rounds
  WHERE close_price IS NOT NULL
    AND winner IS NOT NULL
    AND t20s_bull_wei IS NOT NULL
  ORDER BY epoch ASC
`).all();

console.log('🔬 Testing MULTIPLE mean reversion indicators\n');

const strategies = [
  // BB variations
  { name: 'BB(14,2.5,30/70)', bb: [14, 2.5, 30, 70], minPay: 1.7 },
  { name: 'BB(14,2.0,25/75)', bb: [14, 2.0, 25, 75], minPay: 1.7 },
  { name: 'BB(20,2.0,30/70)', bb: [20, 2.0, 30, 70], minPay: 1.6 },
  { name: 'BB(10,2.5,25/75)', bb: [10, 2.5, 25, 75], minPay: 1.6 },

  // RSI
  { name: 'RSI(14,30/70)', rsi: [14, 30, 70], minPay: 1.6 },
  { name: 'RSI(14,25/75)', rsi: [14, 25, 75], minPay: 1.6 },
  { name: 'RSI(10,30/70)', rsi: [10, 30, 70], minPay: 1.6 },
  { name: 'RSI(20,35/65)', rsi: [20, 35, 65], minPay: 1.7 },

  // Stochastic
  { name: 'Stoch(14,20/80)', stoch: [14, 20, 80], minPay: 1.6 },
  { name: 'Stoch(14,25/75)', stoch: [14, 25, 75], minPay: 1.6 },
  { name: 'Stoch(10,20/80)', stoch: [10, 20, 80], minPay: 1.5 },

  // Momentum
  { name: 'Mom(10,-1.0/+1.0)', mom: [10, -1.0, 1.0], minPay: 1.5 },
  { name: 'Mom(14,-0.8/+0.8)', mom: [14, -0.8, 0.8], minPay: 1.6 },
  { name: 'Mom(20,-1.2/+1.2)', mom: [20, -1.2, 1.2], minPay: 1.6 },

  // Combined
  { name: 'BB+RSI(14)', combo: 'bb_rsi', minPay: 1.7 },
  { name: 'BB+Stoch(14)', combo: 'bb_stoch', minPay: 1.6 },
  { name: 'RSI+Stoch(14)', combo: 'rsi_stoch', minPay: 1.6 },
];

const results = [];

for (const strat of strategies) {
  const priceHistory = [];
  let wins = 0, total = 0;
  let totalProfit = 0;

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

    // BB strategy
    if (strat.bb) {
      const [period, stdDev, lower, upper] = strat.bb;
      const bb = calculateBollingerBands(priceHistory, period, stdDev);
      if (bb && !isNaN(bb.position)) {
        if (bb.position < lower && bullPayout >= strat.minPay) {
          signal = 'BULL';
          payout = bullPayout;
        } else if (bb.position > upper && bearPayout >= strat.minPay) {
          signal = 'BEAR';
          payout = bearPayout;
        }
      }
    }

    // RSI strategy
    if (strat.rsi) {
      const [period, lower, upper] = strat.rsi;
      const rsi = calculateRSI(priceHistory, period);
      if (rsi !== null && !isNaN(rsi)) {
        if (rsi < lower && bullPayout >= strat.minPay) {
          signal = 'BULL';
          payout = bullPayout;
        } else if (rsi > upper && bearPayout >= strat.minPay) {
          signal = 'BEAR';
          payout = bearPayout;
        }
      }
    }

    // Stochastic strategy
    if (strat.stoch) {
      const [period, lower, upper] = strat.stoch;
      const stoch = calculateStochastic(priceHistory, period);
      if (stoch !== null && !isNaN(stoch)) {
        if (stoch < lower && bullPayout >= strat.minPay) {
          signal = 'BULL';
          payout = bullPayout;
        } else if (stoch > upper && bearPayout >= strat.minPay) {
          signal = 'BEAR';
          payout = bearPayout;
        }
      }
    }

    // Momentum strategy
    if (strat.mom) {
      const [period, lower, upper] = strat.mom;
      const mom = calculateMomentum(priceHistory, period);
      if (mom !== null && !isNaN(mom)) {
        if (mom < lower && bullPayout >= strat.minPay) {
          signal = 'BULL';
          payout = bullPayout;
        } else if (mom > upper && bearPayout >= strat.minPay) {
          signal = 'BEAR';
          payout = bearPayout;
        }
      }
    }

    // Combined strategies
    if (strat.combo === 'bb_rsi') {
      const bb = calculateBollingerBands(priceHistory, 14, 2.5);
      const rsi = calculateRSI(priceHistory, 14);
      if (bb && rsi && !isNaN(bb.position) && !isNaN(rsi)) {
        if ((bb.position < 30 || rsi < 30) && bullPayout >= strat.minPay) {
          signal = 'BULL';
          payout = bullPayout;
        } else if ((bb.position > 70 || rsi > 70) && bearPayout >= strat.minPay) {
          signal = 'BEAR';
          payout = bearPayout;
        }
      }
    }

    if (strat.combo === 'bb_stoch') {
      const bb = calculateBollingerBands(priceHistory, 14, 2.5);
      const stoch = calculateStochastic(priceHistory, 14);
      if (bb && stoch && !isNaN(bb.position) && !isNaN(stoch)) {
        if ((bb.position < 30 || stoch < 25) && bullPayout >= strat.minPay) {
          signal = 'BULL';
          payout = bullPayout;
        } else if ((bb.position > 70 || stoch > 75) && bearPayout >= strat.minPay) {
          signal = 'BEAR';
          payout = bearPayout;
        }
      }
    }

    if (strat.combo === 'rsi_stoch') {
      const rsi = calculateRSI(priceHistory, 14);
      const stoch = calculateStochastic(priceHistory, 14);
      if (rsi && stoch && !isNaN(rsi) && !isNaN(stoch)) {
        if ((rsi < 30 || stoch < 25) && bullPayout >= strat.minPay) {
          signal = 'BULL';
          payout = bullPayout;
        } else if ((rsi > 70 || stoch > 75) && bearPayout >= strat.minPay) {
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
    const avgProfit = totalProfit / total;
    results.push({
      name: strat.name,
      total,
      wins,
      wr,
      totalProfit,
      avgProfit
    });
  }
}

results.sort((a, b) => b.totalProfit - a.totalProfit);

console.log('📊 MEAN REVERSION STRATEGIES (sorted by total profit):\n');
console.log('Strategy              │ Trades │ Wins │  WR   │ Total P │ Avg P/T');
console.log('──────────────────────┼────────┼──────┼───────┼─────────┼────────');

results.forEach(r => {
  console.log(
    `${r.name.padEnd(21)} │ ${String(r.total).padStart(6)} │ ${String(r.wins).padStart(4)} │ ${r.wr.toFixed(1).padStart(5)}% │ ${r.totalProfit.toFixed(1).padStart(7)} │ ${r.avgProfit.toFixed(3).padStart(7)}`
  );
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const best = results[0];
console.log(`🏆 BEST: ${best.name}`);
console.log(`   ${best.total} trades, ${best.wr.toFixed(1)}% WR, ${best.totalProfit.toFixed(1)} profit\n`);

const goodOnes = results.filter(r => r.wr >= 55 && r.total >= 50);
if (goodOnes.length > 0) {
  console.log(`✅ ${goodOnes.length} strategies with ≥55% WR and ≥50 trades`);
  console.log(`Top picks for hybrid:`);
  goodOnes.slice(0, 3).forEach(r => {
    console.log(`   - ${r.name}: ${r.total} trades, ${r.wr.toFixed(1)}% WR`);
  });
} else {
  console.log(`⚠️ No strategy has both ≥55% WR AND ≥50 trades`);
}
