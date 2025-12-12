import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';

console.log('\n📊 DEFINING MARKET STATES: TREND vs CONSOLIDATION\n');
console.log('═'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`Analyzing ${rounds.length} complete rounds\n`);
console.log('─'.repeat(100) + '\n');

// Fetch multi-timeframe data
async function getMultiTimeframeData(timestamp) {
  try {
    const endTime = timestamp * 1000;

    // 1m candles (last 60 minutes)
    const tf1m_start = endTime - (60 * 60 * 1000);
    const url1m = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=1m&startTime=${tf1m_start}&endTime=${endTime}&limit=60`;

    // 5m candles (last 100 minutes / 20 candles)
    const tf5m_start = endTime - (100 * 60 * 1000);
    const url5m = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=5m&startTime=${tf5m_start}&endTime=${endTime}&limit=20`;

    // 15m candles (last 5 hours / 20 candles)
    const tf15m_start = endTime - (5 * 60 * 60 * 1000);
    const url15m = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=15m&startTime=${tf15m_start}&endTime=${endTime}&limit=20`;

    // 1h candles (last 20 hours)
    const tf1h_start = endTime - (20 * 60 * 60 * 1000);
    const url1h = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=1h&startTime=${tf1h_start}&endTime=${endTime}&limit=20`;

    const [res1m, res5m, res15m, res1h] = await Promise.all([
      fetch(url1m),
      fetch(url5m),
      fetch(url15m),
      fetch(url1h)
    ]);

    if (!res1m.ok || !res5m.ok || !res15m.ok || !res1h.ok) return null;

    const [candles1m, candles5m, candles15m, candles1h] = await Promise.all([
      res1m.json(),
      res5m.json(),
      res15m.json(),
      res1h.json()
    ]);

    if (candles1m.length < 60 || candles5m.length < 20 || candles15m.length < 20 || candles1h.length < 20) {
      return null;
    }

    return {
      tf1m: candles1m.map(c => parseFloat(c[4])),
      tf5m: candles5m.map(c => parseFloat(c[4])),
      tf15m: candles15m.map(c => parseFloat(c[4])),
      tf1h: candles1h.map(c => parseFloat(c[4]))
    };
  } catch (err) {
    return null;
  }
}

// Calculate market metrics for a timeframe
function calculateMetrics(closes) {
  const highest = Math.max(...closes);
  const lowest = Math.min(...closes);
  const range = highest - lowest;
  const avgPrice = closes.reduce((a, b) => a + b) / closes.length;
  const rangePercent = (range / avgPrice) * 100;

  // Volatility (coefficient of variation)
  const squaredDiffs = closes.map(p => Math.pow(p - avgPrice, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b) / closes.length;
  const stdDev = Math.sqrt(variance);
  const cv = (stdDev / avgPrice) * 100;

  // Trend direction and strength
  const firstQuarter = closes.slice(0, Math.floor(closes.length / 4));
  const lastQuarter = closes.slice(-Math.floor(closes.length / 4));
  const firstAvg = firstQuarter.reduce((a, b) => a + b) / firstQuarter.length;
  const lastAvg = lastQuarter.reduce((a, b) => a + b) / lastQuarter.length;
  const trendChange = ((lastAvg - firstAvg) / firstAvg) * 100;
  const trendStrength = Math.abs(trendChange);

  // Linear regression to measure trend consistency
  const n = closes.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += closes[i];
    sumXY += i * closes[i];
    sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const r2 = Math.pow((n * sumXY - sumX * sumY) / Math.sqrt((n * sumX2 - sumX * sumX) * (n * closes.reduce((acc, y) => acc + y * y, 0) - sumY * sumY)), 2);

  return {
    rangePercent,
    cv, // Volatility
    trendChange, // Positive = uptrend, Negative = downtrend
    trendStrength, // Absolute trend strength
    r2 // How linear the trend is (0-1, higher = cleaner trend)
  };
}

// Market state classification
function classifyMarketState(tf1m, tf5m, tf15m, tf1h) {
  const m1m = calculateMetrics(tf1m);
  const m5m = calculateMetrics(tf5m);
  const m15m = calculateMetrics(tf15m);
  const m1h = calculateMetrics(tf1h);

  console.log('\n📊 MARKET STATE DEFINITION CRITERIA:\n');
  console.log('─'.repeat(100) + '\n');

  console.log('CONSOLIDATION (Sideways/Range-bound):');
  console.log('  - Low range on ALL timeframes');
  console.log('  - Low volatility (CV < 1.5% on 5m)');
  console.log('  - Weak trend strength (<1% on 5m, <2% on 15m)');
  console.log('  - Price bouncing within range, no clear direction\n');

  console.log('TRENDING (Directional Move):');
  console.log('  - High range on multiple timeframes');
  console.log('  - Strong trend strength (>1.5% on 5m OR >2% on 15m)');
  console.log('  - High R² (>0.7) = clean linear movement');
  console.log('  - Multiple timeframes agree on direction\n');

  console.log('CHOPPY (Volatile but directionless):');
  console.log('  - High volatility (CV > 2% on 5m)');
  console.log('  - Weak trend (low R²)');
  console.log('  - Price whipsawing, no consistency\n');

  console.log('─'.repeat(100) + '\n');

  // Print current metrics
  console.log('CURRENT METRICS:\n');
  console.log('1m:  Range: ' + m1m.rangePercent.toFixed(2) + '% | CV: ' + m1m.cv.toFixed(2) + '% | Trend: ' + m1m.trendChange.toFixed(2) + '% | R²: ' + m1m.r2.toFixed(3));
  console.log('5m:  Range: ' + m5m.rangePercent.toFixed(2) + '% | CV: ' + m5m.cv.toFixed(2) + '% | Trend: ' + m5m.trendChange.toFixed(2) + '% | R²: ' + m5m.r2.toFixed(3));
  console.log('15m: Range: ' + m15m.rangePercent.toFixed(2) + '% | CV: ' + m15m.cv.toFixed(2) + '% | Trend: ' + m15m.trendChange.toFixed(2) + '% | R²: ' + m15m.r2.toFixed(3));
  console.log('1h:  Range: ' + m1h.rangePercent.toFixed(2) + '% | CV: ' + m1h.cv.toFixed(2) + '% | Trend: ' + m1h.trendChange.toFixed(2) + '% | R²: ' + m1h.r2.toFixed(3));
  console.log();

  // CONSOLIDATION criteria
  const isConsolidation =
    m5m.rangePercent < 2.0 &&
    m5m.cv < 1.5 &&
    m5m.trendStrength < 1.0 &&
    m15m.trendStrength < 2.0;

  // TRENDING criteria (multiple timeframes must agree)
  const trendingTimeframes = [
    m5m.trendStrength > 1.5 && m5m.r2 > 0.5,
    m15m.trendStrength > 2.0 && m15m.r2 > 0.6,
    m1h.trendStrength > 3.0
  ].filter(Boolean).length;

  const isTrending = trendingTimeframes >= 2;

  // CHOPPY criteria
  const isChoppy =
    m5m.cv > 2.0 &&
    m5m.r2 < 0.5 &&
    !isConsolidation &&
    !isTrending;

  if (isConsolidation) return 'CONSOLIDATION';
  if (isTrending) return 'TRENDING';
  if (isChoppy) return 'CHOPPY';
  return 'NEUTRAL';
}

// Sample a few rounds to show the classification
console.log('🔍 TESTING MARKET STATE CLASSIFICATION\n');
console.log('Fetching multi-timeframe data for sample rounds...\n');

const sampleIndices = [0, 100, 200, 300, 400, 500, 600];

for (const idx of sampleIndices) {
  if (idx >= rounds.length) continue;

  const r = rounds[idx];
  const mtfData = await getMultiTimeframeData(r.lock_timestamp);

  if (!mtfData) {
    console.log(`Sample #${r.sample_id} (Epoch ${r.epoch}): No data available\n`);
    continue;
  }

  console.log(`Sample #${r.sample_id} | Epoch ${r.epoch} | ${new Date(r.lock_timestamp * 1000).toISOString()}`);

  const state = classifyMarketState(mtfData.tf1m, mtfData.tf5m, mtfData.tf15m, mtfData.tf1h);

  console.log(`Market State: ${state}`);
  console.log('─'.repeat(100) + '\n');

  // Rate limit
  await new Promise(resolve => setTimeout(resolve, 500));
}

console.log('═'.repeat(100) + '\n');

console.log('💡 PROPOSED CLASSIFICATION RULES:\n');
console.log('─'.repeat(100) + '\n');

console.log('CONSOLIDATION:');
console.log('  ✓ 5m range < 2%');
console.log('  ✓ 5m volatility (CV) < 1.5%');
console.log('  ✓ 5m trend strength < 1%');
console.log('  ✓ 15m trend strength < 2%');
console.log('  → Price moving sideways, our contrarian strategy should EXCEL here\n');

console.log('TRENDING:');
console.log('  ✓ 2+ timeframes showing strong trend');
console.log('  ✓ 5m trend strength > 1.5% AND R² > 0.5');
console.log('  ✓ 15m trend strength > 2% AND R² > 0.6');
console.log('  ✓ OR 1h trend strength > 3%');
console.log('  → Strong directional move, our contrarian strategy FAILS here (13-loss streak)\n');

console.log('CHOPPY:');
console.log('  ✓ 5m volatility > 2%');
console.log('  ✓ Low R² (< 0.5) = not linear');
console.log('  → Whipsawing, unpredictable\n');

console.log('NEUTRAL:');
console.log('  → Doesn\'t fit other categories\n');

console.log('═'.repeat(100) + '\n');

console.log('📌 NEXT STEPS:\n');
console.log('1. Use these definitions to classify all 690 rounds');
console.log('2. Test: Skip TRENDING markets (avoid 13-loss streaks)');
console.log('3. Test: Completely REVERSE trades during trending (13 losses → 13 wins)');
console.log('4. Test: Different timeframe combinations for detection\n');

db.close();
