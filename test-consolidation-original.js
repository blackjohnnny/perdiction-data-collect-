import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';
const BINANCE_API = 'https://api.binance.com/api/v3/klines';

// Strategy Parameters
const EMA_GAP_THRESHOLD = 0.05;
const MAX_PAYOUT = 1.85;
const CROWD_THRESHOLD = 65;

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

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

async function analyzeMarketCondition(lockTimestamp) {
  const candles = await fetchCandles(lockTimestamp, 6);
  if (!candles || candles.length < 6) return null;

  // Calculate EMA
  const prices = candles.map(c => c.close);
  const ema3 = calculateEMA(prices, 3);
  const ema7 = calculateEMA(prices, 7);
  const gapPercent = Math.abs((ema3 - ema7) / ema7 * 100);

  // Calculate price movement (recent vs previous)
  const recent = prices.slice(3, 6);
  const previous = prices.slice(0, 3);
  const recentAvg = recent.reduce((a, b) => a + b) / recent.length;
  const previousAvg = previous.reduce((a, b) => a + b) / previous.length;
  const priceChange = Math.abs((recentAvg - previousAvg) / previousAvg) * 100;

  // Calculate volatility
  const allPrices = prices;
  const high = Math.max(...allPrices);
  const low = Math.min(...allPrices);
  const volatility = ((high - low) / low) * 100;

  // Determine if consolidation
  const isConsolidation = priceChange < 0.2 || volatility < 0.4;
  const isTrending = priceChange > 0.3 && volatility > 0.5;

  const emaSignal = ema3 > ema7 ? 'BULL' : 'BEAR';

  return {
    emaSignal,
    emaGap: gapPercent,
    isConsolidation,
    isTrending,
    priceChange,
    volatility
  };
}

async function runStrategy(rounds, strategyName, strategyFn) {
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  let balance = 1.0;
  let lastTwoResults = [];

  let consolidationTrades = 0;
  let trendingTrades = 0;
  let consolidationWins = 0;
  let trendingWins = 0;

  for (const round of rounds) {
    const t20sBullWei = BigInt(round.t20s_bull_wei || '0');
    const t20sBearWei = BigInt(round.t20s_bear_wei || '0');
    const t20sTotalWei = t20sBullWei + t20sBearWei;

    if (t20sTotalWei === 0n) {
      skipped++;
      continue;
    }

    const bullPercent = Number(t20sBullWei * 10000n / t20sTotalWei) / 100;
    const bearPercent = Number(t20sBearWei * 10000n / t20sTotalWei) / 100;
    const payout = round.winner_payout_multiple;

    if (payout > MAX_PAYOUT) {
      skipped++;
      continue;
    }

    // Analyze market condition
    const marketCondition = await analyzeMarketCondition(round.lock_timestamp);
    if (!marketCondition) {
      skipped++;
      continue;
    }

    // Check EMA gap filter
    if (marketCondition.emaGap < EMA_GAP_THRESHOLD) {
      skipped++;
      continue;
    }

    const result = strategyFn(marketCondition, bullPercent, bearPercent);
    if (!result) {
      skipped++;
      continue;
    }

    const { betSide, isConsolidationTrade } = result;

    // Dynamic sizing
    const basePercent = 6.5;
    let multiplier = 1.0;

    if (lastTwoResults.length >= 2) {
      const [prev1, prev2] = lastTwoResults;
      if (prev1 === 'loss' && prev2 === 'win') multiplier = 1.5;
      if (prev1 === 'win' && prev2 === 'win') multiplier = 0.75;
    }

    const betSize = balance * (basePercent / 100) * multiplier;
    const won = (betSide === round.winner.toUpperCase());

    if (won) {
      balance += betSize * (payout - 1);
      wins++;
      lastTwoResults.unshift('win');
      if (isConsolidationTrade) {
        consolidationWins++;
      } else {
        trendingWins++;
      }
    } else {
      balance -= betSize;
      losses++;
      lastTwoResults.unshift('loss');
    }

    if (isConsolidationTrade) {
      consolidationTrades++;
    } else {
      trendingTrades++;
    }

    if (lastTwoResults.length > 2) lastTwoResults.pop();

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = ((balance - 1) * 100);

  const consolidationWinRate = consolidationTrades > 0 ? (consolidationWins / consolidationTrades) * 100 : 0;
  const trendingWinRate = trendingTrades > 0 ? (trendingWins / trendingTrades) * 100 : 0;

  return {
    totalTrades,
    wins,
    losses,
    skipped,
    winRate: winRate.toFixed(2),
    roi: roi.toFixed(2),
    finalBalance: balance.toFixed(4),
    consolidationTrades,
    trendingTrades,
    consolidationWins,
    trendingWins,
    consolidationWinRate: consolidationWinRate.toFixed(2),
    trendingWinRate: trendingWinRate.toFixed(2)
  };
}

async function test() {
  const db = initDatabase(DB_PATH);
  const rounds = db.prepare(`
    SELECT * FROM rounds
    WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND close_price IS NOT NULL
    ORDER BY sample_id ASC
  `).all();
  db.close();

  console.log(`\n📊 CONSOLIDATION TEST - ORIGINAL vs REVERSE\n`);
  console.log(`Testing on ${rounds.length} rounds\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // ORIGINAL strategy: Bet WITH crowd in consolidation
  const originalStrategy = (marketCondition, bullPercent, bearPercent) => {
    if (marketCondition.isConsolidation) {
      // Consolidation: Bet WITH crowd/EMA (trend following)
      if (marketCondition.emaSignal === 'BULL' && bullPercent >= CROWD_THRESHOLD) {
        return { betSide: 'BULL', isConsolidationTrade: true };
      }
      if (marketCondition.emaSignal === 'BEAR' && bearPercent >= CROWD_THRESHOLD) {
        return { betSide: 'BEAR', isConsolidationTrade: true };
      }
    }
    return null;
  };

  // REVERSE strategy: Bet AGAINST crowd in consolidation
  const reverseStrategy = (marketCondition, bullPercent, bearPercent) => {
    if (marketCondition.isConsolidation) {
      // Consolidation: Bet AGAINST crowd (contrarian)
      if (marketCondition.emaSignal === 'BULL' && bullPercent >= CROWD_THRESHOLD) {
        return { betSide: 'BEAR', isConsolidationTrade: true };
      }
      if (marketCondition.emaSignal === 'BEAR' && bearPercent >= CROWD_THRESHOLD) {
        return { betSide: 'BULL', isConsolidationTrade: true };
      }
    }
    return null;
  };

  const originalResult = await runStrategy(rounds, 'ORIGINAL', originalStrategy);
  console.log(`\n✅ ORIGINAL (Bet WITH crowd in consolidation):`);
  console.log(`├─ Consolidation trades: ${originalResult.consolidationTrades}`);
  console.log(`├─ Wins: ${originalResult.consolidationWins}`);
  console.log(`├─ Win Rate: ${originalResult.consolidationWinRate}%`);
  console.log(`├─ ROI: ${originalResult.roi}%`);
  console.log(`└─ Final Balance: ${originalResult.finalBalance} BNB\n`);

  const reverseResult = await runStrategy(rounds, 'REVERSE', reverseStrategy);
  console.log(`\n❌ REVERSE (Bet AGAINST crowd in consolidation):`);
  console.log(`├─ Consolidation trades: ${reverseResult.consolidationTrades}`);
  console.log(`├─ Wins: ${reverseResult.consolidationWins}`);
  console.log(`├─ Win Rate: ${reverseResult.consolidationWinRate}%`);
  console.log(`├─ ROI: ${reverseResult.roi}%`);
  console.log(`└─ Final Balance: ${reverseResult.finalBalance} BNB\n`);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

test().catch(console.error);
