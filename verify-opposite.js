import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';
const BINANCE_API = 'https://api.binance.com/api/v3/klines';

const EMA_GAP_THRESHOLD = 0.05;
const MAX_PAYOUT = 1.85;

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
    const closePrices = data.map(candle => parseFloat(candle[4]));
    return closePrices;
  } catch (error) {
    return null;
  }
}

async function calculateSignal(lockTimestamp) {
  const prices = await fetchCandles(lockTimestamp, 10);
  if (!prices || prices.length < 7) return null;

  const ema3 = calculateEMA(prices, 3);
  const ema7 = calculateEMA(prices, 7);
  const gapPercent = Math.abs((ema3 - ema7) / ema7 * 100);

  if (gapPercent < EMA_GAP_THRESHOLD) {
    return { signal: 'SKIP' };
  }

  const emaSignal = ema3 > ema7 ? 'BULL' : 'BEAR';
  return { signal: emaSignal };
}

async function analyze() {
  const db = initDatabase(DB_PATH);
  const rounds = db.prepare(`
    SELECT * FROM rounds
    WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND close_price IS NOT NULL
    ORDER BY sample_id ASC
  `).all();
  db.close();

  console.log(`\n🔍 VERIFYING IF STRATEGIES ARE TRUE OPPOSITES\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  let originalTrades = [];
  let reversedTrades = [];
  let bothTrade = [];
  let analyzed = 0;

  for (const round of rounds) {
    const t20sBullWei = BigInt(round.t20s_bull_wei || '0');
    const t20sBearWei = BigInt(round.t20s_bear_wei || '0');
    const t20sTotalWei = t20sBullWei + t20sBearWei;

    if (t20sTotalWei === 0n) continue;
    if (round.winner_payout_multiple > MAX_PAYOUT) continue;

    const bullPercent = Number(t20sBullWei * 10000n / t20sTotalWei) / 100;
    const bearPercent = Number(t20sBearWei * 10000n / t20sTotalWei) / 100;

    const signal = await calculateSignal(round.lock_timestamp);
    if (!signal || signal.signal === 'SKIP') continue;

    analyzed++;

    // Check ORIGINAL conditions
    let originalTakesIt = false;
    let originalBet = null;
    if (signal.signal === 'BULL' && bullPercent >= 65) {
      originalTakesIt = true;
      originalBet = 'BEAR';
    } else if (signal.signal === 'BEAR' && bearPercent >= 65) {
      originalTakesIt = true;
      originalBet = 'BULL';
    }

    // Check REVERSED conditions
    let reversedTakesIt = false;
    let reversedBet = null;
    if (signal.signal === 'BULL' && bearPercent >= 65) {
      reversedTakesIt = true;
      reversedBet = 'BULL';
    } else if (signal.signal === 'BEAR' && bullPercent >= 65) {
      reversedTakesIt = true;
      reversedBet = 'BEAR';
    }

    if (originalTakesIt) {
      originalTrades.push({
        epoch: round.epoch,
        emaSignal: signal.signal,
        bullPercent: bullPercent.toFixed(1),
        bearPercent: bearPercent.toFixed(1),
        bet: originalBet,
        winner: round.winner.toUpperCase()
      });
    }

    if (reversedTakesIt) {
      reversedTrades.push({
        epoch: round.epoch,
        emaSignal: signal.signal,
        bullPercent: bullPercent.toFixed(1),
        bearPercent: bearPercent.toFixed(1),
        bet: reversedBet,
        winner: round.winner.toUpperCase()
      });
    }

    if (originalTakesIt && reversedTakesIt) {
      bothTrade.push({
        epoch: round.epoch,
        emaSignal: signal.signal,
        bullPercent: bullPercent.toFixed(1),
        bearPercent: bearPercent.toFixed(1),
        originalBet,
        reversedBet,
        winner: round.winner.toUpperCase()
      });
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`\n📊 TRADE OVERLAP ANALYSIS:\n`);
  console.log(`Rounds analyzed: ${analyzed}`);
  console.log(`ORIGINAL strategy trades: ${originalTrades.length}`);
  console.log(`REVERSED strategy trades: ${reversedTrades.length}`);
  console.log(`Rounds where BOTH trade: ${bothTrade.length}\n`);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (bothTrade.length > 0) {
    console.log(`\n❌ PROBLEM FOUND! Both strategies trade the same rounds ${bothTrade.length} times!\n`);
    console.log(`This means they're NOT true opposites!\n`);
    console.log(`First 5 overlapping rounds:\n`);
    bothTrade.slice(0, 5).forEach(t => {
      console.log(`Epoch ${t.epoch}: EMA=${t.emaSignal}, Crowd=${t.bullPercent}% BULL / ${t.bearPercent}% BEAR`);
      console.log(`  Original bet: ${t.originalBet} | Reversed bet: ${t.reversedBet} | Winner: ${t.winner}`);
      console.log(``);
    });
  } else {
    console.log(`\n✅ STRATEGIES ARE TRUE OPPOSITES - No overlapping trades\n`);
  }

  // Check if they're on different rounds
  const originalEpochs = new Set(originalTrades.map(t => t.epoch));
  const reversedEpochs = new Set(reversedTrades.map(t => t.epoch));
  const overlap = [...originalEpochs].filter(e => reversedEpochs.has(e));

  console.log(`\n🔍 EPOCH OVERLAP:\n`);
  console.log(`Original trades on: ${originalEpochs.size} unique epochs`);
  console.log(`Reversed trades on: ${reversedEpochs.size} unique epochs`);
  console.log(`Overlapping epochs: ${overlap.length}\n`);

  if (overlap.length === 0) {
    console.log(`❌ STRATEGIES TRADE DIFFERENT ROUNDS! They're not opposites!\n`);
    console.log(`This explains why win rates don't add to 100%\n`);
  } else if (overlap.length === originalEpochs.size && overlap.length === reversedEpochs.size) {
    console.log(`✅ STRATEGIES TRADE THE SAME ROUNDS (true opposites)\n`);
  } else {
    console.log(`⚠️  STRATEGIES PARTIALLY OVERLAP (${overlap.length} shared rounds)\n`);
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

analyze().catch(console.error);
