import Database from 'better-sqlite3';
import fetch from 'node-fetch';

const db = new Database('./resolved_markets.db', { readonly: true });

console.log('\n🧪 TESTING BTC STRATEGY - CORRECT CROWD LOGIC\n');
console.log('═'.repeat(80) + '\n');
console.log('CROWD LOGIC: Higher price = More crowd on that side\n');
console.log('  - If YES costs ≥65¢, crowd is betting YES (BULL)');
console.log('  - If NO costs ≥65¢, crowd is betting NO (BEAR)\n');
console.log('─'.repeat(80) + '\n');

const markets = db.prepare('SELECT * FROM market_metadata ORDER BY first_timestamp ASC').all();

console.log(`📊 Analyzing ${markets.length} BTC markets...\n`);

const marketData = [];

for (const market of markets) {
  const snapshots = db.prepare(`
    SELECT timestamp, mid_price, best_bid, best_ask
    FROM orderbook_snapshots
    WHERE market_id = ? AND outcome_name = 'Yes'
    ORDER BY timestamp ASC
  `).all(market.market_id);

  if (snapshots.length === 0) continue;

  // Entry at 5min 20sec before close
  const marketDuration = market.duration_minutes;
  const timeBeforeClose = 5 + (20 / 60);
  const targetPoint = 1 - (timeBeforeClose / marketDuration);
  const targetIndex = Math.floor(snapshots.length * targetPoint);

  let entrySnapshot = null;
  const searchRange = Math.floor(snapshots.length * 0.05);

  for (let i = targetIndex; i >= Math.max(0, targetIndex - searchRange); i--) {
    if (snapshots[i].best_ask !== null && snapshots[i].best_bid !== null) {
      entrySnapshot = snapshots[i];
      break;
    }
  }

  if (!entrySnapshot) continue;

  const entryTime = entrySnapshot.timestamp;
  const closeTime = market.last_timestamp;
  const minutesBeforeClose = ((closeTime - entryTime) / 60).toFixed(1);

  // CORRECT CROWD LOGIC: Price = Crowd
  const yesPriceCents = entrySnapshot.best_ask; // Cost to buy YES
  const noPriceCents = 1.0 - entrySnapshot.best_bid; // Cost to buy NO

  const yesPercent = yesPriceCents * 100; // YES price as percentage
  const noPercent = noPriceCents * 100; // NO price as percentage

  // Determine crowd side based on which is MORE EXPENSIVE (≥65¢)
  let crowdSide = null;
  let crowdPercent = 0;
  let entryPriceCents = 0;

  if (yesPriceCents >= 0.65) {
    // YES is expensive = crowd betting YES = BULL
    crowdSide = 'BULL';
    crowdPercent = yesPercent;
    entryPriceCents = yesPriceCents;
  } else if (noPriceCents >= 0.65) {
    // NO is expensive = crowd betting NO = BEAR
    crowdSide = 'BEAR';
    crowdPercent = noPercent;
    entryPriceCents = noPriceCents;
  }

  if (!crowdSide) continue; // No strong crowd

  // Parse winner
  const winningOutcomes = JSON.parse(market.winning_outcomes);
  const yesWon = winningOutcomes.some(w => w.outcome === 'Yes');
  const actualWinner = yesWon ? 'BULL' : 'BEAR';

  // Payout: If we pay X cents and win, we get $1.00, so payout = 1/X
  const payoutMultiple = entryPriceCents > 0 ? (1.0 / entryPriceCents) : 1.0;

  marketData.push({
    market_id: market.market_id,
    title: market.market_title,
    timestamp: market.first_timestamp,
    entry_time: entryTime,
    minutes_before_close: minutesBeforeClose,
    yes_price: yesPriceCents.toFixed(3),
    no_price: noPriceCents.toFixed(3),
    crowd_side: crowdSide,
    crowd_percent: crowdPercent.toFixed(2),
    entry_price_cents: entryPriceCents.toFixed(3),
    payout_multiple: payoutMultiple.toFixed(3),
    actual_winner: actualWinner
  });
}

console.log(`✅ Found ${marketData.length} markets with strong crowd (≥65¢ price)\n`);
console.log('─'.repeat(80) + '\n');

// Show all markets
console.log('📝 ALL VALID MARKETS:\n');
for (let i = 0; i < marketData.length; i++) {
  const m = marketData[i];
  console.log(`${i + 1}. ${m.title.substring(0, 50)}`);
  console.log(`   Entry: ${m.minutes_before_close}min before close`);
  console.log(`   Prices: YES=${m.yes_price}¢ | NO=${m.no_price}¢`);
  console.log(`   Crowd: ${m.crowd_percent}% ${m.crowd_side} | Entry: ${m.entry_price_cents}¢ | Payout: ${m.payout_multiple}x`);
  console.log(`   Winner: ${m.actual_winner}`);
  console.log('');
}

if (marketData.length === 0) {
  console.log('❌ No markets found with strong crowd!\n');
  db.close();
  process.exit(0);
}

console.log('─'.repeat(80) + '\n');

// Fetch BTC EMA
async function getEMASignal(timestamp) {
  try {
    const endTime = timestamp * 1000;
    const startTime = endTime - (7 * 5 * 60 * 1000);

    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=7`;
    const response = await fetch(url);
    const candles = await response.json();

    if (!Array.isArray(candles) || candles.length < 7) return null;

    const closes = candles.map(c => parseFloat(c[4]));
    const ema3 = closes.slice(-3).reduce((a, b) => a + b) / 3;
    const ema7 = closes.reduce((a, b) => a + b) / 7;
    const gap = ((ema3 - ema7) / ema7) * 100;
    const signal = gap > 0.05 ? 'BULL' : gap < -0.05 ? 'BEAR' : 'NEUTRAL';

    return { signal, gap: gap.toFixed(3) };
  } catch (err) {
    return null;
  }
}

// Test ORIGINAL strategy: Bet WITH crowd when EMA confirms
console.log('🎯 TESTING ORIGINAL STRATEGY:\n');
console.log('   Strategy: Bet WITH crowd (price ≥65¢) + EMA confirmation\n');
console.log('─'.repeat(80) + '\n');

let totalTrades = 0;
let wins = 0;
let losses = 0;
let totalProfit = 0;

for (const m of marketData) {
  console.log(`Market ${m.market_id} (${m.minutes_before_close}min before close)...`);

  const emaData = await getEMASignal(m.entry_time);
  if (!emaData) {
    console.log(`  ⏭️  Skipped (no EMA)\n`);
    continue;
  }

  // ORIGINAL: Bet WITH crowd when EMA confirms
  let betSide = null;
  if (m.crowd_side === 'BULL' && emaData.signal === 'BULL') {
    betSide = 'BULL';
  } else if (m.crowd_side === 'BEAR' && emaData.signal === 'BEAR') {
    betSide = 'BEAR';
  }

  if (!betSide) {
    console.log(`  ⏭️  No trade (EMA ${emaData.signal} ≠ crowd ${m.crowd_side})\n`);
    continue;
  }

  totalTrades++;
  const won = betSide === m.actual_winner;

  // Profit: Win = $1.00 - entry_price, Lose = -entry_price
  const entryPrice = parseFloat(m.entry_price_cents);
  const tradeProfit = won ? (1.0 - entryPrice) : -entryPrice;

  totalProfit += tradeProfit;

  if (won) {
    wins++;
    console.log(`  ✅ WIN | Bet ${betSide} @ ${m.entry_price_cents}¢ | Winner: ${m.actual_winner} | +${tradeProfit.toFixed(3)}`);
  } else {
    losses++;
    console.log(`  ❌ LOSS | Bet ${betSide} @ ${m.entry_price_cents}¢ | Winner: ${m.actual_winner} | ${tradeProfit.toFixed(3)}`);
  }

  console.log(`     Crowd: ${m.crowd_percent}% ${m.crowd_side} | EMA: ${emaData.signal} (${emaData.gap}%)`);
  console.log('');

  await new Promise(resolve => setTimeout(resolve, 200));
}

console.log('═'.repeat(80) + '\n');
console.log('📊 FINAL RESULTS:\n');
console.log(`  Trades: ${totalTrades}`);
console.log(`  Wins: ${wins} (${totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : 0}%)`);
console.log(`  Losses: ${losses}`);
console.log(`  Total profit: ${totalProfit.toFixed(3)} units`);
console.log(`  Avg per trade: ${totalTrades > 0 ? (totalProfit / totalTrades).toFixed(3) : 0} units`);
console.log(`  ROI: ${totalTrades > 0 ? ((totalProfit / totalTrades) * 100).toFixed(2) : 0}%`);
console.log('\n' + '═'.repeat(80) + '\n');

db.close();
