import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

// ============================================================================
// CONFIGURATION - 10-MINUTE EMA TIMEFRAME TEST
// ============================================================================

const CONFIG = {
  DATABASE: './data/live.db',

  ROUNDS: {
    mode: 'all'
  },

  STRATEGY: {
    emaFast: 3,
    emaSlow: 7,
    emaTimeframe: 10,           // Calculate EMAs on 10-minute candles
    applyTimeframe: 5,          // Apply signals to 5-minute rounds
    emaGap: 0.0005,             // 0.05% minimum EMA gap
    crowdThreshold: 0.65,       // 65% crowd confirmation
    positionSize: 0.065         // 6.5% base position
  }
};

console.log('═══════════════════════════════════════════════════════════');
console.log('10-MINUTE EMA TIMEFRAME TEST');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('Strategy Configuration:');
console.log(`- EMA Fast/Slow: ${CONFIG.STRATEGY.emaFast}/${CONFIG.STRATEGY.emaSlow}`);
console.log(`- EMA Calculated on: ${CONFIG.STRATEGY.emaTimeframe}-minute candles`);
console.log(`- Applied to: ${CONFIG.STRATEGY.applyTimeframe}-minute rounds`);
console.log(`- EMA Gap Required: ${(CONFIG.STRATEGY.emaGap * 100).toFixed(2)}%`);
console.log(`- Crowd Threshold: ${(CONFIG.STRATEGY.crowdThreshold * 100)}%`);
console.log(`- Position Size: ${(CONFIG.STRATEGY.positionSize * 100)}%\n`);

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

// ============================================================================
// FETCH PRICE DATA - BOTH 5-MIN AND 10-MIN
// ============================================================================

console.log('Fetching TradingView price data...');
const lockTimes = rounds.map(r => r[1]);
const startTime = Math.min(...lockTimes) - 7200; // Extra buffer for 10-min candles
const endTime = Math.max(...lockTimes) + 3600;

// Fetch 5-minute candles first, then convert to 10-minute
const url5min = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.BNB/USD&resolution=5&from=${startTime}&to=${endTime}`;
const response5min = await globalThis.fetch(url5min);
const candles5min = await response5min.json();

console.log(`Fetched ${candles5min.t.length} 5-minute candles\n`);

// Convert 5-minute candles to 10-minute candles
function convert5minTo10min(candles5min) {
  const candles10min = { t: [], o: [], h: [], l: [], c: [], v: [] };

  for (let i = 0; i < candles5min.t.length; i += 2) {
    if (i + 1 < candles5min.t.length) {
      // Combine two 5-minute candles into one 10-minute candle
      candles10min.t.push(candles5min.t[i]);
      candles10min.o.push(candles5min.o[i]);
      candles10min.h.push(Math.max(candles5min.h[i], candles5min.h[i + 1]));
      candles10min.l.push(Math.min(candles5min.l[i], candles5min.l[i + 1]));
      candles10min.c.push(candles5min.c[i + 1]);
      candles10min.v.push(candles5min.v[i] + candles5min.v[i + 1]);
    }
  }

  return candles10min;
}

const candles10min = convert5minTo10min(candles5min);

console.log(`Converted to ${candles10min.t.length} 10-minute candles for EMA calculation\n`);

// ============================================================================
// CALCULATE EMAs ON 10-MINUTE TIMEFRAME
// ============================================================================

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const emaArray = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    emaArray.push(prices[i] * k + emaArray[i - 1] * (1 - k));
  }
  return emaArray;
}

const closePrices10min = candles10min.c;
const emaFast10min = calculateEMA(closePrices10min, CONFIG.STRATEGY.emaFast);
const emaSlow10min = calculateEMA(closePrices10min, CONFIG.STRATEGY.emaSlow);

// Build EMA maps with 10-minute timestamps
const emaFastMap = new Map();
const emaSlowMap = new Map();
candles10min.t.forEach((time, idx) => {
  emaFastMap.set(time, emaFast10min[idx]);
  emaSlowMap.set(time, emaSlow10min[idx]);
});

console.log(`Calculated EMA ${CONFIG.STRATEGY.emaFast}/${CONFIG.STRATEGY.emaSlow} on ${CONFIG.STRATEGY.emaTimeframe}-minute timeframe\n`);

// Helper function to get EMA values for a 5-minute timestamp
function getEMAFor5MinRound(lockTs5min) {
  // Round down to nearest 10-minute mark
  const lockTs10min = Math.floor(lockTs5min / 600) * 600;

  const fast = emaFastMap.get(lockTs10min);
  const slow = emaSlowMap.get(lockTs10min);

  return { fast, slow };
}

console.log('Running strategy simulation...\n');

// ============================================================================
// BACKTEST WITH DYNAMIC POSITION SIZING
// ============================================================================

let balance = 10.0;
let wins = 0;
let losses = 0;
const trades = [];
let maxBalance = balance;
let maxDrawdown = 0;

// Position sizing state
let justLost = false;
let currentWinStreak = 0;
let currentLossStreak = 0;

function getPositionSize(balance, justLost, currentWinStreak) {
  const BASE = CONFIG.STRATEGY.positionSize;
  if (justLost) return BASE * 1.5;        // 9.75% after loss
  if (currentWinStreak >= 2) return BASE * 0.75; // 4.875% after 2+ wins
  return BASE; // 6.5% normal
}

for (const round of rounds) {
  const [epoch, lockTs, lockPrice, closePrice, winner, t20sBull, t20sBear, t20sTotal, finalBull, finalBear, finalTotal] = round;

  // Get EMA values from 10-minute timeframe
  const { fast, slow } = getEMAFor5MinRound(lockTs);

  if (!fast || !slow) continue;

  // ============================================================================
  // DECISION LOGIC - EMA from 10-min + Crowd from 5-min
  // ============================================================================

  // 1. EMA Signal (calculated on 10-minute timeframe)
  const emaDiff = Math.abs(fast - slow) / slow;
  if (emaDiff < CONFIG.STRATEGY.emaGap) continue; // Skip if gap too small

  const emaBullish = fast > slow;
  const emaBearish = fast < slow;

  // 2. Crowd sentiment at T-20s (from 5-minute rounds)
  const t20sBullPct = Number(t20sBull) / Number(t20sTotal);
  const t20sBearPct = Number(t20sBear) / Number(t20sTotal);

  const crowdBullish = t20sBullPct >= CONFIG.STRATEGY.crowdThreshold;
  const crowdBearish = t20sBearPct >= CONFIG.STRATEGY.crowdThreshold;

  // 3. Entry condition: EMA direction + crowd confirmation
  const signalBull = emaBullish && crowdBullish;
  const signalBear = emaBearish && crowdBearish;

  if (!signalBull && !signalBear) continue; // Skip if no signal

  // ============================================================================
  // EXECUTE TRADE WITH DYNAMIC POSITION SIZING
  // ============================================================================

  const position = signalBull ? 'BULL' : 'BEAR';

  // Calculate actual payout
  const finalBullPayout = Number(finalTotal) / Number(finalBull);
  const finalBearPayout = Number(finalTotal) / Number(finalBear);
  const actualPayout = signalBull ? finalBullPayout : finalBearPayout;

  // Check if we won
  const priceUp = Number(closePrice) > Number(lockPrice);
  const won = (position === 'BULL' && priceUp) || (position === 'BEAR' && !priceUp);

  // Get dynamic position size
  const positionPct = getPositionSize(balance, justLost, currentWinStreak);
  const betSize = balance * positionPct;

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

  // Update win/loss tracking
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

  // Store trade info
  const crowdPct = signalBull ? t20sBullPct : t20sBearPct;

  trades.push({
    epoch,
    position,
    emaDiff: (emaDiff * 100).toFixed(3),
    crowdPct: (crowdPct * 100).toFixed(1),
    actualPayout: actualPayout.toFixed(3),
    positionPct: (positionPct * 100).toFixed(2),
    betSize: betSize.toFixed(4),
    won,
    profit: profit.toFixed(4),
    balance: balance.toFixed(2),
    winStreak: currentWinStreak,
    lossStreak: currentLossStreak
  });
}

// ============================================================================
// RESULTS
// ============================================================================

console.log('═══════════════════════════════════════════════════════════');
console.log('RESULTS - 10-MINUTE EMA TIMEFRAME');
console.log('═══════════════════════════════════════════════════════════\n');

const totalTrades = wins + losses;
const winRate = (wins / totalTrades) * 100;
const roi = ((balance / 10 - 1) * 100);

console.log(`Starting Balance:     10.00 BNB`);
console.log(`Final Balance:        ${balance.toFixed(2)} BNB`);
console.log(`Profit/Loss:          ${(balance - 10).toFixed(2)} BNB`);
console.log(`ROI:                  ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`);
console.log(`Max Drawdown:         ${maxDrawdown.toFixed(2)}%`);
console.log();
console.log(`Total Trades:         ${totalTrades} out of ${rounds.length} rounds (${(totalTrades/rounds.length*100).toFixed(1)}%)`);
console.log(`Wins:                 ${wins} (${winRate.toFixed(2)}%)`);
console.log(`Losses:               ${losses} (${(100-winRate).toFixed(2)}%)`);
console.log();

// Average payout
const avgActualPayout = trades.reduce((sum, t) => sum + parseFloat(t.actualPayout), 0) / trades.length;
console.log(`Avg actual payout:    ${avgActualPayout.toFixed(3)}x`);
console.log();

console.log('═══════════════════════════════════════════════════════════');
console.log('FIRST 30 TRADES');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('Epoch  | Pos  | EMA%  | Crowd% | Payout | Pos% | Bet    | Result | Profit   | Balance');
console.log('-------|------|-------|--------|--------|------|--------|--------|----------|--------');

trades.slice(0, 30).forEach(t => {
  const result = t.won ? 'WIN ✓' : 'LOSS ✗';
  console.log(
    `${t.epoch} | ${t.position.padEnd(4)} | ${t.emaDiff.padStart(5)}% | ${t.crowdPct.padStart(5)}% | ${t.actualPayout} | ${t.positionPct.padStart(5)}% | ${t.betSize} | ${result.padEnd(6)} | ${t.profit.padStart(8)} | ${t.balance.padStart(7)}`
  );
});

console.log('\n═══════════════════════════════════════════════════════════');
console.log('COMPARISON WITH ORIGINAL STRATEGY');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('Original Strategy (EMA 3/7 on 5-min):');
console.log('  - ROI: +781.46% (from PAPER-STRATEGY.md)');
console.log('  - Win Rate: 59.46%');
console.log('  - Max Drawdown: -48.60%');
console.log('  - Trades: 148/820 (18.0%)');
console.log();

console.log('New Strategy (EMA 3/7 on 10-min):');
console.log(`  - ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`);
console.log(`  - Win Rate: ${winRate.toFixed(2)}%`);
console.log(`  - Max Drawdown: ${maxDrawdown.toFixed(2)}%`);
console.log(`  - Trades: ${totalTrades}/${rounds.length} (${(totalTrades/rounds.length*100).toFixed(1)}%)`);
console.log();

const roiDiff = roi - 781.46;
const winRateDiff = winRate - 59.46;
const drawdownDiff = maxDrawdown - (-48.60);
const tradeDiff = totalTrades - 148;

console.log('Difference:');
console.log(`  - ROI: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}%`);
console.log(`  - Win Rate: ${winRateDiff >= 0 ? '+' : ''}${winRateDiff.toFixed(2)}%`);
console.log(`  - Max Drawdown: ${drawdownDiff >= 0 ? '+' : ''}${drawdownDiff.toFixed(2)}%`);
console.log(`  - Trades: ${tradeDiff >= 0 ? '+' : ''}${tradeDiff}`);
console.log();

if (roi > 781.46) {
  console.log('✅ 10-MINUTE EMA PERFORMS BETTER');
} else if (roi < 781.46) {
  console.log('❌ 10-MINUTE EMA PERFORMS WORSE');
} else {
  console.log('⚖️  SAME PERFORMANCE');
}

console.log('\n═══════════════════════════════════════════════════════════\n');

db.close();
