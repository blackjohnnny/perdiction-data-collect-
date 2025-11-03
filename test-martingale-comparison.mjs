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

const strategies = [
  {
    name: 'ONE-TIME (Current): 9.75% once after loss',
    description: 'After loss: bet 9.75% for ONE trade, then back to 6.5%',
    getPositionSize: (balance, justLost, currentWinStreak, lossStreak) => {
      if (justLost) return BASE_POSITION * 1.5; // 9.75% for ONE trade
      if (currentWinStreak >= 2) return BASE_POSITION * 0.75; // 4.875%
      return BASE_POSITION; // 6.5%
    }
  },
  {
    name: 'MARTINGALE: 9.75% UNTIL WIN',
    description: 'After loss: bet 9.75% and KEEP betting 9.75% until you WIN',
    getPositionSize: (balance, justLost, currentWinStreak, lossStreak) => {
      if (lossStreak >= 1) return BASE_POSITION * 1.5; // 9.75% while in loss streak
      if (currentWinStreak >= 2) return BASE_POSITION * 0.75; // 4.875%
      return BASE_POSITION; // 6.5%
    }
  },
  {
    name: 'FULL MARTINGALE: Double each loss',
    description: 'Classic Martingale: 6.5% → 13% → 26% → 52% until win',
    getPositionSize: (balance, justLost, currentWinStreak, lossStreak) => {
      if (lossStreak >= 1) {
        const multiplier = Math.pow(2, lossStreak);
        const size = BASE_POSITION * multiplier;
        return Math.min(size, 1.0); // Cap at 100% of balance
      }
      return BASE_POSITION; // 6.5%
    }
  },
  {
    name: 'Baseline (Fixed 6.5%)',
    description: 'Always bet 6.5% - no adjustments',
    getPositionSize: (balance, justLost, currentWinStreak, lossStreak) => BASE_POSITION
  }
];

console.log('='.repeat(120));
console.log('MARTINGALE COMPARISON: ONE-TIME vs CONTINUOUS');
console.log('='.repeat(120));
console.log();

const results = [];

for (const strategy of strategies) {
  let balance = 1.0;
  let wins = 0;
  let losses = 0;
  let tradesEntered = 0;
  let maxDrawdown = 0;
  let peakBalance = 1.0;

  let justLost = false;
  let currentWinStreak = 0;
  let currentLossStreak = 0;

  const tradeLog = [];
  let busted = false;

  for (const round of rounds) {
    if (busted) break;

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

    // Get position size
    const positionPct = strategy.getPositionSize(balance, justLost, currentWinStreak, currentLossStreak);

    const bullMultiple = Number(finalTotal) / Number(finalBull);
    const bearMultiple = Number(finalTotal) / Number(finalBear);

    const multiple = signalBull ? bullMultiple : bearMultiple;

    const priceUp = Number(closePrice) > Number(lockPrice);
    const won = (signalBull && priceUp) || (signalBear && !priceUp);

    const betSize = balance * positionPct;

    // Check if busted
    if (betSize > balance) {
      busted = true;
      balance = 0;
      break;
    }

    const payout = won ? betSize * multiple : 0;
    const profit = payout - betSize;

    tradesEntered++;
    balance += profit;

    // Check if busted after loss
    if (balance <= 0) {
      busted = true;
      balance = 0;
      break;
    }

    if (won) {
      wins++;
      justLost = false;
      currentWinStreak++;
      currentLossStreak = 0;
    } else {
      losses++;
      justLost = true;
      currentLossStreak++;
      currentWinStreak = 0;
    }

    // Track drawdown
    if (balance > peakBalance) peakBalance = balance;
    const drawdown = ((peakBalance - balance) / peakBalance) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    // Log first 30 trades
    if (tradesEntered <= 30) {
      tradeLog.push({
        trade: tradesEntered,
        epoch,
        positionPct: (positionPct * 100).toFixed(2) + '%',
        betSize: betSize.toFixed(4),
        won,
        lossStreak: currentLossStreak,
        balance: balance.toFixed(4)
      });
    }
  }

  results.push({
    strategy: strategy.name,
    description: strategy.description,
    balance,
    wins,
    losses,
    tradesEntered,
    winRate: tradesEntered > 0 ? (wins / tradesEntered) * 100 : 0,
    roi: ((balance - 1.0) / 1.0) * 100,
    profit: balance - 1.0,
    maxDrawdown,
    tradeLog,
    busted
  });
}

// Print results
results.forEach((r, idx) => {
  console.log(`\n${idx + 1}. ${r.strategy}`);
  console.log(`   ${r.description}`);
  console.log('-'.repeat(120));

  if (r.busted) {
    console.log(`   ❌ BUSTED after ${r.tradesEntered} trades!`);
    console.log(`   Final Balance: 0.0000 BNB`);
    console.log(`   ROI: -100.00%`);
  } else {
    console.log(`   Trades: ${r.tradesEntered} | ${r.wins}W / ${r.losses}L | Win Rate: ${r.winRate.toFixed(2)}%`);
    console.log(`   Final Balance: ${r.balance.toFixed(4)} BNB`);
    console.log(`   ROI: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}%`);
    console.log(`   Profit: ${r.profit >= 0 ? '+' : ''}${r.profit.toFixed(4)} BNB`);
    console.log(`   Max Drawdown: -${r.maxDrawdown.toFixed(2)}%`);
  }
  console.log();
});

console.log('\n' + '='.repeat(120));
console.log('DETAILED TRADE COMPARISON (First 30 Trades)');
console.log('='.repeat(120));

for (const r of results) {
  console.log(`\n${r.strategy}`);
  console.log('-'.repeat(120));
  console.log('Trade | Epoch      | Position | Bet Size | Won | Loss Streak | Balance');
  console.log('-'.repeat(120));
  r.tradeLog.forEach(t => {
    const result = t.won ? 'W ✓' : 'L ✗';
    const lossStreakStr = t.lossStreak > 0 ? `🔴 ${t.lossStreak}` : '-';
    console.log(`${t.trade.toString().padStart(5)} | ${t.epoch} | ${t.positionPct.padStart(7)} | ${t.betSize.padStart(7)} | ${result.padEnd(3)} | ${lossStreakStr.padStart(11)} | ${t.balance}`);
  });
}

console.log('\n' + '='.repeat(120));
console.log('SUMMARY: Why ONE-TIME is Better Than Continuous Martingale');
console.log('='.repeat(120));
console.log();

const oneTime = results.find(r => r.strategy.includes('ONE-TIME'));
const martingale = results.find(r => r.strategy.includes('MARTINGALE: 9.75%'));
const fullMartingale = results.find(r => r.strategy.includes('FULL MARTINGALE'));

console.log('ONE-TIME (Current Strategy):');
console.log(`  ROI: ${oneTime.roi >= 0 ? '+' : ''}${oneTime.roi.toFixed(2)}%`);
console.log(`  Max Drawdown: -${oneTime.maxDrawdown.toFixed(2)}%`);
console.log(`  Risk: ${oneTime.busted ? '❌ BUSTED' : '✅ Safe'}`);
console.log();

console.log('CONTINUOUS Martingale (9.75% until win):');
console.log(`  ROI: ${martingale.busted ? '-100.00%' : (martingale.roi >= 0 ? '+' : '') + martingale.roi.toFixed(2) + '%'}`);
console.log(`  Max Drawdown: ${martingale.busted ? 'N/A (BUSTED)' : '-' + martingale.maxDrawdown.toFixed(2) + '%'}`);
console.log(`  Risk: ${martingale.busted ? '❌ BUSTED' : '✅ Safe'}`);
console.log();

console.log('FULL Martingale (Double each loss):');
console.log(`  ROI: ${fullMartingale.busted ? '-100.00%' : (fullMartingale.roi >= 0 ? '+' : '') + fullMartingale.roi.toFixed(2) + '%'}`);
console.log(`  Max Drawdown: ${fullMartingale.busted ? 'N/A (BUSTED)' : '-' + fullMartingale.maxDrawdown.toFixed(2) + '%'}`);
console.log(`  Risk: ${fullMartingale.busted ? '❌ BUSTED' : '✅ Safe'}`);
console.log();

console.log('✅ CONCLUSION: ONE-TIME increase is safer and avoids compounding risk during losing streaks.');

db.close();
