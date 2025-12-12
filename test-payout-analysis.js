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

async function runStrategy(rounds, maxPayout = null) {
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  let balance = 1.0;
  let lastTwoResults = [];
  const payoutBuckets = {};

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

    if (maxPayout && payout > maxPayout) {
      skipped++;
      continue;
    }

    const marketCondition = await analyzeMarketCondition(round.lock_timestamp);
    if (!marketCondition) {
      skipped++;
      continue;
    }

    if (marketCondition.emaGap < EMA_GAP_THRESHOLD) {
      skipped++;
      continue;
    }

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
    const bucketKey = payout < 1.5 ? '<1.5' : payout < 2.0 ? '1.5-2.0' : payout < 2.5 ? '2.0-2.5' : '2.5+';
    if (!payoutBuckets[bucketKey]) {
      payoutBuckets[bucketKey] = { wins: 0, losses: 0, trades: 0 };
    }
    payoutBuckets[bucketKey].trades++;

    if (won) {
      balance += betSize * (payout - 1);
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

  console.log(`\n📊 PAYOUT FILTER DEEP ANALYSIS\n`);
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
      console.log(`\n   Win rate by payout range:`);
      for (const [bucket, stats] of Object.entries(result.payoutBuckets)) {
        const bucketWinRate = (stats.wins / stats.trades * 100).toFixed(2);
        console.log(`   ├─ ${bucket}x: ${stats.wins}/${stats.trades} wins (${bucketWinRate}% win rate)`);
      }
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  db.close();
}

test().catch(console.error);
