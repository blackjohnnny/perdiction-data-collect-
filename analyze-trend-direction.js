import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';
const BINANCE_API = 'https://api.binance.com/api/v3/klines';

// Fetch candles from Binance
async function fetchCandles(timestamp, count = 10) {
  try {
    const endTime = timestamp * 1000;
    const startTime = endTime - (count * 5 * 60 * 1000);
    const url = `${BINANCE_API}?symbol=BNBUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=${count}`;
    const response = await fetch(url);
    const data = await response.json();
    const candles = data.map(candle => ({
      close: parseFloat(candle[4]),
      high: parseFloat(candle[2]),
      low: parseFloat(candle[3])
    }));
    return candles;
  } catch (error) {
    return null;
  }
}

async function analyzeMarketConditions() {
  const db = initDatabase(DB_PATH);
  const rounds = db.prepare(`
    SELECT * FROM rounds
    WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND close_price IS NOT NULL
    AND lock_price IS NOT NULL
    AND lock_price != '0'
    AND close_price != '0'
    ORDER BY sample_id ASC
  `).all();
  db.close();

  console.log(`\n📊 MARKET CONDITION ANALYSIS\n`);
  console.log(`Analyzing ${rounds.length} rounds to test consolidation theory\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  let trendingRounds = 0;
  let consolidationRounds = 0;
  let crowdRightInTrend = 0;
  let crowdWrongInTrend = 0;
  let crowdRightInConsolidation = 0;
  let crowdWrongInConsolidation = 0;
  let analyzed = 0;

  for (const round of rounds) {
    const candles = await fetchCandles(round.lock_timestamp, 6);
    if (!candles || candles.length < 6) continue;

    // Calculate recent price movement (last 3 candles vs previous 3)
    const recent = candles.slice(3, 6).map(c => c.close);
    const previous = candles.slice(0, 3).map(c => c.close);

    const recentAvg = recent.reduce((a, b) => a + b) / recent.length;
    const previousAvg = previous.reduce((a, b) => a + b) / previous.length;
    const priceChange = ((recentAvg - previousAvg) / previousAvg) * 100;

    // Calculate volatility (range as % of price)
    const allPrices = candles.map(c => c.close);
    const high = Math.max(...allPrices);
    const low = Math.min(...allPrices);
    const volatility = ((high - low) / low) * 100;

    // Determine market condition
    const isTrending = Math.abs(priceChange) > 0.3 && volatility > 0.5;
    const isConsolidation = Math.abs(priceChange) < 0.2 || volatility < 0.4;

    if (isTrending) trendingRounds++;
    if (isConsolidation) consolidationRounds++;

    // Determine crowd direction at T-20s
    const t20sBullWei = BigInt(round.t20s_bull_wei || '0');
    const t20sBearWei = BigInt(round.t20s_bear_wei || '0');
    const t20sTotalWei = t20sBullWei + t20sBearWei;

    if (t20sTotalWei === 0n) continue;

    const bullPercent = Number(t20sBullWei * 10000n / t20sTotalWei) / 100;
    const crowdBullish = bullPercent > 50;

    // Check if crowd was right
    const actualWinner = round.winner.toUpperCase();
    const crowdCorrect = (crowdBullish && actualWinner === 'BULL') ||
                        (!crowdBullish && actualWinner === 'BEAR');

    if (isTrending) {
      if (crowdCorrect) crowdRightInTrend++;
      else crowdWrongInTrend++;
    }

    if (isConsolidation) {
      if (crowdCorrect) crowdRightInConsolidation++;
      else crowdWrongInConsolidation++;
    }

    analyzed++;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`\n📈 MARKET CONDITIONS:\n`);
  console.log(`Trending Markets:      ${trendingRounds} rounds (${((trendingRounds/analyzed)*100).toFixed(1)}%)`);
  console.log(`Consolidation Markets: ${consolidationRounds} rounds (${((consolidationRounds/analyzed)*100).toFixed(1)}%)`);
  console.log(`Analyzed: ${analyzed} rounds\n`);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  console.log(`\n🎯 CROWD ACCURACY BY MARKET CONDITION:\n`);

  const trendTotal = crowdRightInTrend + crowdWrongInTrend;
  const consolidationTotal = crowdRightInConsolidation + crowdWrongInConsolidation;

  if (trendTotal > 0) {
    const trendAccuracy = (crowdRightInTrend / trendTotal) * 100;
    console.log(`TRENDING MARKETS:`);
    console.log(`  Crowd Correct: ${crowdRightInTrend} (${trendAccuracy.toFixed(1)}%)`);
    console.log(`  Crowd Wrong:   ${crowdWrongInTrend} (${(100-trendAccuracy).toFixed(1)}%)`);
    console.log(`  Total: ${trendTotal} rounds\n`);
  }

  if (consolidationTotal > 0) {
    const consolidationAccuracy = (crowdRightInConsolidation / consolidationTotal) * 100;
    console.log(`CONSOLIDATION MARKETS:`);
    console.log(`  Crowd Correct: ${crowdRightInConsolidation} (${consolidationAccuracy.toFixed(1)}%)`);
    console.log(`  Crowd Wrong:   ${crowdWrongInConsolidation} (${(100-consolidationAccuracy).toFixed(1)}%)`);
    console.log(`  Total: ${consolidationTotal} rounds\n`);
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  console.log(`\n💡 YOUR THEORY ANALYSIS:\n`);
  if (consolidationTotal > 0 && trendTotal > 0) {
    const consolidationAccuracy = (crowdRightInConsolidation / consolidationTotal) * 100;
    const trendAccuracy = (crowdRightInTrend / trendTotal) * 100;

    console.log(`Your Theory: "Market is 80% consolidation, crowd is wrong in consolidation"\n`);
    console.log(`Reality:`);
    console.log(`  Consolidation %: ${((consolidationRounds/analyzed)*100).toFixed(1)}%`);
    console.log(`  Crowd accuracy in consolidation: ${consolidationAccuracy.toFixed(1)}%`);
    console.log(`  Crowd accuracy in trending: ${trendAccuracy.toFixed(1)}%\n`);

    if (consolidationAccuracy < 50) {
      console.log(`✅ THEORY CONFIRMED! Crowd is WRONG in consolidation (${consolidationAccuracy.toFixed(1)}% < 50%)`);
      console.log(`   → Contrarian betting WORKS in consolidation`);
    } else {
      console.log(`❌ THEORY REJECTED. Crowd is actually RIGHT in consolidation (${consolidationAccuracy.toFixed(1)}% > 50%)`);
    }

    if (trendAccuracy > consolidationAccuracy) {
      console.log(`\n📈 Crowd is BETTER at predicting trending markets (${trendAccuracy.toFixed(1)}% vs ${consolidationAccuracy.toFixed(1)}%)`);
    } else {
      console.log(`\n📉 Crowd is WORSE at trending markets (${trendAccuracy.toFixed(1)}% vs ${consolidationAccuracy.toFixed(1)}%)`);
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

analyzeMarketConditions().catch(console.error);
