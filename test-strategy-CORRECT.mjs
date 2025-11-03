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
    maxImpliedPayout: 1.85,       // At T-20s, implied payout must be ≤ 1.85x (means ≥54% crowd on that side)
    positionSize: 0.065           // 6.5% base position
  }
};

console.log('═══════════════════════════════════════════════════════════');
console.log('CORRECTED BACKTEST - Using Proper T-20s Logic');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('Strategy Rules:');
console.log('1. DECISION at T-20s:');
console.log('   - EMA3 vs EMA7 with gap ≥ 0.05%');
console.log('   - IMPLIED payout at T-20s ≤ 1.85x (crowd ≥54% on that side)');
console.log('   - EMA direction must match the side with low payout');
console.log('2. PROFIT calculation:');
console.log('   - Use ACTUAL FINAL payout when round closes');
console.log('   - NOT the implied payout at T-20s\n');

// ============================================================================
// LOAD DATA
// ============================================================================

const SQL = await initSqlJs();
const buffer = readFileSync(CONFIG.DATABASE);
const db = new SQL.Database(buffer);

// Get rounds with T-20s data
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
console.log('Running CORRECTED strategy simulation...\n');

// ============================================================================
// BACKTEST
// ============================================================================

let balance = 10.0;
let wins = 0;
let losses = 0;
const trades = [];
let maxBalance = balance;
let maxDrawdown = 0;

for (const round of rounds) {
  const [epoch, lockTs, lockPrice, closePrice, winner, t20sBull, t20sBear, t20sTotal, finalBull, finalBear, finalTotal] = round;

  // Get EMA values at lock time
  const roundedLockTs = Math.floor(lockTs / 300) * 300;
  const fast = emaFastMap.get(roundedLockTs);
  const slow = emaSlowMap.get(roundedLockTs);

  if (!fast || !slow) continue;

  // ============================================================================
  // DECISION LOGIC AT T-20s
  // ============================================================================

  // 1. EMA Signal
  const emaDiff = Math.abs(fast - slow) / slow;
  if (emaDiff < CONFIG.STRATEGY.emaGap) continue; // Skip if gap too small

  const emaBullish = fast > slow;
  const emaBearish = fast < slow;

  // 2. Implied Payout at T-20s (what we see when making decision)
  const t20sBullImplied = Number(t20sTotal) / Number(t20sBull);
  const t20sBearImplied = Number(t20sTotal) / Number(t20sBear);

  // 3. Check if implied payout confirms strong crowd
  const bullCrowdStrong = t20sBullImplied <= CONFIG.STRATEGY.maxImpliedPayout; // Low payout = many people on BULL
  const bearCrowdStrong = t20sBearImplied <= CONFIG.STRATEGY.maxImpliedPayout; // Low payout = many people on BEAR

  // 4. Entry condition: EMA direction + crowd confirmation
  const signalBull = emaBullish && bullCrowdStrong;
  const signalBear = emaBearish && bearCrowdStrong;

  if (!signalBull && !signalBear) continue; // Skip if no signal

  // ============================================================================
  // PROFIT CALCULATION USING FINAL PAYOUT
  // ============================================================================

  const position = signalBull ? 'BULL' : 'BEAR';

  // IMPORTANT: Use FINAL pool amounts for actual payout (not T-20s implied)
  const finalBullPayout = Number(finalTotal) / Number(finalBull);
  const finalBearPayout = Number(finalTotal) / Number(finalBear);
  const actualPayout = signalBull ? finalBullPayout : finalBearPayout;

  // Check if we won
  const priceUp = Number(closePrice) > Number(lockPrice);
  const won = (position === 'BULL' && priceUp) || (position === 'BEAR' && !priceUp);

  // Calculate P&L
  const betSize = balance * CONFIG.STRATEGY.positionSize;
  const payout = won ? betSize * actualPayout : 0;
  const profit = payout - betSize;

  balance += profit;

  // Track drawdown
  if (balance > maxBalance) {
    maxBalance = balance;
  }
  const drawdown = ((balance - maxBalance) / maxBalance) * 100;
  if (drawdown < maxDrawdown) {
    maxDrawdown = drawdown;
  }

  if (won) wins++;
  else losses++;

  // Store trade info
  const t20sImplied = signalBull ? t20sBullImplied : t20sBearImplied;
  const crowdPct = signalBull ? (Number(t20sBull) / Number(t20sTotal)) : (Number(t20sBear) / Number(t20sTotal));

  trades.push({
    epoch,
    position,
    emaDiff: (emaDiff * 100).toFixed(3),
    crowdPct: (crowdPct * 100).toFixed(1),
    t20sImplied: t20sImplied.toFixed(3),
    actualPayout: actualPayout.toFixed(3),
    payoutDiff: (actualPayout - t20sImplied).toFixed(3),
    won,
    profit: profit.toFixed(4),
    balance: balance.toFixed(2)
  });
}

// ============================================================================
// RESULTS
// ============================================================================

console.log('═══════════════════════════════════════════════════════════');
console.log('RESULTS');
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
console.log(`Total Trades:         ${totalTrades} out of ${rounds.length} rounds (${(totalTrades/rounds.length*100).toFixed(1)}%)`);
console.log(`Wins:                 ${wins} (${winRate.toFixed(2)}%)`);
console.log(`Losses:               ${losses} (${(100-winRate).toFixed(2)}%)`);
console.log();

// Average payouts
const avgT20sImplied = trades.reduce((sum, t) => sum + parseFloat(t.t20sImplied), 0) / trades.length;
const avgActualPayout = trades.reduce((sum, t) => sum + parseFloat(t.actualPayout), 0) / trades.length;
const avgPayoutIncrease = avgActualPayout - avgT20sImplied;

console.log(`Avg IMPLIED payout (T-20s): ${avgT20sImplied.toFixed(3)}x`);
console.log(`Avg ACTUAL payout (final):  ${avgActualPayout.toFixed(3)}x`);
console.log(`Avg payout increase:        +${avgPayoutIncrease.toFixed(3)}x (${(avgPayoutIncrease/avgT20sImplied*100).toFixed(1)}%)`);
console.log();

console.log('═══════════════════════════════════════════════════════════');
console.log('FIRST 20 TRADES');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('Epoch  | Pos  | EMA% | Crowd% | T-20s | Final | Diff  | Result | Profit   | Balance');
console.log('-------|------|------|--------|-------|-------|-------|--------|----------|--------');

trades.slice(0, 20).forEach(t => {
  const result = t.won ? 'WIN ✓' : 'LOSS ✗';
  console.log(
    `${t.epoch} | ${t.position.padEnd(4)} | ${t.emaDiff.padStart(4)}% | ${t.crowdPct.padStart(5)}% | ${t.t20sImplied} | ${t.actualPayout} | ${t.payoutDiff} | ${result.padEnd(6)} | ${t.profit.padStart(8)} | ${t.balance.padStart(7)}`
  );
});

console.log('\n═══════════════════════════════════════════════════════════\n');

db.close();
