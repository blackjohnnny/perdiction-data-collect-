import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n📈 EMA STRATEGY WITH TAKE PROFIT SYSTEM\n');
console.log('═'.repeat(80) + '\n');

const db = initDatabase(DB_PATH);

// Get all complete rounds with stored EMA data from TradingView/Binance API
const rounds = db.prepare(`
  SELECT
    sample_id,
    epoch,
    lock_timestamp,
    winner,
    winner_payout_multiple,
    ema_gap
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_gap IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Found ${rounds.length} complete rounds with TradingView EMA data\n`);
console.log('═'.repeat(80) + '\n');

// Test different take profit thresholds
const takeProfitLevels = [
  { name: 'No Take Profit', threshold: null, reduction: 0 },
  { name: '10% TP → 50% size', threshold: 0.10, reduction: 0.50 },
  { name: '15% TP → 50% size', threshold: 0.15, reduction: 0.50 },
  { name: '20% TP → 50% size', threshold: 0.20, reduction: 0.50 },
  { name: '25% TP → 50% size', threshold: 0.25, reduction: 0.50 },
  { name: '30% TP → 50% size', threshold: 0.30, reduction: 0.50 },
  { name: '10% TP → 25% size', threshold: 0.10, reduction: 0.25 },
  { name: '15% TP → 25% size', threshold: 0.15, reduction: 0.25 },
  { name: '20% TP → 25% size', threshold: 0.20, reduction: 0.25 },
];

const EMA_GAP_THRESHOLD = 0.05; // Using best gap from previous test
const STARTING_BANKROLL = 1.0;
const BASE_BET_SIZE = 0.01; // 1% of starting bankroll per trade

console.log('🎯 STRATEGY SETUP:\n');
console.log(`  EMA Gap Threshold: ${EMA_GAP_THRESHOLD}%`);
console.log(`  Starting Bankroll: ${STARTING_BANKROLL.toFixed(2)} BNB`);
console.log(`  Base Bet Size: ${BASE_BET_SIZE} BNB (1% of bankroll)`);
console.log('\n' + '─'.repeat(80) + '\n');

const results = [];

for (const tpConfig of takeProfitLevels) {
  let bankroll = STARTING_BANKROLL;
  let baseSize = BASE_BET_SIZE;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalProfit = 0;
  let maxBankroll = STARTING_BANKROLL;
  let maxDrawdown = 0;
  let takeProfitTriggered = false;
  let tradesBeforeTP = 0;
  let tradesAfterTP = 0;

  for (const r of rounds) {
    const emaGap = parseFloat(r.ema_gap);

    // Determine bet side based on EMA
    let betSide = null;
    if (emaGap > EMA_GAP_THRESHOLD) {
      betSide = 'BULL';
    } else if (emaGap < -EMA_GAP_THRESHOLD) {
      betSide = 'BEAR';
    }

    if (!betSide) continue;

    // Check if we hit take profit threshold
    const currentROI = (bankroll - STARTING_BANKROLL) / STARTING_BANKROLL;

    if (!takeProfitTriggered && tpConfig.threshold && currentROI >= tpConfig.threshold) {
      takeProfitTriggered = true;
      baseSize = BASE_BET_SIZE * tpConfig.reduction; // Reduce bet size
      tradesBeforeTP = totalTrades;
    }

    // Calculate bet size
    const betSize = baseSize;

    // Execute trade
    totalTrades++;
    if (takeProfitTriggered) {
      tradesAfterTP++;
    }

    const won = betSide === r.winner.toUpperCase();
    const payout = parseFloat(r.winner_payout_multiple);

    let tradePnL;
    if (won) {
      tradePnL = betSize * (payout - 1);
      wins++;
    } else {
      tradePnL = -betSize;
      losses++;
    }

    totalProfit += tradePnL;
    bankroll += tradePnL;

    // Track max bankroll and drawdown
    if (bankroll > maxBankroll) {
      maxBankroll = bankroll;
    }
    const currentDrawdown = (bankroll - maxBankroll) / maxBankroll;
    if (currentDrawdown < maxDrawdown) {
      maxDrawdown = currentDrawdown;
    }
  }

  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100) : 0;
  const finalROI = ((bankroll - STARTING_BANKROLL) / STARTING_BANKROLL) * 100;

  results.push({
    name: tpConfig.name,
    threshold: tpConfig.threshold,
    reduction: tpConfig.reduction,
    totalTrades,
    wins,
    losses,
    winRate,
    totalProfit,
    finalBankroll: bankroll,
    finalROI,
    maxDrawdown,
    takeProfitTriggered,
    tradesBeforeTP,
    tradesAfterTP
  });
}

// Display results
console.log('📊 TAKE PROFIT COMPARISON:\n');
console.log('┌────────────────────────┬────────┬──────────┬──────────────┬──────────┬──────────────┬────────────┐');
console.log('│   Take Profit Config   │ Trades │ Win Rate │ Final Bank   │ Final ROI│ Max Drawdown │ TP Hit?    │');
console.log('├────────────────────────┼────────┼──────────┼──────────────┼──────────┼──────────────┼────────────┤');

for (const r of results) {
  const name = r.name.padEnd(22);
  const trades = r.totalTrades.toString().padStart(6);
  const winRate = r.winRate.toFixed(2).padStart(7) + '%';
  const bankroll = r.finalBankroll.toFixed(4).padStart(12) + ' BNB';
  const roi = (r.finalROI >= 0 ? '+' : '') + r.finalROI.toFixed(2).padStart(7) + '%';
  const drawdown = (r.maxDrawdown * 100).toFixed(2).padStart(11) + '%';
  const tpHit = r.takeProfitTriggered ? `Yes (${r.tradesBeforeTP}→${r.tradesAfterTP})` : 'No';
  const tpHitPadded = tpHit.padEnd(10);

  console.log(`│ ${name} │ ${trades} │ ${winRate} │ ${bankroll} │ ${roi} │ ${drawdown} │ ${tpHitPadded} │`);
}

console.log('└────────────────────────┴────────┴──────────┴──────────────┴──────────┴──────────────┴────────────┘');

// Find best configurations
const bestROI = results.reduce((best, current) =>
  current.finalROI > best.finalROI ? current : best
, results[0]);

const bestDrawdown = results.reduce((best, current) =>
  current.maxDrawdown > best.maxDrawdown ? current : best
, results[0]);

const bestBankroll = results.reduce((best, current) =>
  current.finalBankroll > best.finalBankroll ? current : best
, results[0]);

console.log('\n' + '═'.repeat(80) + '\n');
console.log('🏆 BEST CONFIGURATIONS:\n');
console.log(`  Highest Final ROI:      ${bestROI.name} → ${bestROI.finalROI.toFixed(2)}% (${bestROI.finalBankroll.toFixed(4)} BNB)`);
console.log(`  Lowest Max Drawdown:    ${bestDrawdown.name} → ${(bestDrawdown.maxDrawdown * 100).toFixed(2)}%`);
console.log(`  Highest Final Bankroll: ${bestBankroll.name} → ${bestBankroll.finalBankroll.toFixed(4)} BNB`);

console.log('\n📝 EXPLANATION:\n');
console.log('  Take Profit (TP) System:');
console.log('  - When bankroll reaches +X% ROI, reduce bet size to lock in gains');
console.log('  - "50% size" = reduce bets to 50% of original (0.5% of starting bankroll)');
console.log('  - "25% size" = reduce bets to 25% of original (0.25% of starting bankroll)');
console.log('  - This protects profits from large drawdowns while still trading');

console.log('\n' + '═'.repeat(80) + '\n');

db.close();
