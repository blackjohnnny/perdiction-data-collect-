import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';

console.log('\n🔍 TESTING: BETTING WITH EMA + WITH CROWD (Last 2 Hours)\n');
console.log('═'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

const now = Math.floor(Date.now() / 1000);
const twoHoursAgo = now - (2 * 60 * 60);

const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE lock_timestamp >= ?
    AND t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all(twoHoursAgo);

console.log(`📊 Found ${rounds.length} complete rounds in last 2 hours\n`);

// Fetch EMA data
async function getTradingViewEMA(timestamp) {
  try {
    const endTime = timestamp * 1000;
    const startTime = endTime - (7 * 5 * 60 * 1000);
    const url = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=7`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const candles = await response.json();
    if (!Array.isArray(candles) || candles.length < 7) return null;

    const closes = candles.map(c => parseFloat(c[4]));
    const ema3 = closes.slice(-3).reduce((a, b) => a + b) / 3;
    const ema7 = closes.reduce((a, b) => a + b) / 7;
    const gap = ((ema3 - ema7) / ema7) * 100;
    const signal = gap > 0.05 ? 'BULL' : gap < -0.05 ? 'BEAR' : 'NEUTRAL';

    return { signal, gap: parseFloat(gap.toFixed(3)), ema3, ema7 };
  } catch (err) {
    return null;
  }
}

// Backfill EMA
for (let i = 0; i < rounds.length; i++) {
  if (!rounds[i].ema_signal) {
    const emaData = await getTradingViewEMA(rounds[i].lock_timestamp);
    if (emaData) {
      rounds[i].ema_signal = emaData.signal;
      rounds[i].ema_gap = emaData.gap;
      rounds[i].ema3 = emaData.ema3;
      rounds[i].ema7 = emaData.ema7;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

const CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  STARTING_BANKROLL: 1.0
};

console.log('⚙️  STRATEGY: WITH EMA + WITH CROWD\n');
console.log('  1. Follow EMA direction (BULL/BEAR)');
console.log('  2. Bet WITH the crowd (majority side)');
console.log('  3. Only trade when EMA + crowd AGREE\n');
console.log('─'.repeat(100) + '\n');

let bankroll = CONFIG.STARTING_BANKROLL;
let lastTwoResults = [];
let totalTrades = 0;
let wins = 0;
let losses = 0;
let totalProfit = 0;
const tradeLog = [];

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];

  const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;
  if (total === 0) continue;

  const bullPercent = (bullWei / total) * 100;
  const bearPercent = (bearWei / total) * 100;

  const emaSignal = r.ema_signal;
  const emaGap = parseFloat(r.ema_gap);

  if (!emaSignal || emaSignal === 'NEUTRAL') continue;

  // Determine crowd favorite
  const crowdFavorite = bullPercent > bearPercent ? 'BULL' : 'BEAR';

  // Only trade when EMA agrees with crowd
  if (emaSignal !== crowdFavorite) continue;

  const betSide = emaSignal;

  // Position sizing
  let sizeMultiplier = 1.0;
  if (Math.abs(emaGap) >= 0.15) {
    sizeMultiplier = CONFIG.MOMENTUM_MULTIPLIER;
  }
  if (lastTwoResults[0] === 'LOSS') {
    sizeMultiplier *= CONFIG.RECOVERY_MULTIPLIER;
  }

  const betSize = bankroll * CONFIG.BASE_POSITION_SIZE * sizeMultiplier;

  totalTrades++;
  const won = betSide.toLowerCase() === r.winner.toLowerCase();
  const actualPayout = parseFloat(r.winner_payout_multiple);

  let tradePnL;
  if (won) {
    tradePnL = betSize * (actualPayout - 1);
    bankroll += tradePnL;
    wins++;
    lastTwoResults.unshift('WIN');
  } else {
    tradePnL = -betSize;
    bankroll -= betSize;
    losses++;
    lastTwoResults.unshift('LOSS');
  }

  if (lastTwoResults.length > 2) lastTwoResults.pop();
  totalProfit += tradePnL;

  tradeLog.push({
    tradeNum: totalTrades,
    epoch: r.epoch,
    timestamp: r.lock_timestamp,
    betSide,
    emaSignal,
    emaGap,
    betSize,
    sizeMultiplier,
    won,
    actualPayout,
    tradePnL,
    bankroll,
    bullPct: bullPercent,
    bearPct: bearPercent,
    crowdFavorite
  });
}

console.log('📊 RESULTS: WITH EMA + WITH CROWD\n');
console.log('═'.repeat(100) + '\n');

console.log('🎯 TRADE STATISTICS:\n');
console.log(`  Total rounds analyzed:        ${rounds.length}`);
console.log(`  EMA + Crowd agreed:           ${totalTrades}`);
console.log(`  Total trades executed:        ${totalTrades}\n`);

console.log(`  Wins:                         ${wins} (${totalTrades > 0 ? ((wins/totalTrades)*100).toFixed(2) : '0.00'}%)`);
console.log(`  Losses:                       ${losses} (${totalTrades > 0 ? ((losses/totalTrades)*100).toFixed(2) : '0.00'}%)\n`);

console.log('💰 BANKROLL PERFORMANCE:\n');
console.log(`  Starting bankroll:            ${CONFIG.STARTING_BANKROLL.toFixed(6)} BNB`);
console.log(`  Final bankroll:               ${bankroll.toFixed(6)} BNB`);
console.log(`  Total P&L:                    ${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(6)} BNB`);
console.log(`  ROI:                          ${totalTrades > 0 ? ((totalProfit / CONFIG.STARTING_BANKROLL) * 100).toFixed(2) : '0.00'}%\n`);

console.log('─'.repeat(100) + '\n');

if (totalTrades > 0) {
  console.log('📋 TRADE LOG:\n');

  for (const trade of tradeLog) {
    const status = trade.won ? '✅ WIN ' : '❌ LOSS';
    const pnlStr = trade.tradePnL >= 0 ? `+${trade.tradePnL.toFixed(6)}` : trade.tradePnL.toFixed(6);
    const date = new Date(trade.timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19);
    const emaDir = trade.emaGap > 0 ? '📈 BULL' : '📉 BEAR';
    const momentum = Math.abs(trade.emaGap) >= 0.15 ? '🔥' : '  ';

    console.log(`Trade #${trade.tradeNum.toString().padStart(2)} | ${date} | Epoch ${trade.epoch}`);
    console.log(`  EMA: ${emaDir} (${(trade.emaGap * 100).toFixed(3)}%) ${momentum}`);
    console.log(`  Crowd: ${trade.crowdFavorite} (Bull ${trade.bullPct.toFixed(1)}% / Bear ${trade.bearPct.toFixed(1)}%)`);
    console.log(`  Bet: ${trade.betSide} | Size: ${trade.betSize.toFixed(6)} BNB`);
    console.log(`  ${status} | Payout: ${trade.actualPayout.toFixed(3)}x | P&L: ${pnlStr} BNB`);
    console.log(`  Bankroll: ${trade.bankroll.toFixed(6)}`);
    console.log('');
  }
}

console.log('═'.repeat(100) + '\n');

// COMPARISON
console.log('📊 STRATEGY COMPARISON (Last 2 Hours):\n');
console.log('  Contrarian (EMA + Against Crowd):');
console.log('    - Trades: 14');
console.log('    - Win Rate: 7.14%');
console.log('    - ROI: -70.02%\n');

console.log('  Consensus (EMA + With Crowd):');
console.log(`    - Trades: ${totalTrades}`);
console.log(`    - Win Rate: ${totalTrades > 0 ? ((wins/totalTrades)*100).toFixed(2) : '0.00'}%`);
console.log(`    - ROI: ${totalTrades > 0 ? ((totalProfit / CONFIG.STARTING_BANKROLL) * 100).toFixed(2) : '0.00'}%\n`);

const improvement = totalTrades > 0 ? ((totalProfit / CONFIG.STARTING_BANKROLL) * 100) - (-70.02) : 0;
console.log(`  📈 Improvement: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(2)}% ROI\n`);

console.log('═'.repeat(100) + '\n');

db.close();
