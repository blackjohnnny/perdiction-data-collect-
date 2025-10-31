import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const dbBuffer = readFileSync('./data/live.db');
const db = new SQL.Database(dbBuffer);

const roundsData = db.exec(`
  SELECT epoch, lock_ts, lock_price, close_price, winner, t20s_bull_wei, t20s_bear_wei, t20s_total_wei,
         bull_amount_wei, bear_amount_wei, total_amount_wei
  FROM rounds
  ORDER BY epoch ASC
`)[0];

const rounds = roundsData.values;

// Fetch TradingView candles
const lockTimes = rounds.map(r => r[1]);
const startTime = Math.min(...lockTimes) - 3600;
const endTime = Math.max(...lockTimes) + 3600;

console.log('Fetching TradingView data...');
const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.BNB/USD&resolution=5&from=${startTime}&to=${endTime}`;
const response = await globalThis.fetch(url);
const candles = await response.json();

const candleMap = new Map();
for (let i = 0; i < candles.t.length; i++) {
  candleMap.set(candles.t[i], candles.c[i]);
}

// Calculate EMAs
function calculateEMA(prices, period) {
  const multiplier = 2 / (period + 1);
  let ema = prices[0];
  const result = [ema];
  for (let i = 1; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
    result.push(ema);
  }
  return result;
}

const sortedCandles = Array.from(candleMap.entries()).sort((a, b) => a[0] - b[0]);
const closePrices = sortedCandles.map(([_, close]) => close);

const emaFast = calculateEMA(closePrices, 3);
const emaSlow = calculateEMA(closePrices, 7);

const emaFastMap = new Map();
const emaSlowMap = new Map();
sortedCandles.forEach(([time], idx) => {
  emaFastMap.set(time, emaFast[idx]);
  emaSlowMap.set(time, emaSlow[idx]);
});

console.log('Calculated EMAs\n');

// Base strategy parameters
const BASE_POSITION = 0.065;
const EMA_GAP = 0.0005;
const CROWD_THRESHOLD = 0.65;

// Test different dynamic sizing strategies
const strategies = [
  {
    name: 'Baseline (Fixed 6.5%)',
    getPositionSize: (balance, streak) => BASE_POSITION
  },
  {
    name: 'Increase After Loss (1.5x)',
    getPositionSize: (balance, streak) => {
      if (streak.lastResult === 'L' && streak.currentLoss === 1) {
        return BASE_POSITION * 1.5; // 9.75% after 1 loss
      }
      return BASE_POSITION;
    }
  },
  {
    name: 'Increase After 2 Losses (1.5x)',
    getPositionSize: (balance, streak) => {
      if (streak.lastResult === 'L' && streak.currentLoss === 2) {
        return BASE_POSITION * 1.5; // 9.75% after 2 losses
      }
      return BASE_POSITION;
    }
  },
  {
    name: 'Decrease After 2+ Wins (0.5x)',
    getPositionSize: (balance, streak) => {
      if (streak.lastResult === 'W' && streak.currentWin >= 2) {
        return BASE_POSITION * 0.5; // 3.25% after 2+ wins
      }
      return BASE_POSITION;
    }
  },
  {
    name: 'Increase After Loss + Decrease After Wins',
    getPositionSize: (balance, streak) => {
      if (streak.lastResult === 'L' && streak.currentLoss === 1) {
        return BASE_POSITION * 1.5; // 9.75% after 1 loss
      }
      if (streak.lastResult === 'W' && streak.currentWin >= 2) {
        return BASE_POSITION * 0.5; // 3.25% after 2+ wins
      }
      return BASE_POSITION;
    }
  },
  {
    name: 'Aggressive: 2x After Loss, 0.5x After 2 Wins',
    getPositionSize: (balance, streak) => {
      if (streak.lastResult === 'L' && streak.currentLoss === 1) {
        return BASE_POSITION * 2.0; // 13% after 1 loss
      }
      if (streak.lastResult === 'W' && streak.currentWin >= 2) {
        return BASE_POSITION * 0.5; // 3.25% after 2+ wins
      }
      return BASE_POSITION;
    }
  },
  {
    name: 'Skip After 3+ Wins',
    getPositionSize: (balance, streak) => {
      if (streak.lastResult === 'W' && streak.currentWin >= 3) {
        return 0; // Skip trade
      }
      return BASE_POSITION;
    }
  },
  {
    name: 'Conservative: Increase 1.25x After Loss, Decrease 0.75x After 2 Wins',
    getPositionSize: (balance, streak) => {
      if (streak.lastResult === 'L' && streak.currentLoss === 1) {
        return BASE_POSITION * 1.25; // 8.125% after 1 loss
      }
      if (streak.lastResult === 'W' && streak.currentWin >= 2) {
        return BASE_POSITION * 0.75; // 4.875% after 2+ wins
      }
      return BASE_POSITION;
    }
  },
  {
    name: 'Martingale Lite: 1.5x After Each Loss',
    getPositionSize: (balance, streak) => {
      if (streak.lastResult === 'L' && streak.currentLoss > 0) {
        return Math.min(BASE_POSITION * Math.pow(1.5, streak.currentLoss), 0.25); // Cap at 25%
      }
      return BASE_POSITION;
    }
  },
  {
    name: 'Anti-Streak: Reduce After 3+ Any Streak',
    getPositionSize: (balance, streak) => {
      if ((streak.currentWin >= 3) || (streak.currentLoss >= 3)) {
        return BASE_POSITION * 0.5; // 3.25% during long streaks
      }
      return BASE_POSITION;
    }
  }
];

console.log('Testing strategies...\n');

const results = [];

for (const strategy of strategies) {
  let balance = 1.0;
  let wins = 0;
  let losses = 0;
  let tradesEntered = 0;
  let totalBetSize = 0;
  let maxDrawdown = 0;
  let peakBalance = 1.0;

  const streak = {
    lastResult: null,
    currentWin: 0,
    currentLoss: 0
  };

  for (const round of rounds) {
    const [epoch, lockTs, lockPrice, closePrice, winner, t20sBull, t20sBear, t20sTotal, finalBull, finalBear, finalTotal] = round;

    const roundedLockTs = Math.floor(lockTs / 300) * 300;
    const fast = emaFastMap.get(roundedLockTs);
    const slow = emaSlowMap.get(roundedLockTs);

    if (!fast || !slow) continue;

    const emaDiff = Math.abs(fast - slow) / slow;
    if (emaDiff < EMA_GAP) continue;

    const emaBullish = fast > slow;
    const emaBearish = fast < slow;

    const t20sBullPct = Number(t20sBull) / Number(t20sTotal);
    const t20sBearPct = Number(t20sBear) / Number(t20sTotal);

    const crowdBullish = t20sBullPct >= CROWD_THRESHOLD;
    const crowdBearish = t20sBearPct >= CROWD_THRESHOLD;

    const signalBull = emaBullish && crowdBullish;
    const signalBear = emaBearish && crowdBearish;

    if (!signalBull && !signalBear) continue;

    // Get dynamic position size
    const positionPct = strategy.getPositionSize(balance, streak);

    if (positionPct === 0) continue; // Skip this trade

    const bullMultiple = Number(finalTotal) / Number(finalBull);
    const bearMultiple = Number(finalTotal) / Number(finalBear);

    const multiple = signalBull ? bullMultiple : bearMultiple;

    const priceUp = Number(closePrice) > Number(lockPrice);
    const won = (signalBull && priceUp) || (signalBear && !priceUp);

    const betSize = balance * positionPct;
    const payout = won ? betSize * multiple : 0;
    const profit = payout - betSize;

    balance += profit;
    totalBetSize += betSize;
    tradesEntered++;

    if (won) {
      wins++;
      streak.lastResult = 'W';
      streak.currentWin++;
      streak.currentLoss = 0;
    } else {
      losses++;
      streak.lastResult = 'L';
      streak.currentLoss++;
      streak.currentWin = 0;
    }

    // Track drawdown
    if (balance > peakBalance) {
      peakBalance = balance;
    }
    const drawdown = ((peakBalance - balance) / peakBalance) * 100;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  results.push({
    strategy: strategy.name,
    balance,
    wins,
    losses,
    tradesEntered,
    winRate: tradesEntered > 0 ? (wins / tradesEntered) * 100 : 0,
    roi: ((balance - 1.0) / 1.0) * 100,
    profit: balance - 1.0,
    avgBetSize: tradesEntered > 0 ? (totalBetSize / tradesEntered) : 0,
    maxDrawdown
  });
}

// Sort by ROI
results.sort((a, b) => b.roi - a.roi);

console.log('='.repeat(110));
console.log('DYNAMIC POSITION SIZING STRATEGY COMPARISON');
console.log('='.repeat(110));
console.log();

results.forEach((r, idx) => {
  const rank = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
  console.log(`${rank} ${r.strategy}`);
  console.log('-'.repeat(110));
  console.log(`  Trades: ${r.tradesEntered} | Wins: ${r.wins} | Losses: ${r.losses} | Win Rate: ${r.winRate.toFixed(2)}%`);
  console.log(`  Balance: 1.0000 → ${r.balance.toFixed(4)} BNB`);
  console.log(`  ROI: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}%`);
  console.log(`  Profit: ${r.profit >= 0 ? '+' : ''}${r.profit.toFixed(4)} BNB`);
  console.log(`  Avg Bet Size: ${(r.avgBetSize * 100).toFixed(2)}%`);
  console.log(`  Max Drawdown: -${r.maxDrawdown.toFixed(2)}%`);
  console.log();
});

console.log('='.repeat(110));
console.log('COMPARISON vs BASELINE');
console.log('='.repeat(110));
console.log();

const baseline = results.find(r => r.strategy.includes('Baseline'));

results.forEach(r => {
  if (r.strategy === baseline.strategy) return;

  const roiDiff = r.roi - baseline.roi;
  const profitDiff = r.profit - baseline.profit;
  const tradesDiff = r.tradesEntered - baseline.tradesEntered;

  console.log(`${r.strategy}:`);
  console.log(`  ROI vs Baseline: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}% ${roiDiff > 0 ? '📈' : roiDiff < 0 ? '📉' : '='}`);
  console.log(`  Profit vs Baseline: ${profitDiff >= 0 ? '+' : ''}${profitDiff.toFixed(4)} BNB`);
  console.log(`  Trades vs Baseline: ${tradesDiff >= 0 ? '+' : ''}${tradesDiff}`);
  console.log();
});

console.log('='.repeat(110));
console.log('RECOMMENDATIONS');
console.log('='.repeat(110));
console.log();

const topStrategy = results[0];

console.log(`Best Strategy: ${topStrategy.strategy}`);
console.log();
console.log('Why it works:');

if (topStrategy.strategy.includes('After Loss')) {
  console.log('  ✓ Takes advantage of 71.79% win rate after 1 loss');
  console.log('  ✓ Capitalizes on mean reversion patterns');
}

if (topStrategy.strategy.includes('After Wins') || topStrategy.strategy.includes('After 2 Wins')) {
  console.log('  ✓ Reduces risk when win rate drops (54% after 2 wins, 46% after 3 wins)');
  console.log('  ✓ Protects capital during negative mean reversion');
}

if (topStrategy.strategy.includes('Skip')) {
  console.log('  ✓ Avoids low probability trades (33% win rate after 4 wins)');
  console.log('  ✓ Maximizes capital efficiency');
}

console.log();
console.log(`Expected Results:`);
console.log(`  ROI: ${topStrategy.roi >= 0 ? '+' : ''}${topStrategy.roi.toFixed(2)}% (vs ${baseline.roi.toFixed(2)}% baseline)`);
console.log(`  Max Drawdown: -${topStrategy.maxDrawdown.toFixed(2)}% (vs -${baseline.maxDrawdown.toFixed(2)}% baseline)`);
console.log(`  Additional Profit: +${(topStrategy.profit - baseline.profit).toFixed(4)} BNB`);

db.close();
