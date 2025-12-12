import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n📈 EMA-ONLY STRATEGY - TESTING DIFFERENT GAP THRESHOLDS\n');
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
    ema_signal,
    ema_gap,
    ema3,
    ema7
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
    AND ema_gap IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Found ${rounds.length} complete rounds with TradingView EMA data\n`);
console.log('═'.repeat(80) + '\n');

// Test different EMA gap thresholds
const gapThresholds = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.15, 0.20];

const results = [];

for (const threshold of gapThresholds) {
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalProfit = 0;
  let skippedNoSignal = 0;

  for (const r of rounds) {
    // Use stored EMA data (from TradingView/Binance API)
    const emaGap = parseFloat(r.ema_gap);

    // EMA-ONLY STRATEGY: Follow EMA signal based on gap threshold
    let betSide = null;
    if (emaGap > threshold) {
      betSide = 'BULL';
    } else if (emaGap < -threshold) {
      betSide = 'BEAR';
    }

    if (!betSide) {
      skippedNoSignal++;
      continue;
    }

    // Execute trade
    totalTrades++;
    const won = betSide === r.winner.toUpperCase();

    if (won) {
      wins++;
      const payout = parseFloat(r.winner_payout_multiple);
      totalProfit += (payout - 1);
    } else {
      losses++;
      totalProfit -= 1;
    }
  }

  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100) : 0;
  const roi = totalTrades > 0 ? ((totalProfit / totalTrades) * 100) : 0;

  results.push({
    threshold,
    totalTrades,
    wins,
    losses,
    winRate,
    totalProfit,
    roi,
    skipped: skippedNoSignal
  });
}

// Display results in a table
console.log('📊 EMA GAP THRESHOLD COMPARISON:\n');
console.log('┌──────────┬────────┬──────┬────────┬──────────┬────────────┬──────────┬──────────┐');
console.log('│ Gap (%)  │ Trades │ Wins │ Losses │ Win Rate │   Profit   │   ROI    │ Skipped  │');
console.log('├──────────┼────────┼──────┼────────┼──────────┼────────────┼──────────┼──────────┤');

for (const r of results) {
  const gap = r.threshold.toFixed(2).padStart(4);
  const trades = r.totalTrades.toString().padStart(6);
  const wins = r.wins.toString().padStart(4);
  const losses = r.losses.toString().padStart(6);
  const winRate = r.winRate.toFixed(2).padStart(8) + '%';
  const profit = (r.totalProfit >= 0 ? '+' : '') + r.totalProfit.toFixed(2).padStart(9);
  const roi = (r.roi >= 0 ? '+' : '') + r.roi.toFixed(2).padStart(7) + '%';
  const skipped = r.skipped.toString().padStart(8);

  console.log(`│  ${gap}    │ ${trades} │ ${wins} │ ${losses} │ ${winRate} │ ${profit} │ ${roi} │ ${skipped} │`);
}

console.log('└──────────┴────────┴──────┴────────┴──────────┴────────────┴──────────┴──────────┘');

// Find best ROI
const bestROI = results.reduce((best, current) =>
  current.roi > best.roi ? current : best
, results[0]);

const bestWinRate = results.reduce((best, current) =>
  current.winRate > best.winRate ? current : best
, results[0]);

const bestProfit = results.reduce((best, current) =>
  current.totalProfit > best.totalProfit ? current : best
, results[0]);

console.log('\n' + '═'.repeat(80) + '\n');
console.log('🏆 BEST RESULTS:\n');
console.log(`  Highest ROI:        ${bestROI.threshold.toFixed(2)}% gap → ${bestROI.roi.toFixed(2)}% ROI (${bestROI.totalTrades} trades, ${bestROI.winRate.toFixed(2)}% win rate)`);
console.log(`  Highest Win Rate:   ${bestWinRate.threshold.toFixed(2)}% gap → ${bestWinRate.winRate.toFixed(2)}% win rate (${bestWinRate.totalTrades} trades, ${bestWinRate.roi.toFixed(2)}% ROI)`);
console.log(`  Highest Profit:     ${bestProfit.threshold.toFixed(2)}% gap → +${bestProfit.totalProfit.toFixed(2)} units (${bestProfit.totalTrades} trades, ${bestProfit.roi.toFixed(2)}% ROI)`);
console.log('\n' + '═'.repeat(80) + '\n');

db.close();
