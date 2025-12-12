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
      volume: parseFloat(candle[5])
    }));
    return candles;
  } catch (error) {
    return null;
  }
}

async function analyzeMarketCondition(lockTimestamp) {
  const candles = await fetchCandles(lockTimestamp, 10);
  if (!candles || candles.length < 7) return null;

  // Calculate EMA for direction
  const prices = candles.map(c => c.close);
  const ema3 = calculateEMA(prices, 3);
  const ema7 = calculateEMA(prices, 7);
  const gapPercent = Math.abs((ema3 - ema7) / ema7 * 100);
  const emaSignal = ema3 > ema7 ? 'BULL' : 'BEAR';

  // Calculate volume metrics
  const volumes = candles.map(c => c.volume);
  const recentVolume = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3; // Last 3 candles avg
  const overallAvgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length; // Overall avg

  // High volume = trending market (volume > 1.2x average)
  // Low volume = consolidation (volume < 0.8x average)
  const volumeRatio = recentVolume / overallAvgVolume;
  const isHighVolume = volumeRatio > 1.2; // Trending
  const isLowVolume = volumeRatio < 0.8; // Consolidation

  return {
    emaSignal,
    emaGap: gapPercent,
    volumeRatio: volumeRatio.toFixed(2),
    isHighVolume,
    isLowVolume,
    isTrending: isHighVolume,
    isConsolidation: isLowVolume
  };
}

async function runVolumeAdaptiveStrategy(rounds) {
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

    // Analyze market condition (volume-based)
    const marketCondition = await analyzeMarketCondition(round.lock_timestamp);
    if (!marketCondition) {
      skipped++;
      continue;
    }

    // Check EMA gap filter (for direction only)
    if (marketCondition.emaGap < EMA_GAP_THRESHOLD) {
      skipped++;
      continue;
    }

    let betSide = null;
    let usedConsolidationStrategy = false;

    // CORRECTED VOLUME-BASED ADAPTIVE STRATEGY
    // Your ORIGINAL strategy: Bet WITH crowd (trend following)
    // REVERSE strategy: Bet AGAINST crowd (contrarian) - WINS MORE

    if (marketCondition.isLowVolume) {
      // LOW VOLUME (CONSOLIDATION): Use REVERSE (contrarian - bet AGAINST crowd)
      usedConsolidationStrategy = true;
      if (marketCondition.emaSignal === 'BULL' && bullPercent >= CROWD_THRESHOLD) {
        betSide = 'BEAR'; // Crowd bullish → bet BEAR (contrarian)
      } else if (marketCondition.emaSignal === 'BEAR' && bearPercent >= CROWD_THRESHOLD) {
        betSide = 'BULL'; // Crowd bearish → bet BULL (contrarian)
      } else {
        skipped++;
        continue;
      }
    } else if (marketCondition.isHighVolume) {
      // HIGH VOLUME (TRENDING): Use REVERSE (contrarian - bet AGAINST crowd)
      if (marketCondition.emaSignal === 'BULL' && bullPercent >= CROWD_THRESHOLD) {
        betSide = 'BEAR'; // Crowd bullish → bet BEAR (contrarian)
      } else if (marketCondition.emaSignal === 'BEAR' && bearPercent >= CROWD_THRESHOLD) {
        betSide = 'BULL'; // Crowd bearish → bet BULL (contrarian)
      } else {
        skipped++;
        continue;
      }
    } else {
      // Medium volume - skip
      skipped++;
      continue;
    }

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
      if (usedConsolidationStrategy) {
        consolidationWins++;
      } else {
        trendingWins++;
      }
    } else {
      balance -= betSize;
      losses++;
      lastTwoResults.unshift('loss');
    }

    if (usedConsolidationStrategy) {
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

  console.log(`\n📊 VOLUME-BASED ADAPTIVE STRATEGY\n`);
  console.log(`Parameters:`);
  console.log(`  EMA Gap: ${EMA_GAP_THRESHOLD}% (for direction only)`);
  console.log(`  Max Payout: ${MAX_PAYOUT}x`);
  console.log(`  Crowd Threshold: ${CROWD_THRESHOLD}%\n`);
  console.log(`Volume Detection:`);
  console.log(`  Low Volume (< 0.8x avg) = CONSOLIDATION`);
  console.log(`  High Volume (> 1.2x avg) = TRENDING\n`);
  console.log(`Strategy Logic:`);
  console.log(`  📉 LOW VOLUME (consolidation) → Bet AGAINST crowd (contrarian/reverse)`);
  console.log(`  📈 HIGH VOLUME (trending) → Bet AGAINST crowd (contrarian/reverse)\n`);
  console.log(`Testing on ${rounds.length} rounds\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const result = await runVolumeAdaptiveStrategy(rounds);

  console.log(`\n📊 RESULTS:\n`);
  console.log(`Total Trades: ${result.totalTrades}`);
  console.log(`  Low Volume (consolidation): ${result.consolidationTrades} trades (${result.consolidationWins} wins, ${result.consolidationWinRate}% win rate)`);
  console.log(`  High Volume (trending): ${result.trendingTrades} trades (${result.trendingWins} wins, ${result.trendingWinRate}% win rate)`);
  console.log(`\nOverall:`);
  console.log(`  Wins: ${result.wins}`);
  console.log(`  Losses: ${result.losses}`);
  console.log(`  Win Rate: ${result.winRate}%`);
  console.log(`  ROI: ${result.roi}%`);
  console.log(`  Final Balance: ${result.finalBalance} BNB\n`);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  console.log(`\n💡 NOTE:\n`);
  console.log(`This test applies REVERSE (contrarian) strategy to BOTH market conditions.`);
  console.log(`The idea: Does volume filtering improve pure contrarian strategy?\n`);
}

test().catch(console.error);
