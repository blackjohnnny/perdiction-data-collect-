import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  DATABASE: './data/live.db',

  ROUNDS: {
    mode: 'all'
  },

  STRATEGY: {
    emaFast: 3,
    emaSlow: 7,
    emaGap: 0.0005,              // 0.05% minimum EMA gap
    maxImpliedPayout: 1.85,       // At T-20s, implied payout must be ≤ 1.85x
    positionSize: 0.065           // 6.5% base position
  },

  SAFETY: {
    dailyDrawdownLimit: 0.20      // 20% daily drawdown limit
  }
};

console.log('═══════════════════════════════════════════════════════════');
console.log('BACKTEST WITH 20% DAILY DRAWDOWN LIMIT');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('Strategy Rules:');
console.log('1. EMA3 vs EMA7 with gap ≥ 0.05%');
console.log('2. IMPLIED payout at T-20s ≤ 1.85x');
console.log('3. Position: 6.5% base, 9.75% after loss, 4.875% after 2+ wins');
console.log('4. SAFETY: Stop trading if drawdown ≥ 20% from daily high');
console.log('5. Daily high resets at midnight UTC\n');

// ============================================================================
// LOAD DATA
// ============================================================================

const SQL = await initSqlJs();
const buffer = readFileSync(CONFIG.DATABASE);
const db = new SQL.Database(buffer);

const roundsResult = db.exec(`
  SELECT
    epoch, lock_ts, lock_price, close_price, winner,
    t20s_bull_wei, t20s_bear_wei, t20s_total_wei,
    bull_amount_wei, bear_amount_wei, total_amount_wei
  FROM rounds
  WHERE t20s_total_wei != "0"
  ORDER BY epoch ASC
`);

if (!roundsResult.length) {
  console.log('No rounds found!');
  process.exit(1);
}

const rounds = roundsResult[0].values;
console.log(`Loaded ${rounds.length} rounds with T-20s data\n`);

// Fetch TradingView candles
console.log('Fetching TradingView price data...');
const lockTimes = rounds.map(r => r[1]);
const startTime = Math.min(...lockTimes) - 3600;
const endTime = Math.max(...lockTimes) + 3600;

const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.BNB/USD&resolution=5&from=${startTime}&to=${endTime}`;
const response = await globalThis.fetch(url);
const candles = await response.json();

console.log(`Fetched ${candles.t.length} candles\n`);

// Build candle map
const candleMap = new Map();
for (let i = 0; i < candles.t.length; i++) {
  candleMap.set(candles.t[i], candles.c[i]);
}

// Calculate EMAs
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const emaArray = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    emaArray.push(prices[i] * k + emaArray[i - 1] * (1 - k));
  }
  return emaArray;
}

const closePrices = candles.c;
const emaFast = calculateEMA(closePrices, CONFIG.STRATEGY.emaFast);
const emaSlow = calculateEMA(closePrices, CONFIG.STRATEGY.emaSlow);

const emaFastMap = new Map();
const emaSlowMap = new Map();
candles.t.forEach((time, idx) => {
  emaFastMap.set(time, emaFast[idx]);
  emaSlowMap.set(time, emaSlow[idx]);
});

console.log(`Calculated EMA ${CONFIG.STRATEGY.emaFast}/${CONFIG.STRATEGY.emaSlow}\n`);
console.log('Running simulation WITH 20% daily drawdown limit...\n');

// ============================================================================
// BACKTEST WITH DRAWDOWN LIMIT
// ============================================================================

let balance = 10.0;
let dailyHigh = balance;
let wins = 0;
let losses = 0;
const trades = [];
let maxBalance = balance;
let maxDrawdown = 0;
let tradingPaused = false;
let currentDay = null;
let pausedDays = [];
let dailyResets = [];

for (const round of rounds) {
  const [epoch, lockTs, lockPrice, closePrice, winner, t20sBull, t20sBear, t20sTotal, finalBull, finalBear, finalTotal] = round;

  // Check if new day (reset daily high at midnight UTC)
  const roundDate = new Date(lockTs * 1000);
  const dayKey = roundDate.toISOString().split('T')[0]; // YYYY-MM-DD

  if (dayKey !== currentDay) {
    // New day detected
    if (currentDay !== null) {
      dailyResets.push({
        date: dayKey,
        oldHigh: dailyHigh,
        newHigh: balance,
        wasPaused: tradingPaused
      });
    }
    currentDay = dayKey;
    dailyHigh = balance;
    tradingPaused = false; // Reset pause at new day
  }

  // Check daily drawdown
  const dailyDrawdown = (balance - dailyHigh) / dailyHigh;
  if (dailyDrawdown <= -CONFIG.SAFETY.dailyDrawdownLimit) {
    if (!tradingPaused) {
      tradingPaused = true;
      pausedDays.push({
        date: dayKey,
        epoch: epoch,
        balance: balance.toFixed(2),
        dailyHigh: dailyHigh.toFixed(2),
        drawdown: (dailyDrawdown * 100).toFixed(2)
      });
    }
    continue; // Skip this round, trading paused
  }

  // Update daily high if balance increased
  if (balance > dailyHigh) {
    dailyHigh = balance;
  }

  // Get EMA values
  const roundedLockTs = Math.floor(lockTs / 300) * 300;
  const fast = emaFastMap.get(roundedLockTs);
  const slow = emaSlowMap.get(roundedLockTs);

  if (!fast || !slow) continue;

  // EMA Signal
  const emaDiff = Math.abs(fast - slow) / slow;
  if (emaDiff < CONFIG.STRATEGY.emaGap) continue;

  const emaBullish = fast > slow;
  const emaBearish = fast < slow;

  // Implied Payout at T-20s
  const t20sBullImplied = Number(t20sTotal) / Number(t20sBull);
  const t20sBearImplied = Number(t20sTotal) / Number(t20sBear);

  const bullCrowdStrong = t20sBullImplied <= CONFIG.STRATEGY.maxImpliedPayout;
  const bearCrowdStrong = t20sBearImplied <= CONFIG.STRATEGY.maxImpliedPayout;

  const signalBull = emaBullish && bullCrowdStrong;
  const signalBear = emaBearish && bearCrowdStrong;

  if (!signalBull && !signalBear) continue;

  const position = signalBull ? 'BULL' : 'BEAR';

  // Use FINAL payout
  const finalBullPayout = Number(finalTotal) / Number(finalBull);
  const finalBearPayout = Number(finalTotal) / Number(finalBear);
  const actualPayout = signalBull ? finalBullPayout : finalBearPayout;

  const priceUp = Number(closePrice) > Number(lockPrice);
  const won = (position === 'BULL' && priceUp) || (position === 'BEAR' && !priceUp);

  const betSize = balance * CONFIG.STRATEGY.positionSize;
  const payout = won ? betSize * actualPayout : 0;
  const profit = payout - betSize;

  balance += profit;

  // Track overall drawdown
  if (balance > maxBalance) {
    maxBalance = balance;
  }
  const overallDrawdown = ((balance - maxBalance) / maxBalance) * 100;
  if (overallDrawdown < maxDrawdown) {
    maxDrawdown = overallDrawdown;
  }

  if (won) wins++;
  else losses++;

  const t20sImplied = signalBull ? t20sBullImplied : t20sBearImplied;

  trades.push({
    epoch,
    date: dayKey,
    position,
    t20sImplied: t20sImplied.toFixed(3),
    actualPayout: actualPayout.toFixed(3),
    won,
    profit: profit.toFixed(4),
    balance: balance.toFixed(2),
    dailyHigh: dailyHigh.toFixed(2),
    dailyDD: ((balance - dailyHigh) / dailyHigh * 100).toFixed(2)
  });
}

// ============================================================================
// RESULTS
// ============================================================================

console.log('═══════════════════════════════════════════════════════════');
console.log('RESULTS WITH 20% DAILY DRAWDOWN LIMIT');
console.log('═══════════════════════════════════════════════════════════\n');

const totalTrades = wins + losses;
const winRate = (wins / totalTrades) * 100;
const roi = ((balance / 10 - 1) * 100);

console.log(`Starting Balance:     10.00 BNB`);
console.log(`Final Balance:        ${balance.toFixed(2)} BNB`);
console.log(`Profit/Loss:          ${(balance - 10).toFixed(2)} BNB`);
console.log(`ROI:                  ${roi.toFixed(2)}%`);
console.log(`Max Drawdown:         ${maxDrawdown.toFixed(2)}%`);
console.log();
console.log(`Total Trades:         ${totalTrades} out of ${rounds.length} rounds`);
console.log(`Wins:                 ${wins} (${winRate.toFixed(2)}%)`);
console.log(`Losses:               ${losses} (${(100-winRate).toFixed(2)}%)`);
console.log();
console.log(`Days Trading Paused:  ${pausedDays.length} days`);
console.log(`Daily Resets:         ${dailyResets.length} times`);
console.log();

if (pausedDays.length > 0) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('DAYS WHEN TRADING WAS PAUSED (20% DD Hit)');
  console.log('═══════════════════════════════════════════════════════════\n');

  pausedDays.forEach(p => {
    console.log(`Date: ${p.date} | Epoch: ${p.epoch} | Balance: ${p.balance} BNB | Daily High: ${p.dailyHigh} BNB | DD: ${p.drawdown}%`);
  });
  console.log();
}

console.log('═══════════════════════════════════════════════════════════');
console.log('FIRST 20 TRADES');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('Date       | Epoch  | Pos  | T20s  | Final | Result | Profit   | Balance | Daily DD');
console.log('-----------|--------|------|-------|-------|--------|----------|---------|----------');

trades.slice(0, 20).forEach(t => {
  const result = t.won ? 'WIN ✓' : 'LOSS ✗';
  console.log(
    `${t.date} | ${t.epoch} | ${t.position.padEnd(4)} | ${t.t20sImplied} | ${t.actualPayout} | ${result.padEnd(6)} | ${t.profit.padStart(8)} | ${t.balance.padStart(7)} | ${t.dailyDD.padStart(6)}%`
  );
});

console.log('\n═══════════════════════════════════════════════════════════\n');

// Comparison
console.log('COMPARISON:\n');
console.log('WITHOUT 20% DD Limit: +425.51% ROI (198 trades)');
console.log(`WITH 20% DD Limit:    ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}% ROI (${totalTrades} trades)`);
console.log();

const difference = roi - 425.51;
if (difference < 0) {
  console.log(`⚠️ DD limit reduces ROI by ${Math.abs(difference).toFixed(2)}% (cost of safety)`);
} else {
  console.log(`✅ DD limit improves ROI by ${difference.toFixed(2)}%`);
}

db.close();
