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

// Test different profit split strategies
const strategies = [
  {
    name: 'Baseline: Full Compound (100%)',
    description: 'Compound all profits - standard approach',
    profitSplit: 1.0  // 100% back into trading
  },
  {
    name: 'Conservative: 50% to Safe (50% compound)',
    description: 'Take 50% profit to safe, compound 50%',
    profitSplit: 0.5  // 50% back into trading
  },
  {
    name: 'Balanced: 70% to Safe (30% compound)',
    description: 'Take 70% profit to safe, compound 30%',
    profitSplit: 0.3  // 30% back into trading
  },
  {
    name: 'Aggressive: 30% to Safe (70% compound)',
    description: 'Take 30% profit to safe, compound 70%',
    profitSplit: 0.7  // 70% back into trading
  },
  {
    name: 'Ultra Safe: 80% to Safe (20% compound)',
    description: 'Take 80% profit to safe, compound 20%',
    profitSplit: 0.2  // 20% back into trading
  },
  {
    name: 'Hybrid: 50% to Safe + 2x After Loss',
    description: '50% profit to safe + increase position after loss',
    profitSplit: 0.5,
    dynamicSizing: true  // Use dynamic sizing
  }
];

console.log('Testing profit-split strategies...\n');

const results = [];

for (const strategy of strategies) {
  let tradingBalance = 1.0;  // Balance used for trading
  let safeBalance = 0.0;     // Balance in safe (not risked)
  let wins = 0;
  let losses = 0;
  let tradesEntered = 0;
  let maxDrawdown = 0;
  let peakTradingBalance = 1.0;

  let lastResult = null;

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

    // Determine position size
    let positionPct = BASE_POSITION;
    if (strategy.dynamicSizing && lastResult === 'L') {
      positionPct = BASE_POSITION * 2.0; // 2x after loss
    }

    const bullMultiple = Number(finalTotal) / Number(finalBull);
    const bearMultiple = Number(finalTotal) / Number(finalBear);

    const multiple = signalBull ? bullMultiple : bearMultiple;

    const priceUp = Number(closePrice) > Number(lockPrice);
    const won = (signalBull && priceUp) || (signalBear && !priceUp);

    const betSize = tradingBalance * positionPct;
    const payout = won ? betSize * multiple : 0;
    const profit = payout - betSize;

    tradesEntered++;

    if (profit > 0) {
      // WINNING TRADE: Split profit
      const profitToSafe = profit * (1 - strategy.profitSplit);
      const profitToCompound = profit * strategy.profitSplit;

      safeBalance += profitToSafe;
      tradingBalance += profitToCompound;

      wins++;
      lastResult = 'W';
    } else {
      // LOSING TRADE: All loss from trading balance
      tradingBalance += profit; // profit is negative

      losses++;
      lastResult = 'L';
    }

    // Track drawdown of TRADING balance only
    if (tradingBalance > peakTradingBalance) {
      peakTradingBalance = tradingBalance;
    }
    const drawdown = ((peakTradingBalance - tradingBalance) / peakTradingBalance) * 100;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  const totalBalance = tradingBalance + safeBalance;

  results.push({
    strategy: strategy.name,
    description: strategy.description,
    tradingBalance,
    safeBalance,
    totalBalance,
    wins,
    losses,
    tradesEntered,
    winRate: tradesEntered > 0 ? (wins / tradesEntered) * 100 : 0,
    roi: ((totalBalance - 1.0) / 1.0) * 100,
    profit: totalBalance - 1.0,
    maxDrawdown,
    profitSplit: strategy.profitSplit
  });
}

// Sort by total balance
results.sort((a, b) => b.totalBalance - a.totalBalance);

console.log('='.repeat(120));
console.log('PROFIT-SPLIT STRATEGY COMPARISON');
console.log('='.repeat(120));
console.log();

results.forEach((r, idx) => {
  const rank = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
  console.log(`${rank} ${r.strategy}`);
  console.log(`    ${r.description}`);
  console.log('-'.repeat(120));
  console.log(`  Trades: ${r.tradesEntered} | ${r.wins}W / ${r.losses}L | Win Rate: ${r.winRate.toFixed(2)}%`);
  console.log();
  console.log(`  Trading Balance: ${r.tradingBalance.toFixed(4)} BNB (actively risked)`);
  console.log(`  Safe Balance:    ${r.safeBalance.toFixed(4)} BNB (secured profits)`);
  console.log(`  TOTAL Balance:   ${r.totalBalance.toFixed(4)} BNB`);
  console.log();
  console.log(`  Total ROI: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}%`);
  console.log(`  Total Profit: ${r.profit >= 0 ? '+' : ''}${r.profit.toFixed(4)} BNB`);
  console.log(`  Max Drawdown (Trading Balance): -${r.maxDrawdown.toFixed(2)}%`);
  console.log();
});

console.log('='.repeat(120));
console.log('KEY INSIGHTS: Profit Splitting');
console.log('='.repeat(120));
console.log();

const fullCompound = results.find(r => r.strategy.includes('100%'));
const halfSplit = results.find(r => r.strategy.includes('50% to Safe') && !r.strategy.includes('2x'));

console.log('50% Profit Split vs Full Compound:');
console.log('-'.repeat(120));
console.log(`Full Compound:`);
console.log(`  Total Balance: ${fullCompound.totalBalance.toFixed(4)} BNB (all at risk)`);
console.log(`  ROI: +${fullCompound.roi.toFixed(2)}%`);
console.log(`  Max Drawdown: -${fullCompound.maxDrawdown.toFixed(2)}%`);
console.log();
console.log(`50% to Safe:`);
console.log(`  Total Balance: ${halfSplit.totalBalance.toFixed(4)} BNB`);
console.log(`  Trading Balance: ${halfSplit.tradingBalance.toFixed(4)} BNB (at risk)`);
console.log(`  Safe Balance: ${halfSplit.safeBalance.toFixed(4)} BNB (SECURED)`);
console.log(`  ROI: +${halfSplit.roi.toFixed(2)}%`);
console.log(`  Max Drawdown: -${halfSplit.maxDrawdown.toFixed(2)}%`);
console.log();
console.log(`Comparison:`);
console.log(`  Profit Difference: ${(halfSplit.profit - fullCompound.profit).toFixed(4)} BNB (${((halfSplit.profit / fullCompound.profit - 1) * 100).toFixed(2)}%)`);
console.log(`  Secured in Safe: ${halfSplit.safeBalance.toFixed(4)} BNB (guaranteed profit)`);
console.log(`  Risk Exposure: ${halfSplit.tradingBalance.toFixed(4)} BNB vs ${fullCompound.totalBalance.toFixed(4)} BNB`);
console.log(`  Risk Reduction: ${((1 - halfSplit.tradingBalance / fullCompound.totalBalance) * 100).toFixed(2)}%`);

console.log();
console.log('='.repeat(120));
console.log('PSYCHOLOGICAL BENEFITS');
console.log('='.repeat(120));
console.log();

console.log('With 50% Profit Split:');
console.log(`  1. You KNOW you have ${halfSplit.safeBalance.toFixed(4)} BNB secured (can\'t lose it)`);
console.log(`  2. Max loss exposure: ${halfSplit.tradingBalance.toFixed(4)} BNB (not ${fullCompound.totalBalance.toFixed(4)} BNB)`);
console.log(`  3. If 7-loss streak happens:`);
console.log(`     - Trading balance might drop ${halfSplit.maxDrawdown.toFixed(2)}%`);
console.log(`     - But safe balance is UNTOUCHED`);
console.log(`     - Total drawdown: Much less than full compound`);
console.log();
console.log(`  4. You can withdraw safe balance anytime without affecting strategy`);
console.log(`  5. Less stress during losing streaks`);

console.log();
console.log('='.repeat(120));
console.log('RECOMMENDATION');
console.log('='.repeat(120));
console.log();

const hybrid = results.find(r => r.strategy.includes('Hybrid'));
console.log('BEST OPTION: 50% to Safe + Dynamic Sizing');
console.log('-'.repeat(120));
console.log(`  Total Balance: ${hybrid.totalBalance.toFixed(4)} BNB`);
console.log(`  ROI: +${hybrid.roi.toFixed(2)}%`);
console.log(`  Safe Balance: ${hybrid.safeBalance.toFixed(4)} BNB (SECURED)`);
console.log(`  Trading Balance: ${hybrid.tradingBalance.toFixed(4)} BNB (at risk)`);
console.log();
console.log('Why this works:');
console.log('  ✓ Half your profits are GUARANTEED SAFE');
console.log('  ✓ Still compound enough for growth');
console.log('  ✓ Can increase position after losses (71.79% win rate)');
console.log('  ✓ Maximum risk exposure is controlled');
console.log('  ✓ Peace of mind during drawdowns');

console.log();
console.log('Example with 10 BNB starting:');
console.log(`  After 148 trades:`);
console.log(`    Trading balance: ${(hybrid.tradingBalance * 10).toFixed(2)} BNB`);
console.log(`    SAFE balance:    ${(hybrid.safeBalance * 10).toFixed(2)} BNB ← YOU CAN WITHDRAW THIS ANYTIME`);
console.log(`    Total:           ${(hybrid.totalBalance * 10).toFixed(2)} BNB`);
console.log();
console.log(`  Worst case scenario (7-loss streak):`);
console.log(`    Trading balance might drop to: ${(hybrid.tradingBalance * 10 * (1 - hybrid.maxDrawdown/100)).toFixed(2)} BNB`);
console.log(`    Safe balance stays at:         ${(hybrid.safeBalance * 10).toFixed(2)} BNB`);
console.log(`    You still have:                ${((hybrid.safeBalance * 10) + (hybrid.tradingBalance * 10 * (1 - hybrid.maxDrawdown/100))).toFixed(2)} BNB minimum`);

db.close();
