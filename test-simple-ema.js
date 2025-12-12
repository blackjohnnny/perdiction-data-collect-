import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';
const TRADINGVIEW_API = 'https://api.binance.com/api/v3/klines';

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
    const url = `${TRADINGVIEW_API}?symbol=BNBUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=${count}`;
    const response = await fetch(url);
    const data = await response.json();
    const closePrices = data.map(candle => parseFloat(candle[4]));
    return closePrices;
  } catch (error) {
    return null;
  }
}

async function calculateSignal(lockTimestamp, emaGapThreshold) {
  const prices = await fetchCandles(lockTimestamp, 10);
  if (!prices || prices.length < 7) return null;

  const ema3 = calculateEMA(prices, 3);
  const ema7 = calculateEMA(prices, 7);
  const gapPercent = Math.abs((ema3 - ema7) / ema7 * 100);

  if (gapPercent < emaGapThreshold) {
    return { signal: 'SKIP', gap: gapPercent };
  }

  const emaSignal = ema3 > ema7 ? 'BULL' : 'BEAR';
  return { signal: emaSignal, gap: gapPercent };
}

async function testSimpleEMA(rounds, emaGap, crowdThreshold) {
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

    // Get EMA signal (NO momentum filter)
    const signal = await calculateSignal(round.lock_timestamp, emaGap);
    if (!signal || signal.signal === 'SKIP') {
      skipped++;
      continue;
    }

    // Contrarian: bet opposite of EMA when crowd ≥ threshold on EMA side
    let betSide = null;
    if (signal.signal === 'BULL' && bullPercent >= crowdThreshold) {
      betSide = 'BEAR';
    } else if (signal.signal === 'BEAR' && bearPercent >= crowdThreshold) {
      betSide = 'BULL';
    } else {
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
      balance += betSize * (round.winner_payout_multiple - 1);
      wins++;
      lastTwoResults.unshift('win');
    } else {
      balance -= betSize;
      losses++;
      lastTwoResults.unshift('loss');
    }

    if (lastTwoResults.length > 2) lastTwoResults.pop();

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = ((balance - 1) * 100);

  return {
    emaGap,
    crowdThreshold,
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
  db.close();

  console.log(`\n🧪 SIMPLE EMA + CONTRARIAN TEST (No Momentum Filter)\n`);
  console.log(`Testing on ${rounds.length} rounds\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const results = [];
  const emaGaps = [0.01, 0.03, 0.05];
  const crowdThresholds = [60, 65];

  for (const emaGap of emaGaps) {
    for (const crowdThreshold of crowdThresholds) {
      console.log(`Testing EMA Gap: ${emaGap}%, Crowd: ${crowdThreshold}%...`);
      const result = await testSimpleEMA(rounds, emaGap, crowdThreshold);
      results.push(result);
    }
  }

  results.sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi));

  console.log(`\n📊 Results (Sorted by ROI):\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`EMA Gap | Crowd% | Trades | Wins | Losses | Skipped | Win%   | ROI       | Final Balance`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  results.forEach(r => {
    console.log(`${r.emaGap.toFixed(2)}%    | ${r.crowdThreshold}%    | ${r.totalTrades.toString().padEnd(6)} | ${r.wins.toString().padEnd(4)} | ${r.losses.toString().padEnd(6)} | ${r.skipped.toString().padEnd(7)} | ${r.winRate.padStart(6)}% | ${r.roi.padStart(9)}% | ${r.finalBalance} BNB`);
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`\n🏆 Best EMA Strategy:\n`);
  const best = results[0];
  console.log(`EMA Gap: ${best.emaGap}%`);
  console.log(`Crowd Threshold: ${best.crowdThreshold}%`);
  console.log(`Total Trades: ${best.totalTrades} (${((best.totalTrades/rounds.length)*100).toFixed(1)}% of rounds)`);
  console.log(`Win Rate: ${best.winRate}%`);
  console.log(`ROI: ${best.roi}%`);
  console.log(`Final Balance: ${best.finalBalance} BNB`);

  console.log(`\n📈 COMPARISON:\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Strategy                          | Trades | Win%   | ROI`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Pure Contrarian (65%)             | 184    | 54.89% | +196.38%`);
  console.log(`EMA+Momentum+Contrarian           | 22     | 31.82% |  -48.28%`);
  console.log(`Simple EMA+Contrarian (best)      | ${best.totalTrades.toString().padEnd(6)} | ${best.winRate}% | ${best.roi.padStart(8)}%`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

test().catch(console.error);
