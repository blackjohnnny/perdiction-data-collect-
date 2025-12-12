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

    // Optional payout filter
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
    } else {
      balance -= betSize;
      losses++;
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
    finalBalance: balance.toFixed(4)
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

  console.log(`\n📊 ORIGINAL STRATEGY - PAYOUT FILTER COMPARISON\n`);
  console.log(`Total rounds: ${rounds.length}\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const withFilter = await runStrategy(rounds, 1.85);
  console.log(`\n✅ WITH payout filter (max 1.85x):`);
  console.log(`├─ Trades: ${withFilter.totalTrades}`);
  console.log(`├─ Wins: ${withFilter.wins} | Losses: ${withFilter.losses}`);
  console.log(`├─ Win Rate: ${withFilter.winRate}%`);
  console.log(`├─ ROI: ${withFilter.roi}%`);
  console.log(`└─ Final Balance: ${withFilter.finalBalance} BNB\n`);

  const noFilter = await runStrategy(rounds, null);
  console.log(`\n❌ WITHOUT payout filter (all trades):`);
  console.log(`├─ Trades: ${noFilter.totalTrades}`);
  console.log(`├─ Wins: ${noFilter.wins} | Losses: ${noFilter.losses}`);
  console.log(`├─ Win Rate: ${noFilter.winRate}%`);
  console.log(`├─ ROI: ${noFilter.roi}%`);
  console.log(`└─ Final Balance: ${noFilter.finalBalance} BNB\n`);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`\n💡 ANALYSIS:\n`);
  console.log(`Payout filter removes: ${noFilter.totalTrades - withFilter.totalTrades} trades (${((1 - withFilter.totalTrades/noFilter.totalTrades) * 100).toFixed(1)}%)`);
  console.log(`Trade count: ${withFilter.totalTrades} → ${noFilter.totalTrades} (${((noFilter.totalTrades/withFilter.totalTrades - 1) * 100).toFixed(0)}% increase)\n`);

  db.close();
}

test().catch(console.error);
