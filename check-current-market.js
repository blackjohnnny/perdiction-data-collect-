import fetch from 'node-fetch';

console.log('\n📊 CURRENT MARKET ANALYSIS - Last 3 Hours\n');
console.log('═'.repeat(100) + '\n');

const now = Date.now();

// Fetch different timeframes
async function analyzeCurrentMarket() {
  try {
    // 1m candles - last 3 hours
    const tf1m_start = now - (3 * 60 * 60 * 1000);
    const url1m = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=1m&startTime=${tf1m_start}&endTime=${now}&limit=180`;

    // 5m candles - last 3 hours
    const tf5m_start = now - (3 * 60 * 60 * 1000);
    const url5m = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=5m&startTime=${tf5m_start}&endTime=${now}&limit=36`;

    // 15m candles - last 6 hours for context
    const tf15m_start = now - (6 * 60 * 60 * 1000);
    const url15m = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=15m&startTime=${tf15m_start}&endTime=${now}&limit=24`;

    // 1h candles - last 24 hours for context
    const tf1h_start = now - (24 * 60 * 60 * 1000);
    const url1h = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=1h&startTime=${tf1h_start}&endTime=${now}&limit=24`;

    const [res1m, res5m, res15m, res1h] = await Promise.all([
      fetch(url1m),
      fetch(url5m),
      fetch(url15m),
      fetch(url1h)
    ]);

    const [candles1m, candles5m, candles15m, candles1h] = await Promise.all([
      res1m.json(),
      res5m.json(),
      res15m.json(),
      res1h.json()
    ]);

    console.log('📈 PRICE ACTION - Last 3 Hours:\n');

    // Extract price data
    const prices1m = candles1m.map(c => ({
      time: new Date(c[0]).toISOString().substring(11, 16),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4])
    }));

    const prices5m = candles5m.map(c => ({
      time: new Date(c[0]).toISOString().substring(11, 16),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4])
    }));

    // Show recent 5m candles
    console.log('Last 12 5-minute candles:\n');
    prices5m.slice(-12).forEach(p => {
      const change = ((p.close - p.open) / p.open * 100).toFixed(2);
      const direction = p.close > p.open ? '🟢' : '🔴';
      console.log(`  ${p.time} | O: $${p.open.toFixed(2)} → C: $${p.close.toFixed(2)} | ${direction} ${change}%`);
    });

    console.log('\n' + '─'.repeat(100) + '\n');

    // Calculate metrics for different timeframes
    function analyzeTimeframe(prices, name) {
      const closes = prices.map(p => p.close);
      const highs = prices.map(p => p.high);
      const lows = prices.map(p => p.low);

      const highest = Math.max(...highs);
      const lowest = Math.min(...lows);
      const range = highest - lowest;
      const avgPrice = closes.reduce((a, b) => a + b) / closes.length;
      const rangePercent = (range / avgPrice) * 100;

      // Volatility
      const squaredDiffs = closes.map(p => Math.pow(p - avgPrice, 2));
      const variance = squaredDiffs.reduce((a, b) => a + b) / closes.length;
      const stdDev = Math.sqrt(variance);
      const cv = (stdDev / avgPrice) * 100;

      // Trend
      const startPrice = closes[0];
      const endPrice = closes[closes.length - 1];
      const totalChange = ((endPrice - startPrice) / startPrice) * 100;

      // Linear regression R²
      const n = closes.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
      for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += closes[i];
        sumXY += i * closes[i];
        sumX2 += i * i;
        sumY2 += closes[i] * closes[i];
      }
      const r = (n * sumXY - sumX * sumY) / Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
      const r2 = r * r;

      // Count directional candles
      let bullish = 0, bearish = 0;
      prices.forEach(p => {
        if (p.close > p.open) bullish++;
        else bearish++;
      });

      return {
        name,
        startPrice: startPrice.toFixed(2),
        endPrice: endPrice.toFixed(2),
        totalChange: totalChange.toFixed(2),
        rangePercent: rangePercent.toFixed(2),
        cv: cv.toFixed(2),
        r2: r2.toFixed(3),
        bullish,
        bearish,
        trendDirection: totalChange > 0 ? 'UP' : 'DOWN'
      };
    }

    const analysis1m = analyzeTimeframe(prices1m, '1-minute (180 candles / 3h)');
    const analysis5m = analyzeTimeframe(prices5m, '5-minute (36 candles / 3h)');
    const analysis15m = analyzeTimeframe(candles15m.map(c => ({
      close: parseFloat(c[4]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      open: parseFloat(c[1])
    })), '15-minute (24 candles / 6h)');
    const analysis1h = analyzeTimeframe(candles1h.map(c => ({
      close: parseFloat(c[4]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      open: parseFloat(c[1])
    })), '1-hour (24 candles / 24h)');

    console.log('📊 TIMEFRAME ANALYSIS:\n');

    [analysis1m, analysis5m, analysis15m, analysis1h].forEach(a => {
      console.log(`${a.name}:`);
      console.log(`  Price Movement: $${a.startPrice} → $${a.endPrice} (${a.totalChange > 0 ? '+' : ''}${a.totalChange}% ${a.trendDirection})`);
      console.log(`  Range: ${a.rangePercent}% | Volatility (CV): ${a.cv}%`);
      console.log(`  R² (trend linearity): ${a.r2}`);
      console.log(`  Candle Direction: ${a.bullish} 🟢 / ${a.bearish} 🔴\n`);
    });

    console.log('─'.repeat(100) + '\n');

    // MY CLASSIFICATION based on data
    console.log('🤔 MY INTERPRETATION (Last 3 Hours):\n');

    const is1mTrending = Math.abs(parseFloat(analysis1m.totalChange)) > 0.5 && parseFloat(analysis1m.r2) > 0.6;
    const is5mTrending = Math.abs(parseFloat(analysis5m.totalChange)) > 1.5 && parseFloat(analysis5m.r2) > 0.5;
    const is15mTrending = Math.abs(parseFloat(analysis15m.totalChange)) > 2.0 && parseFloat(analysis15m.r2) > 0.6;

    const isHighVolatility = parseFloat(analysis5m.cv) > 2.0;
    const isLowVolatility = parseFloat(analysis5m.cv) < 1.0;

    console.log(`1m chart: ${is1mTrending ? '🔥 TRENDING' : '📊 Consolidating/Choppy'}`);
    console.log(`  Reason: ${analysis1m.totalChange}% move, R²=${analysis1m.r2}\n`);

    console.log(`5m chart: ${is5mTrending ? '🔥 TRENDING' : '📊 Consolidating/Choppy'}`);
    console.log(`  Reason: ${analysis5m.totalChange}% move, R²=${analysis5m.r2}\n`);

    console.log(`15m chart: ${is15mTrending ? '🔥 TRENDING' : '📊 Consolidating/Choppy'}`);
    console.log(`  Reason: ${analysis15m.totalChange}% move, R²=${analysis15m.r2}\n`);

    console.log(`Volatility: ${isHighVolatility ? '⚡ HIGH' : isLowVolatility ? '😴 LOW' : '📊 MODERATE'}`);
    console.log(`  5m CV: ${analysis5m.cv}%\n`);

    console.log('─'.repeat(100) + '\n');

    console.log('❓ MY CLASSIFICATION:\n');

    if ((is5mTrending || is15mTrending) && parseFloat(analysis5m.r2) > 0.5) {
      console.log('  ✅ TRENDING - Strong directional move with high R²');
      console.log('  This is where contrarian strategy would LOSE (like the 13-loss streak)');
    } else if (isLowVolatility && parseFloat(analysis5m.rangePercent) < 2.0) {
      console.log('  ✅ CONSOLIDATION - Low range, low volatility, sideways');
      console.log('  This is where contrarian strategy should WIN');
    } else if (isHighVolatility && parseFloat(analysis5m.r2) < 0.4) {
      console.log('  ✅ CHOPPY - High volatility but no clear direction');
      console.log('  Unpredictable, mixed results');
    } else {
      console.log('  ✅ NEUTRAL - Between states');
    }

    console.log('\n═'.repeat(100) + '\n');

    console.log('💬 QUESTION TO YOU:\n');
    console.log('Based on the data above, do YOU think the last 3 hours was:');
    console.log('  A) Trending (strong directional move)');
    console.log('  B) Consolidating (sideways, range-bound)');
    console.log('  C) Choppy (volatile but no direction)\n');
    console.log('What specific metrics would YOU use to define each state?\n');

  } catch (err) {
    console.error('Error:', err.message);
  }
}

analyzeCurrentMarket();
