import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';

console.log('\n🔍 TESTING STRATEGY ON LAST 2 HOURS\n');
console.log('═'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

// Get current time and 2 hours ago
const now = Math.floor(Date.now() / 1000);
const twoHoursAgo = now - (2 * 60 * 60);

// Get rounds from last 2 hours
const rounds = db.prepare(`
  SELECT
    sample_id,
    epoch,
    lock_timestamp,
    lock_price,
    close_price,
    t20s_bull_wei,
    t20s_bear_wei,
    lock_bull_wei,
    lock_bear_wei,
    winner,
    winner_payout_multiple,
    ema_signal,
    ema_gap,
    ema3,
    ema7
  FROM rounds
  WHERE lock_timestamp >= ?
    AND t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all(twoHoursAgo);

console.log(`📊 Found ${rounds.length} complete rounds in last 2 hours\n`);

if (rounds.length === 0) {
  console.log('❌ No complete rounds found in last 2 hours\n');
  db.close();
  process.exit(0);
}

console.log(`   Date range: ${new Date(rounds[0].lock_timestamp * 1000).toISOString()}`);
console.log(`            to ${new Date(rounds[rounds.length - 1].lock_timestamp * 1000).toISOString()}\n`);

// Fetch BNB/USDT EMA from Binance API
async function getTradingViewEMA(timestamp) {
  try {
    const endTime = timestamp * 1000;
    const startTime = endTime - (7 * 5 * 60 * 1000); // 7 candles × 5 minutes

    const url = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=7`;
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const candles = await response.json();

    if (!Array.isArray(candles) || candles.length < 7) {
      return null;
    }

    // Calculate EMA3 and EMA7 from closes (simple average)
    const closes = candles.map(c => parseFloat(c[4]));
    const ema3 = closes.slice(-3).reduce((a, b) => a + b) / 3;
    const ema7 = closes.reduce((a, b) => a + b) / 7;
    const gap = ((ema3 - ema7) / ema7) * 100;

    // Signal: BULL if gap > 0.05%, BEAR if gap < -0.05%, else NEUTRAL
    const signal = gap > 0.05 ? 'BULL' : gap < -0.05 ? 'BEAR' : 'NEUTRAL';

    return {
      signal,
      gap: parseFloat(gap.toFixed(3)),
      ema3: parseFloat(ema3.toFixed(2)),
      ema7: parseFloat(ema7.toFixed(2))
    };

  } catch (err) {
    return null;
  }
}

// Backfill EMA data for rounds missing it
console.log('🔄 Fetching EMA data from TradingView (Binance API)...\n');

for (let i = 0; i < rounds.length; i++) {
  if (!rounds[i].ema_signal || !rounds[i].ema_gap) {
    const emaData = await getTradingViewEMA(rounds[i].lock_timestamp);
    if (emaData) {
      rounds[i].ema_signal = emaData.signal;
      rounds[i].ema_gap = emaData.gap;
      rounds[i].ema3 = emaData.ema3;
      rounds[i].ema7 = emaData.ema7;

      // Update database
      db.prepare(`
        UPDATE rounds
        SET ema_signal = ?, ema_gap = ?, ema3 = ?, ema7 = ?
        WHERE sample_id = ?
      `).run(emaData.signal, emaData.gap, emaData.ema3, emaData.ema7, rounds[i].sample_id);
    }
    await new Promise(resolve => setTimeout(resolve, 100)); // Rate limit
  }
}

console.log('✅ EMA data ready\n');
console.log('─'.repeat(100) + '\n');

// Configuration
const CONFIG = {
  CROWD_THRESHOLD: 0.65,
  EMA_GAP_THRESHOLD: 0.05,
  MAX_PAYOUT: 1.45,
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  STARTING_BANKROLL: 1.0
};

console.log('⚙️  STRATEGY CONDITIONS:\n');
console.log('  1. EMA Signal: BULL or BEAR (gap > 0.05% or < -0.05%)');
console.log('  2. Contrarian Filter: Estimated payout ≥ 1.45x (crowd on opposite side)');
console.log('  3. Fakeout Detection: Skip if 2+ factors (EMA shrink, extreme crowd, price extreme)');
console.log('  4. Position Sizing: 4.5% base, 8.5% momentum (gap ≥0.15%), 1.5x recovery after loss\n');
console.log('─'.repeat(100) + '\n');

console.log('📊 EMA PARAMETERS:\n');
console.log('  Data Source: TradingView (Binance API - BNBUSDT 5m)');
console.log('  EMA3 Period: 3 candles (simple average of last 3 closes)');
console.log('  EMA7 Period: 7 candles (simple average of 7 closes)');
console.log('  Gap Threshold: 0.05% (NEUTRAL if gap < 0.05%)');
console.log('  Momentum Threshold: 0.15% (triggers 8.5% position size)\n');
console.log('─'.repeat(100) + '\n');

// Multi-factor fakeout detection
function detectFakeout(rounds, index, signal) {
  if (index < 2 || index >= rounds.length - 1) return false;

  const current = rounds[index];
  const prev = rounds[index - 1];

  // Get EMA gaps
  const currentGap = Math.abs(parseFloat(current.ema_gap));
  const prevGap = Math.abs(parseFloat(prev.ema_gap));

  // Get crowd percentages
  const bullWei = parseFloat(current.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(current.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;
  if (total === 0) return false;

  const bullPct = (bullWei / total) * 100;
  const bearPct = (bearWei / total) * 100;

  // Get 14-period price range
  const lookback = 14;
  const startIdx = Math.max(0, index - lookback);
  const priceWindow = rounds.slice(startIdx, index + 1);
  const prices = priceWindow.map(r => {
    const lock = Number(r.lock_price);
    const close = Number(r.close_price);
    if (lock > 0) return lock / 1e8;
    if (close > 0) return close / 1e8;
    return 0;
  }).filter(p => p > 0);

  if (prices.length === 0) return false;

  const highest = Math.max(...prices);
  const lowest = Math.min(...prices);
  const range = highest - lowest;
  if (range === 0) return false;

  const currentLock = Number(current.lock_price);
  const currentClose = Number(current.close_price);
  const currentPrice = currentLock > 0 ? currentLock / 1e8 : currentClose > 0 ? currentClose / 1e8 : 0;
  if (currentPrice === 0) return false;

  const pricePosition = (currentPrice - lowest) / range;

  let fakeoutScore = 0;

  // Factor 1: EMA gap shrinking by 20%
  if (currentGap < prevGap * 0.8) {
    fakeoutScore += 1;
  }

  // Factor 2: Extreme crowd (>80% on our side)
  if (signal === 'BULL' && bullPct > 80) {
    fakeoutScore += 1;
  } else if (signal === 'BEAR' && bearPct > 80) {
    fakeoutScore += 1;
  }

  // Factor 3: Price at extreme of range
  if (signal === 'BULL' && pricePosition > 0.8) {
    fakeoutScore += 1;
  } else if (signal === 'BEAR' && pricePosition < 0.2) {
    fakeoutScore += 1;
  }

  return fakeoutScore >= 2;
}

// Trading state
let bankroll = CONFIG.STARTING_BANKROLL;
let lastTwoResults = [];
let totalTrades = 0;
let wins = 0;
let losses = 0;
let totalProfit = 0;

let skippedPayout = 0;
let skippedFakeout = 0;

const tradeLog = [];

// Process rounds
for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];

  // Calculate T-20s crowd
  const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;

  if (total === 0) continue;

  const bullPercent = (bullWei / total) * 100;
  const bearPercent = (bearWei / total) * 100;

  // Calculate estimated payout at T-20s (with 3% house edge)
  const bullPayout = bullWei > 0 ? (total * 0.97) / bullWei : 0;
  const bearPayout = bearWei > 0 ? (total * 0.97) / bearWei : 0;

  // Determine which side is underdog (higher payout)
  const estimatedPayout = Math.max(bullPayout, bearPayout);

  // Get EMA signal
  const emaSignal = r.ema_signal;
  const emaGap = parseFloat(r.ema_gap);

  if (!emaSignal || emaSignal === 'NEUTRAL') continue;

  // FILTER 1: Payout must be ≥1.45x (contrarian - crowd on opposite side)
  if (estimatedPayout < CONFIG.MAX_PAYOUT) {
    skippedPayout++;
    continue;
  }

  // Check if this meets contrarian criteria (EMA says one side, crowd on opposite)
  let isContrarian = false;
  if (emaSignal === 'BULL' && bearPayout >= CONFIG.MAX_PAYOUT) {
    isContrarian = true; // EMA bullish, crowd bearish
  } else if (emaSignal === 'BEAR' && bullPayout >= CONFIG.MAX_PAYOUT) {
    isContrarian = true; // EMA bearish, crowd bullish
  }

  if (!isContrarian) {
    skippedPayout++;
    continue;
  }

  // FILTER 2: Fakeout detection
  const isFakeout = detectFakeout(rounds, i, emaSignal);
  if (isFakeout) {
    skippedFakeout++;
    continue;
  }

  // Determine bet side based on EMA (ALWAYS follow EMA)
  const betSide = emaSignal === 'BULL' ? 'BULL' : 'BEAR';

  // Calculate bet size with dynamic positioning
  let sizeMultiplier = 1.0;

  // Momentum multiplier (8.5% = 1.889x base 4.5%)
  if (Math.abs(emaGap) >= 0.15) {
    sizeMultiplier = CONFIG.MOMENTUM_MULTIPLIER;
  }

  // Recovery multiplier (1.5x)
  if (lastTwoResults[0] === 'LOSS') {
    sizeMultiplier *= CONFIG.RECOVERY_MULTIPLIER;
  }

  const betSize = bankroll * CONFIG.BASE_POSITION_SIZE * sizeMultiplier;

  // Execute trade
  totalTrades++;
  const won = betSide.toLowerCase() === r.winner.toLowerCase();
  const actualPayout = parseFloat(r.winner_payout_multiple);

  let tradePnL;
  let newBankroll;

  if (won) {
    tradePnL = betSize * (actualPayout - 1);
    newBankroll = bankroll + tradePnL;
    wins++;
    lastTwoResults.unshift('WIN');
  } else {
    tradePnL = -betSize;
    newBankroll = bankroll - betSize;
    losses++;
    lastTwoResults.unshift('LOSS');
  }

  if (lastTwoResults.length > 2) lastTwoResults.pop();

  totalProfit += tradePnL;
  const oldBankroll = bankroll;
  bankroll = newBankroll;

  // Log this trade
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
    oldBankroll,
    newBankroll,
    bullPct: bullPercent,
    bearPct: bearPercent,
    bullPayout,
    bearPayout,
    estimatedPayout
  });
}

// Final summary
console.log('📊 RESULTS - LAST 2 HOURS\n');
console.log('═'.repeat(100) + '\n');

console.log('🎯 TRADE STATISTICS:\n');
console.log(`  Total rounds analyzed:        ${rounds.length}`);
console.log(`  EMA signals (non-NEUTRAL):    ${rounds.filter(r => r.ema_signal && r.ema_signal !== 'NEUTRAL').length}`);
console.log(`  Skipped (payout <1.45x):      ${skippedPayout}`);
console.log(`  Skipped (fakeout filter):     ${skippedFakeout}`);
console.log(`  Total trades executed:        ${totalTrades}\n`);

console.log(`  Wins:                         ${wins} (${totalTrades > 0 ? ((wins/totalTrades)*100).toFixed(2) : '0.00'}%)`);
console.log(`  Losses:                       ${losses} (${totalTrades > 0 ? ((losses/totalTrades)*100).toFixed(2) : '0.00'}%)\n`);

console.log('💰 BANKROLL PERFORMANCE:\n');
console.log(`  Starting bankroll:            ${CONFIG.STARTING_BANKROLL.toFixed(6)} BNB`);
console.log(`  Final bankroll:               ${bankroll.toFixed(6)} BNB`);
console.log(`  Total P&L:                    ${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(6)} BNB`);
console.log(`  ROI:                          ${totalTrades > 0 ? ((totalProfit / CONFIG.STARTING_BANKROLL) * 100).toFixed(2) : '0.00'}%\n`);

console.log('─'.repeat(100) + '\n');

// Show all trades
if (totalTrades > 0) {
  console.log('📋 TRADE LOG:\n');

  for (const trade of tradeLog) {
    const status = trade.won ? '✅ WIN ' : '❌ LOSS';
    const pnlStr = trade.tradePnL >= 0 ? `+${trade.tradePnL.toFixed(6)}` : trade.tradePnL.toFixed(6);
    const date = new Date(trade.timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19);
    const emaDir = trade.emaGap > 0 ? '📈 BULL' : '📉 BEAR';
    const momentum = Math.abs(trade.emaGap) >= 0.15 ? '🔥' : '  ';
    const recovery = trade.sizeMultiplier >= 2.0 ? '🔄' : '  ';

    console.log(`Trade #${trade.tradeNum.toString().padStart(2)} | ${date} | Epoch ${trade.epoch}`);
    console.log(`  EMA: ${emaDir} (${(trade.emaGap * 100).toFixed(3)}%) ${momentum}${recovery}`);
    console.log(`  Bet: ${trade.betSide} | Size: ${trade.betSize.toFixed(6)} BNB (${(trade.sizeMultiplier * 4.5).toFixed(2)}%)`);
    console.log(`  Crowd: Bull ${trade.bullPct.toFixed(1)}% (${trade.bullPayout.toFixed(2)}x) / Bear ${trade.bearPct.toFixed(1)}% (${trade.bearPayout.toFixed(2)}x)`);
    console.log(`  ${status} | Actual Payout: ${trade.actualPayout.toFixed(3)}x | P&L: ${pnlStr} BNB`);
    console.log(`  Bankroll: ${trade.oldBankroll.toFixed(6)} → ${trade.newBankroll.toFixed(6)}`);
    console.log('');
  }

  console.log('─'.repeat(100) + '\n');

  // Verify EMA alignment
  const emaAligned = tradeLog.filter(t => t.betSide === t.emaSignal).length;

  console.log('✅ VERIFICATION:\n');
  console.log(`  Trades aligned with EMA:      ${emaAligned}/${totalTrades} (${((emaAligned/totalTrades)*100).toFixed(1)}%)\n`);

  if (emaAligned === totalTrades) {
    console.log('✅ ALL TRADES FOLLOWED EMA DIRECTION (With Trend + Against Crowd)\n');
  }
} else {
  console.log('⚠️  No trades executed in last 2 hours (no signals met all filters)\n');
}

console.log('═'.repeat(100) + '\n');

db.close();
