import Database from 'better-sqlite3';
import fetch from 'node-fetch';

const db = new Database('./resolved_markets.db', { readonly: true });

console.log('\n🧪 TESTING STRATEGY ON BTC DATA (STRONG CROWD ONLY)\n');
console.log('═'.repeat(80) + '\n');

// Get all markets
const markets = db.prepare(`SELECT * FROM market_metadata ORDER BY first_timestamp ASC`).all();

console.log(`📊 Analyzing ${markets.length} BTC markets...\n`);

// Extract market data with STRONG crowd only (≥65% or ≤35%)
const strongCrowdMarkets = [];

for (const market of markets) {
  const snapshots = db.prepare(`
    SELECT timestamp, mid_price, best_bid, best_ask
    FROM orderbook_snapshots
    WHERE market_id = ? AND outcome_name = 'Yes'
    ORDER BY timestamp ASC
  `).all(market.market_id);

  if (snapshots.length === 0) continue;

  // Find last snapshot with valid data in final 10-30% of market
  let t20sSnapshot = null;
  const start70pct = Math.floor(snapshots.length * 0.70);

  for (let i = snapshots.length - 1; i >= start70pct; i--) {
    if (snapshots[i].mid_price !== null && snapshots[i].best_ask !== null) {
      t20sSnapshot = snapshots[i];
      break;
    }
  }

  if (!t20sSnapshot) continue;

  const crowdPercent = t20sSnapshot.mid_price * 100;

  // FILTER: Only markets with strong crowd (≥65% or ≤35%)
  if (crowdPercent < 65 && crowdPercent > 35) {
    continue; // Skip neutral markets
  }

  // Parse winner
  const winningOutcomes = JSON.parse(market.winning_outcomes);
  const yesWon = winningOutcomes.some(w => w.outcome === 'Yes');
  const winner = yesWon ? 'BULL' : 'BEAR';

  // Crowd sentiment
  const crowdBullish = crowdPercent > 50;
  const crowdSide = crowdBullish ? 'BULL' : 'BEAR';

  // Payout calculation
  const t20sPriceCents = t20sSnapshot.best_ask;
  const t20sPayoutMultiple = t20sPriceCents > 0 ? (1.0 / t20sPriceCents) : 1.0;

  strongCrowdMarkets.push({
    market_id: market.market_id,
    title: market.market_title,
    timestamp: market.first_timestamp,
    crowd_side: crowdSide,
    crowd_percent: crowdPercent.toFixed(2),
    t20s_price_cents: t20sPriceCents.toFixed(3),
    t20s_payout_multiple: t20sPayoutMultiple.toFixed(3),
    winner: winner
  });
}

console.log(`✅ Found ${strongCrowdMarkets.length} markets with strong crowd (≥65% or ≤35%)\n`);
console.log('─'.repeat(80) + '\n');

// Show all markets
console.log('📝 ALL STRONG CROWD MARKETS:\n');
for (let i = 0; i < strongCrowdMarkets.length; i++) {
  const m = strongCrowdMarkets[i];
  console.log(`${i + 1}. ${m.title.substring(0, 55)}`);
  console.log(`   T-20s: Crowd ${m.crowd_percent}% ${m.crowd_side} | Price: ${m.t20s_price_cents}¢ | Payout: ${m.t20s_payout_multiple}x`);
  console.log(`   Winner: ${m.winner}`);
  console.log('');
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

    if (candles.length < 7) return null;

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
console.log('🎯 TESTING ORIGINAL STRATEGY (Bet WITH Crowd + EMA Confirmation):\n');

let totalTrades = 0;
let wins = 0;
let losses = 0;
let profit = 0;

for (const m of strongCrowdMarkets) {
  console.log(`Checking market ${m.market_id}...`);

  const emaData = await getEMASignal(m.timestamp);
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
  const won = betSide === m.winner;

  if (won) {
    wins++;
    const payoutMultiple = parseFloat(m.t20s_payout_multiple);
    profit += (payoutMultiple - 1);
    console.log(`  ✅ WIN | Bet: ${betSide} | Winner: ${m.winner} | Payout: ${m.t20s_payout_multiple}x`);
  } else {
    losses++;
    profit -= 1;
    console.log(`  ❌ LOSS | Bet: ${betSide} | Winner: ${m.winner}`);
  }

  console.log(`     Crowd: ${m.crowd_percent}% ${m.crowd_side} | EMA: ${emaData.signal} (gap ${emaData.gap}%)`);
  console.log('');

  await new Promise(resolve => setTimeout(resolve, 200));
}

console.log('═'.repeat(80) + '\n');
console.log('📊 RESULTS:\n');
console.log(`  Total trades: ${totalTrades}`);
console.log(`  Wins: ${wins} (${totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : 0}%)`);
console.log(`  Losses: ${losses}`);
console.log(`  Profit: ${profit.toFixed(2)} units`);
console.log(`  ROI: ${totalTrades > 0 ? ((profit / totalTrades) * 100).toFixed(2) : 0}%`);
console.log('\n' + '═'.repeat(80) + '\n');

db.close();
