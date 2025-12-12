import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';
const BINANCE_API = 'https://api.binance.com/api/v3/klines';

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

async function debugFilters() {
  const db = initDatabase(DB_PATH);

  const rounds = db.prepare(`
    SELECT * FROM rounds
    WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND close_price IS NOT NULL
    ORDER BY sample_id ASC
  `).all();

  console.log(`\n🔍 DEBUG: Analyzing ${rounds.length} rounds\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  let totalRounds = rounds.length;
  let skippedEmptyPool = 0;
  let skippedHighPayout = 0;
  let skippedNoApiData = 0;
  let skippedLowEmaGap = 0;
  let skippedNoCrowdAlignment = 0;
  let validTrades = 0;

  let highPayoutCount = 0;
  let lowEmaGapCount = 0;

  for (const round of rounds) {
    const t20sBullWei = BigInt(round.t20s_bull_wei || '0');
    const t20sBearWei = BigInt(round.t20s_bear_wei || '0');
    const t20sTotalWei = t20sBullWei + t20sBearWei;

    // Check 1: Empty pool
    if (t20sTotalWei === 0n) {
      skippedEmptyPool++;
      continue;
    }

    const bullPercent = Number(t20sBullWei * 10000n / t20sTotalWei) / 100;
    const bearPercent = Number(t20sBearWei * 10000n / t20sTotalWei) / 100;
    const payout = round.winner_payout_multiple;

    // Check 2: High payout
    if (payout > MAX_PAYOUT) {
      skippedHighPayout++;
      highPayoutCount++;
      continue;
    }

    // Check 3: API data availability
    const marketCondition = await analyzeMarketCondition(round.lock_timestamp);
    if (!marketCondition) {
      skippedNoApiData++;
      continue;
    }

    // Check 4: EMA gap too small
    if (marketCondition.emaGap < EMA_GAP_THRESHOLD) {
      skippedLowEmaGap++;
      lowEmaGapCount++;
      continue;
    }

    // Check 5: Crowd alignment (original strategy)
    let hasTradeSignal = false;
    if (marketCondition.emaSignal === 'BULL' && bullPercent >= CROWD_THRESHOLD) {
      hasTradeSignal = true;
    }
    if (marketCondition.emaSignal === 'BEAR' && bearPercent >= CROWD_THRESHOLD) {
      hasTradeSignal = true;
    }

    if (!hasTradeSignal) {
      skippedNoCrowdAlignment++;
      continue;
    }

    validTrades++;
  }

  console.log(`Total rounds: ${totalRounds}`);
  console.log(`\nFilters applied:\n`);
  console.log(`1. Empty pool (total = 0):              ${skippedEmptyPool} rounds skipped`);
  console.log(`2. High payout (>${MAX_PAYOUT}x):               ${skippedHighPayout} rounds skipped`);
  console.log(`3. No API data (Binance fetch failed):  ${skippedNoApiData} rounds skipped`);
  console.log(`4. Low EMA gap (<${EMA_GAP_THRESHOLD}%):             ${skippedLowEmaGap} rounds skipped 🔴`);
  console.log(`5. No crowd alignment (EMA + 65% rule): ${skippedNoCrowdAlignment} rounds skipped 🔴`);
  console.log(`\n✅ Valid trades: ${validTrades}`);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`\n🔥 BIGGEST FILTERS:\n`);
  console.log(`EMA gap too small (<${EMA_GAP_THRESHOLD}%): ${lowEmaGapCount} rounds (${(lowEmaGapCount/totalRounds*100).toFixed(1)}%)`);
  console.log(`Crowd not aligned with EMA: ${skippedNoCrowdAlignment} rounds (${(skippedNoCrowdAlignment/totalRounds*100).toFixed(1)}%)\n`);

  db.close();
}

debugFilters().catch(console.error);
