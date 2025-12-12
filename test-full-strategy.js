import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';

console.log('\n🚀 FULL STRATEGY TEST - ALL COMPONENTS\n');
console.log('═'.repeat(80) + '\n');

const db = initDatabase(DB_PATH);

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Trading parameters
  CROWD_THRESHOLD: 0.65,        // Bet WITH crowd when ≥65%
  EMA_GAP_THRESHOLD: 0.05,      // Minimum 0.05% gap for valid signal
  MAX_PAYOUT: 1.85,             // Only trade if T-20s payout < 1.85x
  BASE_POSITION_SIZE: 0.065,    // 6.5% of bankroll

  // Dynamic positioning
  RECOVERY_MULTIPLIER: 1.5,     // Increase to 9.75% after a loss
  PROFIT_TAKING_MULTIPLIER: 0.75, // Reduce to 4.875% after 2 wins

  // Daily limits
  MAX_DAILY_DRAWDOWN: -0.10,    // Stop trading if down 10% in a day
  STARTING_BANKROLL: 1.0,       // 1 BNB starting balance

  // API settings
  API_DELAY_MS: 100,            // Rate limit delay
  CACHE_EMA: true               // Cache EMA data to avoid refetching
};

// ============================================================================
// EMA CALCULATION & FETCHING
// ============================================================================

/**
 * Calculate exponential moving average
 */
function calculateEMA(prices, period) {
  if (prices.length < period) return null;

  const k = 2 / (period + 1);
  let ema = prices[0];

  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }

  return ema;
}

/**
 * Fetch BNB price data and calculate EMA signals
 */
async function getEMASignal(timestamp) {
  try {
    const endTime = timestamp * 1000;
    const startTime = endTime - (7 * 5 * 60 * 1000); // 7 candles × 5 min

    const url = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=7`;
    const response = await fetch(url);

    if (!response.ok) return null;

    const candles = await response.json();
    if (!Array.isArray(candles) || candles.length < 7) return null;

    const closes = candles.map(c => parseFloat(c[4]));

    const ema3 = calculateEMA(closes.slice(-3), 3);
    const ema7 = calculateEMA(closes, 7);

    if (!ema3 || !ema7) return null;

    const gap = ((ema3 - ema7) / ema7) * 100;

    // Determine signal
    let signal = 'NEUTRAL';
    if (Math.abs(gap) >= CONFIG.EMA_GAP_THRESHOLD) {
      signal = gap > 0 ? 'BULL' : 'BEAR';
    }

    return {
      signal,
      gap,
      ema3,
      ema7,
      closes
    };

  } catch (err) {
    console.error(`Error fetching EMA: ${err.message}`);
    return null;
  }
}

// ============================================================================
// STRATEGY LOGIC
// ============================================================================

/**
 * Determine if we should trade and which side
 * CROWD-FOLLOWING STRATEGY: Bet WITH the crowd when EMA confirms
 */
function shouldTrade(emaSignal, bullPercent, bearPercent, t20sPayout) {
  if (!emaSignal || emaSignal.signal === 'NEUTRAL') {
    return { trade: false, reason: 'No EMA signal' };
  }

  // Check payout filter
  if (t20sPayout >= CONFIG.MAX_PAYOUT) {
    return { trade: false, reason: `Payout too high (${t20sPayout.toFixed(2)}x ≥ ${CONFIG.MAX_PAYOUT}x)` };
  }

  // Check crowd sentiment
  const crowdBull = bullPercent >= CONFIG.CROWD_THRESHOLD * 100;
  const crowdBear = bearPercent >= CONFIG.CROWD_THRESHOLD * 100;

  if (!crowdBull && !crowdBear) {
    return { trade: false, reason: 'No strong crowd (< 65%)' };
  }

  // CROWD-FOLLOWING LOGIC
  // If EMA shows BULL trend and crowd is heavily BULL → bet BULL (with crowd)
  // If EMA shows BEAR trend and crowd is heavily BEAR → bet BEAR (with crowd)

  if (emaSignal.signal === 'BULL' && crowdBull) {
    return {
      trade: true,
      side: 'BULL',
      reason: `EMA bullish (${emaSignal.gap.toFixed(3)}%), crowd ${bullPercent.toFixed(1)}% bull, payout ${t20sPayout.toFixed(2)}x → bet BULL`
    };
  }

  if (emaSignal.signal === 'BEAR' && crowdBear) {
    return {
      trade: true,
      side: 'BEAR',
      reason: `EMA bearish (${emaSignal.gap.toFixed(3)}%), crowd ${bearPercent.toFixed(1)}% bear, payout ${t20sPayout.toFixed(2)}x → bet BEAR`
    };
  }

  return {
    trade: false,
    reason: 'EMA and crowd not aligned'
  };
}

/**
 * Calculate bet size with dynamic positioning
 */
function calculateBetSize(bankroll, lastTwoResults) {
  let multiplier = 1.0;

  const [result1, result2] = lastTwoResults;

  // Recovery mode: After a loss following wins
  if (result1 === 'LOSS' && result2 === 'WIN') {
    multiplier = CONFIG.RECOVERY_MULTIPLIER;
  }

  // Profit-taking mode: After 2 consecutive wins
  if (result1 === 'WIN' && result2 === 'WIN') {
    multiplier = CONFIG.PROFIT_TAKING_MULTIPLIER;
  }

  return bankroll * CONFIG.BASE_POSITION_SIZE * multiplier;
}

/**
 * Check if we've hit daily drawdown limit
 */
function checkDailyDrawdown(dailyPnL, bankroll) {
  const dailyReturn = dailyPnL / bankroll;

  if (dailyReturn <= CONFIG.MAX_DAILY_DRAWDOWN) {
    return {
      shouldStop: true,
      reason: `Daily drawdown limit hit: ${(dailyReturn * 100).toFixed(2)}%`
    };
  }

  return { shouldStop: false };
}

// ============================================================================
// MAIN TEST EXECUTION
// ============================================================================

async function runTest() {
  // Get all complete rounds with stored EMA data
  const rounds = db.prepare(`
    SELECT
      sample_id,
      epoch,
      lock_timestamp,
      t20s_bull_wei,
      t20s_bear_wei,
      winner,
      winner_payout_multiple,
      ema_signal,
      ema_gap,
      ema3,
      ema7
    FROM rounds
    WHERE t20s_timestamp IS NOT NULL
      AND winner IS NOT NULL
      AND ema_signal IS NOT NULL
    ORDER BY lock_timestamp ASC
  `).all();

  console.log(`📊 Testing on ${rounds.length} complete rounds\n`);
  console.log('─'.repeat(80) + '\n');

  // Trading state
  let bankroll = CONFIG.STARTING_BANKROLL;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalPnL = 0;

  let lastTwoResults = [null, null]; // Track last 2 results for dynamic sizing
  let dailyPnL = 0;
  let currentDay = null;
  let dailyTrades = 0;

  let skipped = {
    noEMA: 0,
    noCrowd: 0,
    noConfirm: 0,
    payoutTooHigh: 0,
    dailyLimit: 0
  };

  const tradeLog = [];

  // Process each round
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    if (i % 100 === 0 && i > 0) {
      console.log(`  Processed ${i}/${rounds.length} rounds...`);
    }

    // Track daily reset
    const roundDate = new Date(r.lock_timestamp * 1000).toDateString();
    if (currentDay !== roundDate) {
      currentDay = roundDate;
      dailyPnL = 0;
      dailyTrades = 0;
    }

    // Check daily drawdown
    const ddCheck = checkDailyDrawdown(dailyPnL, bankroll);
    if (ddCheck.shouldStop) {
      skipped.dailyLimit++;
      continue;
    }

    // Calculate crowd sentiment
    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;

    if (total === 0) {
      skipped.noCrowd++;
      continue;
    }

    const bullPercent = (bullWei / total) * 100;
    const bearPercent = (bearWei / total) * 100;

    // Calculate T-20s payout (what our side would get if we win)
    const t20sPayout = bullPercent >= 50
      ? (total / bullWei)  // If bull is majority, payout is total/bull
      : (total / bearWei); // If bear is majority, payout is total/bear

    // Use stored EMA data from database (already fetched from TradingView/Binance)
    const emaSignal = {
      signal: r.ema_signal,
      gap: parseFloat(r.ema_gap),
      ema3: parseFloat(r.ema3),
      ema7: parseFloat(r.ema7)
    };

    if (!emaSignal.signal) {
      skipped.noEMA++;
      continue;
    }

    // Decide if we should trade
    const decision = shouldTrade(emaSignal, bullPercent, bearPercent, t20sPayout);

    if (!decision.trade) {
      if (decision.reason.includes('No strong crowd')) {
        skipped.noCrowd++;
      } else if (decision.reason.includes('Payout too high')) {
        skipped.payoutTooHigh++;
      } else {
        skipped.noConfirm++;
      }
      continue;
    }

    // Calculate bet size with dynamic positioning
    const betSize = calculateBetSize(bankroll, lastTwoResults);
    const betSide = decision.side;

    // Execute trade
    totalTrades++;
    dailyTrades++;

    const won = betSide.toLowerCase() === r.winner.toLowerCase();
    const payout = parseFloat(r.winner_payout_multiple);

    let tradePnL;
    if (won) {
      tradePnL = betSize * (payout - 1);
      wins++;
      lastTwoResults = ['WIN', lastTwoResults[0]];
    } else {
      tradePnL = -betSize;
      losses++;
      lastTwoResults = ['LOSS', lastTwoResults[0]];
    }

    totalPnL += tradePnL;
    dailyPnL += tradePnL;
    bankroll += tradePnL;

    // Log trade
    tradeLog.push({
      epoch: r.epoch,
      betSide,
      betSize: betSize.toFixed(4),
      winner: r.winner,
      won,
      payout: payout.toFixed(3),
      pnl: tradePnL.toFixed(4),
      bankroll: bankroll.toFixed(4),
      reason: decision.reason
    });
  }

  // ============================================================================
  // FINAL RESULTS
  // ============================================================================

  console.log('\n' + '═'.repeat(80) + '\n');
  console.log('📊 FINAL RESULTS\n');
  console.log('─'.repeat(80) + '\n');

  console.log('📈 PERFORMANCE:\n');
  console.log(`  Total rounds analyzed:    ${rounds.length}`);
  console.log(`  Total trades executed:    ${totalTrades}`);
  console.log(`  Wins:                     ${wins} (${totalTrades > 0 ? ((wins/totalTrades)*100).toFixed(2) : 0}%)`);
  console.log(`  Losses:                   ${losses} (${totalTrades > 0 ? ((losses/totalTrades)*100).toFixed(2) : 0}%)`);
  console.log(`  Win rate:                 ${totalTrades > 0 ? ((wins/totalTrades)*100).toFixed(2) : 0}%`);

  console.log('\n💰 P&L:\n');
  console.log(`  Starting bankroll:        ${CONFIG.STARTING_BANKROLL.toFixed(4)} BNB`);
  console.log(`  Final bankroll:           ${bankroll.toFixed(4)} BNB`);
  console.log(`  Total P&L:                ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(4)} BNB`);
  console.log(`  ROI:                      ${((totalPnL / CONFIG.STARTING_BANKROLL) * 100).toFixed(2)}%`);
  console.log(`  Avg profit per trade:     ${(totalPnL / totalTrades).toFixed(4)} BNB`);

  console.log('\n🚫 SKIPPED TRADES:\n');
  console.log(`  No EMA data:              ${skipped.noEMA}`);
  console.log(`  No strong crowd (<65%):   ${skipped.noCrowd}`);
  console.log(`  Payout too high (≥1.85x): ${skipped.payoutTooHigh}`);
  console.log(`  EMA/crowd not aligned:    ${skipped.noConfirm}`);
  console.log(`  Daily drawdown limit:     ${skipped.dailyLimit}`);
  console.log(`  Total skipped:            ${Object.values(skipped).reduce((a, b) => a + b, 0)}`);

  console.log('\n📋 STRATEGY PARAMETERS:\n');
  console.log(`  Crowd threshold:          ${CONFIG.CROWD_THRESHOLD * 100}%`);
  console.log(`  EMA gap threshold:        ${CONFIG.EMA_GAP_THRESHOLD}%`);
  console.log(`  Max payout filter:        <${CONFIG.MAX_PAYOUT}x`);
  console.log(`  Base position size:       ${CONFIG.BASE_POSITION_SIZE * 100}%`);
  console.log(`  Recovery multiplier:      ${CONFIG.RECOVERY_MULTIPLIER}x`);
  console.log(`  Profit-taking mult:       ${CONFIG.PROFIT_TAKING_MULTIPLIER}x`);
  console.log(`  Max daily drawdown:       ${CONFIG.MAX_DAILY_DRAWDOWN * 100}%`);

  console.log('\n' + '═'.repeat(80) + '\n');

  // Show last 10 trades
  if (tradeLog.length > 0) {
    console.log('📝 LAST 10 TRADES:\n');
    const lastTrades = tradeLog.slice(-10);
    for (const t of lastTrades) {
      const status = t.won ? '✅ WIN' : '❌ LOSS';
      console.log(`  Epoch ${t.epoch}: ${t.betSide} ${t.betSize} BNB → ${status} | P&L: ${t.pnl} | Bankroll: ${t.bankroll}`);
    }
    console.log('\n' + '═'.repeat(80) + '\n');
  }

  db.close();
}

// Run the test
runTest().catch(err => {
  console.error('Fatal error:', err);
  db.close();
  process.exit(1);
});
