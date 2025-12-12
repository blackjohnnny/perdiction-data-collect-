import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';
const BINANCE_API = 'https://api.binance.com/api/v3/klines';

const EMA_GAP_THRESHOLD = 0.05;
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
      close: parseFloat(candle[4])
    }));
    return candles;
  } catch (error) {
    return null;
  }
}

async function analyzeMarketCondition(lockTimestamp) {
  const candles = await fetchCandles(lockTimestamp, 6);
  if (!candles || candles.length < 6) return null;

  const prices = candles.map(c => c.close);
  const ema3 = calculateEMA(prices, 3);
  const ema7 = calculateEMA(prices, 7);
  const gapPercent = Math.abs((ema3 - ema7) / ema7 * 100);

  const emaSignal = ema3 > ema7 ? 'BULL' : 'BEAR';

  return {
    emaSignal,
    emaGap: gapPercent
  };
}

// Calculate payout from T-20s amounts
function calculateT20sPayout(betSide, t20sBullWei, t20sBearWei) {
  const bullAmount = parseFloat(t20sBullWei) / 1e18;
  const bearAmount = parseFloat(t20sBearWei) / 1e18;
  const totalPool = bullAmount + bearAmount;

  if (totalPool === 0) return 1.0;

  const HOUSE_EDGE = 0.03;
  const netPool = totalPool * (1 - HOUSE_EDGE);

  if (betSide === 'BULL') {
    return bullAmount === 0 ? 1.0 : netPool / bullAmount;
  } else {
    return bearAmount === 0 ? 1.0 : netPool / bearAmount;
  }
}

async function runStrategy(rounds, maxPayout = null) {
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  let balance = 1.0;
  let lastTwoResults = [];
  const payoutBuckets = {
    '<1.5': { wins: 0, losses: 0, trades: 0 },
    '1.5-2.0': { wins: 0, losses: 0, trades: 0 },
    '2.0-2.5': { wins: 0, losses: 0, trades: 0 },
    '2.5+': { wins: 0, losses: 0, trades: 0 }
  };

  for (const round of rounds) {
    const t20sBullWei = round.t20s_bull_wei;
    const t20sBearWei = round.t20s_bear_wei;

    if (!t20sBullWei || !t20sBearWei) {
      skipped++;
      continue;
    }

    const bullAmount = parseFloat(t20sBullWei) / 1e18;
    const bearAmount = parseFloat(t20sBearWei) / 1e18;
    const totalPool = bullAmount + bearAmount;

    if (totalPool === 0) {
      skipped++;
      continue;
    }

    const bullPercent = (bullAmount / totalPool) * 100;
    const bearPercent = (bearAmount / totalPool) * 100;

    const marketCondition = await analyzeMarketCondition(round.lock_timestamp);
    if (!marketCondition) {
      skipped++;
      continue;
    }

    if (marketCondition.emaGap < EMA_GAP_THRESHOLD) {
      skipped++;
      continue;
    }

    // ORIGINAL strategy: Bet WITH crowd
    let betSide = null;
    if (marketCondition.emaSignal === 'BULL' && bullPercent >= CROWD_THRESHOLD) {
      betSide = 'BULL';
    } else if (marketCondition.emaSignal === 'BEAR' && bearPercent >= CROWD_THRESHOLD) {
      betSide = 'BEAR';
    }

    if (!betSide) {
      skipped++;
      continue;
    }

    // Calculate T-20s payout (what we'd see when placing bet)
    const t20sPayout = calculateT20sPayout(betSide, t20sBullWei, t20sBearWei);

    // Apply payout filter
    if (maxPayout && t20sPayout > maxPayout) {
      skipped++;
      continue;
    }

    const basePercent = 6.5;
    let multiplier = 1.0;

    if (lastTwoResults.length >= 2) {
      const [prev1, prev2] = lastTwoResults;
      if (prev1 === 'loss' && prev2 === 'win') multiplier = 1.5;
      if (prev1 === 'win' && prev2 === 'win') multiplier = 0.75;
    }

    const betSize = balance * (basePercent / 100) * multiplier;
    const won = (betSide === round.winner.toUpperCase());

    // Track by payout bucket
    const bucketKey = t20sPayout < 1.5 ? '<1.5' : t20sPayout < 2.0 ? '1.5-2.0' : t20sPayout < 2.5 ? '2.0-2.5' : '2.5+';
    payoutBuckets[bucketKey].trades++;

    if (won) {
      // Use actual settlement payout for P&L
      const actualPayout = round.winner_payout_multiple;
      balance += betSize * (actualPayout - 1);
      wins++;
      payoutBuckets[bucketKey].wins++;
      lastTwoResults.unshift('win');
    } else {
      balance -= betSize;
      losses++;
      payoutBuckets[bucketKey].losses++;
      lastTwoResults.unshift('loss');
    }

    if (lastTwoResults.length > 2) lastTwoResults.pop();

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = ((balance - 1) * 100);

  return {
    totalTrades,
    wins,
    losses,
    skipped,
    winRate: winRate.toFixed(2),
    roi: roi.toFixed(2),
    finalBalance: balance.toFixed(4),
    payoutBuckets
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

  console.log(`\n📊 CORRECTED PAYOUT FILTER ANALYSIS (Using T-20s amounts)\n`);
  console.log(`Total rounds: ${rounds.length}\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // Test different payout thresholds
  const thresholds = [1.85, 2.0, 2.5, 3.0, null];

  for (const threshold of thresholds) {
    const result = await runStrategy(rounds, threshold);
    const label = threshold ? `Max ${threshold}x` : 'No limit';

    console.log(`\n📈 ${label}:`);
    console.log(`├─ Trades: ${result.totalTrades}`);
    console.log(`├─ Wins: ${result.wins} | Losses: ${result.losses}`);
    console.log(`├─ Win Rate: ${result.winRate}%`);
    console.log(`├─ ROI: ${result.roi}%`);
    console.log(`└─ Final Balance: ${result.finalBalance} BNB`);

    if (!threshold) {
      console.log(`\n   Win rate by T-20s payout range:`);
      for (const [bucket, stats] of Object.entries(result.payoutBuckets)) {
        if (stats.trades === 0) continue;
        const bucketWinRate = (stats.wins / stats.trades * 100).toFixed(2);
        console.log(`   ├─ ${bucket}x: ${stats.wins}/${stats.trades} wins (${bucketWinRate}% win rate)`);
      }
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`\n💡 KEY DIFFERENCE:\n`);
  console.log(`This test filters based on T-20s payout (what you see when placing bet),`);
  console.log(`but calculates P&L using actual settlement payout (what you actually win).\n`);

  db.close();
}

test().catch(console.error);
