import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🔍 TESTING STRATEGY ON LAST 100 ROUNDS\n');
console.log('═'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

// Get last 100 complete rounds with EMA data
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
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp DESC
  LIMIT 100
`).all();

// Reverse to get chronological order
rounds.reverse();

console.log(`📊 Testing on last ${rounds.length} complete rounds\n`);
console.log(`   Date range: ${new Date(rounds[0].lock_timestamp * 1000).toISOString()}`);
console.log(`            to ${new Date(rounds[rounds.length - 1].lock_timestamp * 1000).toISOString()}\n`);
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
  const prices = priceWindow.map(r => Number(r.lock_price) / 1e8);
  const highest = Math.max(...prices);
  const lowest = Math.min(...prices);
  const range = highest - lowest;
  if (range === 0) return false;

  const currentPrice = Number(current.lock_price) / 1e8;
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

  // Calculate estimated payout at T-20s
  const estimatedPayout = bullPercent > bearPercent
    ? total / bullWei
    : total / bearWei;

  // Get EMA signal
  const emaSignal = r.ema_signal;
  const emaGap = parseFloat(r.ema_gap);

  if (!emaSignal || emaSignal === 'NEUTRAL') continue;

  // FILTER 1: Payout must be ≥1.45x (contrarian)
  if (estimatedPayout < CONFIG.MAX_PAYOUT) {
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
    won,
    actualPayout,
    tradePnL,
    oldBankroll,
    newBankroll,
    bullPct: bullPercent,
    bearPct: bearPercent,
    estimatedPayout
  });
}

// Final summary
console.log('📊 RESULTS ON LAST 100 ROUNDS\n');
console.log('═'.repeat(100) + '\n');

console.log('🎯 TRADE STATISTICS:\n');
console.log(`  EMA signals in 100 rounds:    ${rounds.filter(r => r.ema_signal && r.ema_signal !== 'NEUTRAL').length}`);
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
    const alignment = trade.betSide === trade.emaSignal ? '✓' : '✗';

    console.log(`Trade #${trade.tradeNum.toString().padStart(2)} | ${date} | Epoch ${trade.epoch}`);
    console.log(`  EMA: ${emaDir} (${(trade.emaGap * 100).toFixed(3)}%) | Bet: ${trade.betSide} ${alignment} | Size: ${trade.betSize.toFixed(6)} BNB`);
    console.log(`  Crowd: Bull ${trade.bullPct.toFixed(1)}% / Bear ${trade.bearPct.toFixed(1)}% | Est Payout: ${trade.estimatedPayout.toFixed(2)}x`);
    console.log(`  ${status} | Actual Payout: ${trade.actualPayout.toFixed(3)}x | P&L: ${pnlStr} BNB`);
    console.log(`  Bankroll: ${trade.oldBankroll.toFixed(6)} → ${trade.newBankroll.toFixed(6)}`);
    console.log('');
  }

  console.log('─'.repeat(100) + '\n');

  // Verify EMA alignment
  const emaAligned = tradeLog.filter(t => t.betSide === t.emaSignal).length;
  const emaMisaligned = tradeLog.filter(t => t.betSide !== t.emaSignal).length;

  console.log('✅ EMA ALIGNMENT VERIFICATION:\n');
  console.log(`  Trades aligned with EMA:      ${emaAligned} (${((emaAligned/totalTrades)*100).toFixed(1)}%)`);
  console.log(`  Trades against EMA:           ${emaMisaligned} (${((emaMisaligned/totalTrades)*100).toFixed(1)}%)\n`);

  if (emaMisaligned > 0) {
    console.log('⚠️  WARNING: Some trades were NOT aligned with EMA!\n');
  } else {
    console.log('✅ ALL TRADES FOLLOWED EMA DIRECTION\n');
  }
} else {
  console.log('⚠️  No trades executed in last 100 rounds (no signals met all filters)\n');
}

console.log('═'.repeat(100) + '\n');

db.close();
