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

// SAFER strategies with cooldown periods and non-compounding
const strategies = [
  {
    name: 'Baseline (Fixed 6.5%)',
    description: 'Always bet 6.5% - no adjustments',
    getPositionSize: (balance, streak, initialBalance) => BASE_POSITION
  },
  {
    name: 'ONE-TIME 2x After Loss (No Cooldown)',
    description: 'Bet 13% ONLY on the trade immediately after a loss, then back to 6.5%',
    getPositionSize: (balance, streak, initialBalance) => {
      // Only increase for the FIRST trade after a loss
      if (streak.lastResult === 'L' && streak.currentLoss === 0 && streak.tradesAgo === 1) {
        return BASE_POSITION * 2.0; // 13%
      }
      return BASE_POSITION;
    }
  },
  {
    name: 'ONE-TIME 2x After Loss + 0.5x After 2 Wins',
    description: 'Increase once after loss, decrease after 2 wins',
    getPositionSize: (balance, streak, initialBalance) => {
      if (streak.lastResult === 'L' && streak.currentLoss === 0 && streak.tradesAgo === 1) {
        return BASE_POSITION * 2.0; // 13% for ONE trade
      }
      if (streak.currentWin >= 2) {
        return BASE_POSITION * 0.5; // 3.25% after 2+ wins
      }
      return BASE_POSITION;
    }
  },
  {
    name: 'Cooldown: 2x After Loss, Then Skip 1 Trade',
    description: 'Double bet after loss, then skip next trade regardless of result',
    getPositionSize: (balance, streak, initialBalance) => {
      if (streak.cooldown > 0) {
        return 0; // Skip trade during cooldown
      }
      if (streak.lastResult === 'L' && streak.currentLoss === 0 && streak.tradesAgo === 1) {
        return BASE_POSITION * 2.0; // 13%
      }
      return BASE_POSITION;
    },
    updateCooldown: (streak, won) => {
      if (streak.lastResult === 'L' && streak.tradesAgo === 1) {
        streak.cooldown = 1; // Skip next trade
      }
    }
  },
  {
    name: 'ONE-TIME 1.5x After Loss (Moderate)',
    description: 'Increase to 9.75% for one trade after loss',
    getPositionSize: (balance, streak, initialBalance) => {
      if (streak.lastResult === 'L' && streak.currentLoss === 0 && streak.tradesAgo === 1) {
        return BASE_POSITION * 1.5; // 9.75%
      }
      return BASE_POSITION;
    }
  },
  {
    name: 'Fixed Amount (0.65 BNB) After Loss',
    description: 'Always bet 0.65 BNB after loss (6.5% of starting 10 BNB) - NO COMPOUNDING',
    getPositionSize: (balance, streak, initialBalance) => {
      if (streak.lastResult === 'L' && streak.currentLoss === 0 && streak.tradesAgo === 1) {
        return 0.65 / balance; // Fixed BNB amount = no compound
      }
      return BASE_POSITION;
    }
  },
  {
    name: 'Reset After Win Following Loss',
    description: '2x after loss, but if you win, wait 2 trades before allowing another 2x',
    getPositionSize: (balance, streak, initialBalance) => {
      if (streak.cooldown > 0) {
        return BASE_POSITION;
      }
      if (streak.lastResult === 'L' && streak.currentLoss === 0 && streak.tradesAgo === 1) {
        return BASE_POSITION * 2.0;
      }
      return BASE_POSITION;
    },
    updateCooldown: (streak, won) => {
      if (streak.lastResult === 'L' && streak.tradesAgo === 1 && won) {
        streak.cooldown = 2; // Wait 2 trades after winning the recovery bet
      }
    }
  },
  {
    name: 'Cap at Peak Balance (No Compound on Losses)',
    description: 'After loss, bet 13% of PEAK balance (not current), prevents compounding losses',
    getPositionSize: (balance, streak, initialBalance, peakBalance) => {
      if (streak.lastResult === 'L' && streak.currentLoss === 0 && streak.tradesAgo === 1) {
        return (BASE_POSITION * 2.0 * peakBalance) / balance; // Use peak, not current
      }
      return BASE_POSITION;
    }
  }
];

console.log('Testing SAFER strategies with cooldown periods...\n');

const results = [];

for (const strategy of strategies) {
  let balance = 1.0;
  let wins = 0;
  let losses = 0;
  let tradesEntered = 0;
  let tradesSkipped = 0;
  let totalBetSize = 0;
  let maxDrawdown = 0;
  let peakBalance = 1.0;
  const initialBalance = 1.0;

  const streak = {
    lastResult: null,
    currentWin: 0,
    currentLoss: 0,
    tradesAgo: 0,
    cooldown: 0
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

    // Decrement cooldown
    if (streak.cooldown > 0) {
      streak.cooldown--;
    }

    // Get dynamic position size
    const positionPct = strategy.getPositionSize(balance, streak, initialBalance, peakBalance);

    if (positionPct === 0) {
      tradesSkipped++;
      continue; // Skip this trade
    }

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

    // Update cooldown if strategy has custom logic
    if (strategy.updateCooldown) {
      strategy.updateCooldown(streak, won);
    }

    // Update streak tracking
    if (won) {
      wins++;
      if (streak.lastResult === 'W') {
        streak.currentWin++;
        streak.currentLoss = 0;
      } else {
        streak.currentWin = 1;
        streak.currentLoss = 0;
      }
      streak.lastResult = 'W';
      streak.tradesAgo = 0;
    } else {
      losses++;
      if (streak.lastResult === 'L') {
        streak.currentLoss++;
        streak.currentWin = 0;
      } else {
        streak.currentLoss = 1;
        streak.currentWin = 0;
      }
      streak.lastResult = 'L';
      streak.tradesAgo = 0;
    }

    streak.tradesAgo++;

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
    description: strategy.description,
    balance,
    wins,
    losses,
    tradesEntered,
    tradesSkipped,
    winRate: tradesEntered > 0 ? (wins / tradesEntered) * 100 : 0,
    roi: ((balance - 1.0) / 1.0) * 100,
    profit: balance - 1.0,
    avgBetSize: tradesEntered > 0 ? (totalBetSize / tradesEntered) : 0,
    maxDrawdown
  });
}

// Sort by ROI
results.sort((a, b) => b.roi - a.roi);

console.log('='.repeat(120));
console.log('SAFER POSITION SIZING STRATEGIES (With Cooldown & Non-Compounding Options)');
console.log('='.repeat(120));
console.log();

results.forEach((r, idx) => {
  const rank = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
  console.log(`${rank} ${r.strategy}`);
  console.log(`    ${r.description}`);
  console.log('-'.repeat(120));
  console.log(`  Trades: ${r.tradesEntered} entered, ${r.tradesSkipped} skipped | ${r.wins}W / ${r.losses}L | Win Rate: ${r.winRate.toFixed(2)}%`);
  console.log(`  Balance: 1.0000 → ${r.balance.toFixed(4)} BNB`);
  console.log(`  ROI: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}%`);
  console.log(`  Profit: ${r.profit >= 0 ? '+' : ''}${r.profit.toFixed(4)} BNB`);
  console.log(`  Avg Bet Size: ${(r.avgBetSize * 100).toFixed(2)}%`);
  console.log(`  Max Drawdown: -${r.maxDrawdown.toFixed(2)}%`);
  console.log();
});

console.log('='.repeat(120));
console.log('KEY INSIGHT: Preventing Loss Compounding');
console.log('='.repeat(120));
console.log();

const baseline = results.find(r => r.strategy.includes('Baseline'));
const oneTime = results.find(r => r.strategy.includes('ONE-TIME 2x After Loss (No Cooldown)'));

console.log('Notice how "ONE-TIME" strategies prevent compounding:');
console.log('  - After a loss, you bet 13% ONCE');
console.log('  - If you lose again, you DON\'T bet 13% of the reduced balance');
console.log('  - This caps your maximum loss during streaks');
console.log();
console.log(`Baseline Max Drawdown: -${baseline.maxDrawdown.toFixed(2)}%`);
console.log(`ONE-TIME Strategy Max Drawdown: -${oneTime.maxDrawdown.toFixed(2)}%`);
console.log(`Difference: ${(oneTime.maxDrawdown - baseline.maxDrawdown).toFixed(2)}%`);

db.close();
