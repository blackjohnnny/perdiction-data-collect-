import Database from 'better-sqlite3';
import fetch from 'node-fetch';

const db = new Database('./resolved_markets.db', { readonly: true });

console.log('\n🧪 TESTING STRATEGY ON BTC DATA\n');
console.log('═'.repeat(80) + '\n');

// Get all markets with metadata
const markets = db.prepare(`
  SELECT * FROM market_metadata ORDER BY first_timestamp ASC
`).all();

console.log(`📊 Found ${markets.length} BTC markets\n`);
console.log('─'.repeat(80) + '\n');

// Extract market data
const marketData = [];

for (const market of markets) {
  // Get all snapshots for this market
  const snapshots = db.prepare(`
    SELECT timestamp, mid_price, best_bid, best_ask
    FROM orderbook_snapshots
    WHERE market_id = ? AND outcome_name = 'Yes'
    ORDER BY timestamp ASC
  `).all(market.market_id);

  if (snapshots.length === 0) continue;

  // Find T-20s equivalent: last snapshot with non-null mid_price in final 10-20% of market
  // This represents crowd sentiment right before market close (like T-20s)
  let t20sSnapshot = null;
  const start90pct = Math.floor(snapshots.length * 0.80); // Start looking at 80%

  for (let i = snapshots.length - 1; i >= start90pct; i--) {
    if (snapshots[i].mid_price !== null && snapshots[i].best_ask !== null) {
      t20sSnapshot = snapshots[i];
      break;
    }
  }

  if (!t20sSnapshot) {
    console.log(`⚠️  Skipping market ${market.market_id} - no valid T-20s data`);
    continue;
  }

  // Parse winner
  const winningOutcomes = JSON.parse(market.winning_outcomes);
  const yesWon = winningOutcomes.some(w => w.outcome === 'Yes');
  const winner = yesWon ? 'BULL' : 'BEAR'; // YES = UP = BULL, NO = DOWN = BEAR

  // Crowd sentiment at T-20s
  const crowdBullish = t20sSnapshot.mid_price > 0.5;
  const crowdPercent = t20sSnapshot.mid_price * 100;

  // Payout at T-20s in Polymarket format (cents)
  // To get actual payout multiple: if you buy at 0.70 cents and win, you get 1.00, so payout = 1/0.70 = 1.43x
  const t20sPriceCents = t20sSnapshot.best_ask || 0.5;
  const t20sPayoutMultiple = t20sPriceCents > 0 ? (1.0 / t20sPriceCents) : 1.0;

  marketData.push({
    market_id: market.market_id,
    title: market.market_title,
    timestamp: market.first_timestamp,
    t20s_crowd_bullish: crowdBullish,
    t20s_crowd_percent: crowdPercent.toFixed(2),
    t20s_price_cents: t20sPriceCents.toFixed(3),
    t20s_payout_multiple: t20sPayoutMultiple.toFixed(3),
    winner: winner,
    winner_price_cents: winningOutcomes[0].price
  });
}

console.log(`✅ Extracted ${marketData.length} markets with valid T-20s data\n`);
console.log('─'.repeat(80) + '\n');

// Show sample
console.log('📝 SAMPLE DATA (First 5):\n');
for (let i = 0; i < Math.min(5, marketData.length); i++) {
  const m = marketData[i];
  const crowdSide = m.t20s_crowd_bullish ? 'BULL' : 'BEAR';
  const crowdPct = m.t20s_crowd_percent;
  console.log(`${i + 1}. ${m.title.substring(0, 50)}...`);
  console.log(`   T-20s: Crowd ${crowdPct}% ${crowdSide} | Price: ${m.t20s_price_cents}¢ | Payout: ${m.t20s_payout_multiple}x`);
  console.log(`   Winner: ${m.winner}`);
  console.log('');
}

console.log('─'.repeat(80) + '\n');

// Fetch BTC/USDT EMA data from Binance
console.log('📈 Fetching BTC/USDT price data from Binance...\n');

async function getEMASignal(timestamp) {
  try {
    const endTime = timestamp * 1000; // Convert to ms
    const startTime = endTime - (7 * 5 * 60 * 1000); // 7 candles x 5 minutes

    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=7`;
    const response = await fetch(url);
    const candles = await response.json();
    if (candles.length < 7) return null;

    // Calculate EMA3 and EMA7
    const closes = candles.map(c => parseFloat(c[4]));

    // EMA3 (last 3 candles)
    const ema3_data = closes.slice(-3);
    const ema3 = ema3_data.reduce((a, b) => a + b) / 3;

    // EMA7 (all 7 candles)
    const ema7 = closes.reduce((a, b) => a + b) / 7;

    const gap = ((ema3 - ema7) / ema7) * 100;
    const signal = gap > 0.05 ? 'BULL' : gap < -0.05 ? 'BEAR' : 'NEUTRAL';

    return { signal, gap: gap.toFixed(3), ema3: ema3.toFixed(2), ema7: ema7.toFixed(2) };

  } catch (err) {
    console.error(`   ❌ Error fetching EMA for timestamp ${timestamp}: ${err.message}`);
    return null;
  }
}

// Test strategy on markets with crowd >= 65%
console.log('🎯 TESTING STRATEGY (Crowd >= 65%):\n');

let totalTrades = 0;
let wins = 0;
let losses = 0;
let profit = 0;

for (const m of marketData) {
  const crowdPct = parseFloat(m.t20s_crowd_percent);

  // Filter: Crowd >= 65%
  if (crowdPct < 65 && crowdPct < 35) continue; // Skip if no strong crowd

  // Determine crowd side
  const crowdSide = crowdPct >= 65 ? 'BULL' : 'BEAR';

  // Fetch EMA signal
  console.log(`Checking market ${m.market_id}...`);
  const emaData = await getEMASignal(m.timestamp);

  if (!emaData) {
    console.log(`  ⏭️  Skipped (no EMA data)\n`);
    continue;
  }

  // ORIGINAL STRATEGY: Bet WITH crowd when EMA confirms
  let betSide = null;
  if (crowdSide === 'BULL' && emaData.signal === 'BULL') {
    betSide = 'BULL'; // Trend following: bet WITH crowd
  } else if (crowdSide === 'BEAR' && emaData.signal === 'BEAR') {
    betSide = 'BEAR';
  }

  if (!betSide) {
    console.log(`  ⏭️  No trade (EMA ${emaData.signal} doesn't confirm crowd ${crowdSide})\n`);
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

  console.log(`     Crowd: ${crowdPct}% ${crowdSide} | EMA: ${emaData.signal} (gap ${emaData.gap}%)`);
  console.log('');

  // Rate limit
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
