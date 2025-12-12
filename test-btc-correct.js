import Database from 'better-sqlite3';
import fetch from 'node-fetch';

const db = new Database('./resolved_markets.db', { readonly: true });

console.log('\n🧪 TESTING BTC STRATEGY - CORRECT IMPLEMENTATION\n');
console.log('═'.repeat(80) + '\n');

// Get all markets
const markets = db.prepare('SELECT * FROM market_metadata ORDER BY first_timestamp ASC').all();

console.log(`📊 Analyzing ${markets.length} BTC markets...\n`);
console.log('─'.repeat(80) + '\n');

// Extract T-5min-20s data (equivalent to 5 minutes before close)
const marketData = [];

for (const market of markets) {
  const snapshots = db.prepare(`
    SELECT timestamp, mid_price, best_bid, best_ask
    FROM orderbook_snapshots
    WHERE market_id = ? AND outcome_name = 'Yes'
    ORDER BY timestamp ASC
  `).all(market.market_id);

  if (snapshots.length === 0) continue;

  // These are 15-minute markets
  // We want T-5m-20s = 5 minutes 20 seconds before market close
  // That's roughly at 67% through the market (10min / 15min = 0.67)

  const marketDuration = market.duration_minutes;
  const timeBeforeClose = 5 + (20 / 60); // 5 minutes 20 seconds
  const targetPoint = 1 - (timeBeforeClose / marketDuration); // e.g., 1 - (5.33 / 15) = 0.645

  const targetIndex = Math.floor(snapshots.length * targetPoint);

  // Find closest snapshot with valid data around target point
  let entrySnapshot = null;
  const searchRange = Math.floor(snapshots.length * 0.05); // Search ±5% around target

  for (let i = targetIndex; i >= Math.max(0, targetIndex - searchRange); i--) {
    if (snapshots[i].mid_price !== null && snapshots[i].best_ask !== null && snapshots[i].best_bid !== null) {
      entrySnapshot = snapshots[i];
      break;
    }
  }

  if (!entrySnapshot) {
    console.log(`⚠️  Skipping market ${market.market_id} - no valid entry point`);
    continue;
  }

  // Calculate time before close
  const entryTime = entrySnapshot.timestamp;
  const closeTime = market.last_timestamp;
  const secondsBeforeClose = closeTime - entryTime;
  const minutesBeforeClose = (secondsBeforeClose / 60).toFixed(1);

  // Parse winner
  const winningOutcomes = JSON.parse(market.winning_outcomes);
  const yesWon = winningOutcomes.some(w => w.outcome === 'Yes');
  const actualWinner = yesWon ? 'BULL' : 'BEAR'; // Yes = UP = BULL, No = DOWN = BEAR

  // Crowd sentiment at entry
  const crowdYesPercent = entrySnapshot.mid_price * 100;
  const crowdNoPercent = 100 - crowdYesPercent;

  // Determine which side has ≥65% crowd
  let crowdSide = null;
  let crowdPercent = 0;
  let entryPriceCents = 0;

  if (crowdYesPercent >= 65) {
    crowdSide = 'BULL'; // Crowd betting YES (UP)
    crowdPercent = crowdYesPercent;
    entryPriceCents = entrySnapshot.best_ask; // Price to buy YES
  } else if (crowdNoPercent >= 65) {
    crowdSide = 'BEAR'; // Crowd betting NO (DOWN)
    crowdPercent = crowdNoPercent;
    entryPriceCents = 1.0 - entrySnapshot.best_bid; // Price to buy NO (inverse)
  }

  if (!crowdSide) {
    // No strong crowd
    continue;
  }

  // Payout calculation (Polymarket style)
  // If we buy at X cents, we get $1.00 per share if we win
  // So profit per share = $1.00 - $X = $(1 - X)
  // Payout multiple = $1.00 / $X
  const payoutMultiple = entryPriceCents > 0 ? (1.0 / entryPriceCents) : 1.0;

  marketData.push({
    market_id: market.market_id,
    title: market.market_title,
    timestamp: market.first_timestamp,
    entry_time: entryTime,
    minutes_before_close: minutesBeforeClose,
    crowd_side: crowdSide,
    crowd_percent: crowdPercent.toFixed(2),
    entry_price_cents: entryPriceCents.toFixed(3),
    payout_multiple: payoutMultiple.toFixed(3),
    actual_winner: actualWinner
  });
}

console.log(`✅ Found ${marketData.length} markets with strong crowd (≥65%) at entry point\n`);
console.log('─'.repeat(80) + '\n');

// Show all markets
console.log('📝 ALL VALID MARKETS:\n');
for (let i = 0; i < marketData.length; i++) {
  const m = marketData[i];
  console.log(`${i + 1}. ${m.title.substring(0, 50)}`);
  console.log(`   Entry: ${m.minutes_before_close}min before close`);
  console.log(`   Crowd: ${m.crowd_percent}% ${m.crowd_side} | Price: ${m.entry_price_cents}¢ | Payout: ${m.payout_multiple}x`);
  console.log(`   Winner: ${m.actual_winner}`);
  console.log('');
}

if (marketData.length === 0) {
  console.log('❌ No markets found with strong crowd at entry point!\n');
  db.close();
  process.exit(0);
}

console.log('─'.repeat(80) + '\n');

// Fetch BTC EMA
async function getEMASignal(timestamp) {
  try {
    const endTime = timestamp * 1000;
    const startTime = endTime - (7 * 5 * 60 * 1000); // 7 candles × 5 minutes

    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=7`;
    const response = await fetch(url);
    const candles = await response.json();

    if (!Array.isArray(candles) || candles.length < 7) return null;

    const closes = candles.map(c => parseFloat(c[4]));
    const ema3 = closes.slice(-3).reduce((a, b) => a + b) / 3;
    const ema7 = closes.reduce((a, b) => a + b) / 7;
    const gap = ((ema3 - ema7) / ema7) * 100;
    const signal = gap > 0.05 ? 'BULL' : gap < -0.05 ? 'BEAR' : 'NEUTRAL';

    return { signal, gap: gap.toFixed(3), ema3: ema3.toFixed(2), ema7: ema7.toFixed(2) };
  } catch (err) {
    console.error(`   ❌ EMA error: ${err.message}`);
    return null;
  }
}

// Test ORIGINAL strategy: Bet WITH crowd when EMA confirms
console.log('🎯 TESTING ORIGINAL STRATEGY:\n');
console.log('   Strategy: Bet WITH crowd (≥65%) + EMA confirmation\n');
console.log('─'.repeat(80) + '\n');

let totalTrades = 0;
let wins = 0;
let losses = 0;
let totalProfit = 0;

for (const m of marketData) {
  console.log(`Checking market ${m.market_id} (entry ${m.minutes_before_close}min before close)...`);

  const emaData = await getEMASignal(m.entry_time);
  if (!emaData) {
    console.log(`  ⏭️  Skipped (no EMA data)\n`);
    continue;
  }

  // ORIGINAL STRATEGY: Bet WITH crowd when EMA confirms
  let betSide = null;
  if (m.crowd_side === 'BULL' && emaData.signal === 'BULL') {
    betSide = 'BULL'; // Trend following
  } else if (m.crowd_side === 'BEAR' && emaData.signal === 'BEAR') {
    betSide = 'BEAR';
  }

  if (!betSide) {
    console.log(`  ⏭️  No trade (EMA ${emaData.signal} doesn't confirm crowd ${m.crowd_side})\n`);
    continue;
  }

  // Execute trade
  totalTrades++;
  const won = betSide === m.actual_winner;

  // Calculate profit (Polymarket style)
  // We spend X cents per share
  // If win: we get $1.00, profit = $1.00 - X = $(1 - X)
  // If lose: we lose X cents
  const entryPrice = parseFloat(m.entry_price_cents);
  const tradeProfit = won ? (1.0 - entryPrice) : -entryPrice;

  totalProfit += tradeProfit;

  if (won) {
    wins++;
    console.log(`  ✅ WIN | Bet: ${betSide} @ ${m.entry_price_cents}¢ | Winner: ${m.actual_winner} | Profit: +${tradeProfit.toFixed(3)}`);
  } else {
    losses++;
    console.log(`  ❌ LOSS | Bet: ${betSide} @ ${m.entry_price_cents}¢ | Winner: ${m.actual_winner} | Loss: ${tradeProfit.toFixed(3)}`);
  }

  console.log(`     Crowd: ${m.crowd_percent}% ${m.crowd_side} | EMA: ${emaData.signal} (gap ${emaData.gap}%)`);
  console.log('');

  await new Promise(resolve => setTimeout(resolve, 200));
}

console.log('═'.repeat(80) + '\n');
console.log('📊 FINAL RESULTS:\n');
console.log(`  Total trades: ${totalTrades}`);
console.log(`  Wins: ${wins} (${totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : 0}%)`);
console.log(`  Losses: ${losses}`);
console.log(`  Total profit: ${totalProfit.toFixed(3)} units`);
console.log(`  Average profit per trade: ${totalTrades > 0 ? (totalProfit / totalTrades).toFixed(3) : 0} units`);
console.log(`  ROI: ${totalTrades > 0 ? ((totalProfit / totalTrades) * 100).toFixed(2) : 0}%`);
console.log('\n' + '═'.repeat(80) + '\n');

db.close();
