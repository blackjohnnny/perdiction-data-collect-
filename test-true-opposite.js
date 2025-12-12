import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';
const BINANCE_API = 'https://api.binance.com/api/v3/klines';

const EMA_GAP_THRESHOLD = 0.05;
const MAX_PAYOUT = 1.85;
const MOMENTUM_THRESHOLD = 0.10;

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
  const momentum = ((prices[prices.length - 1] - prices[prices.length - 2]) / prices[prices.length - 2]) * 100;

  if (gapPercent < EMA_GAP_THRESHOLD) {
    return { signal: 'SKIP' };
  }

  const emaSignal = ema3 > ema7 ? 'BULL' : 'BEAR';
  return { signal: emaSignal, momentum };
}

async function runTest(rounds, reversed = false) {
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

    if (payout > MAX_PAYOUT) {
      skipped++;
      continue;
    }

    const signal = await calculateSignal(round.lock_timestamp);
    if (!signal || signal.signal === 'SKIP') {
      skipped++;
      continue;
    }

    // SAME TRADE LOGIC - ONLY DIFFERENCE IS BET SIDE
    let betSide = null;

    // Original: Bet OPPOSITE of EMA when crowd ≥65% on EMA side (CONTRARIAN)
    if (signal.signal === 'BULL' && bullPercent >= 65) {
      betSide = reversed ? 'BULL' : 'BEAR'; // REVERSED just flips the bet!
    } else if (signal.signal === 'BEAR' && bearPercent >= 65) {
      betSide = reversed ? 'BEAR' : 'BULL'; // REVERSED just flips the bet!
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

    const hasMomentum = Math.abs(signal.momentum) >= MOMENTUM_THRESHOLD;
    if (hasMomentum) {
      multiplier *= 1.2;
    } else {
      multiplier *= 0.8;
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

    await new Promise(resolve => setTimeout(resolve, 100));
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
  db.close();

  console.log(`\n🔄 TRUE OPPOSITE TEST - Same Strategy, Opposite Bets\n`);
  console.log(`Parameters:`);
  console.log(`  EMA Gap: ${EMA_GAP_THRESHOLD}%`);
  console.log(`  Max Payout: ${MAX_PAYOUT}x`);
  console.log(`  Momentum: ${MOMENTUM_THRESHOLD}% (for position sizing)`);
  console.log(`  Crowd Threshold: 65%\n`);
  console.log(`Testing on ${rounds.length} rounds\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  console.log(`Running ORIGINAL (bet AGAINST EMA when crowd agrees with EMA)...`);
  const original = await runTest(rounds, false);

  console.log(`Running REVERSED (bet WITH EMA when crowd agrees with EMA)...\n`);
  const reversed = await runTest(rounds, true);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  console.log(`\n📊 RESULTS - SAME ROUNDS, OPPOSITE BETS:\n`);
  console.log(`Strategy        | Trades | Wins | Losses | Win%   | ROI         | Final Balance`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`ORIGINAL        | ${original.totalTrades.toString().padEnd(6)} | ${original.wins.toString().padEnd(4)} | ${original.losses.toString().padEnd(6)} | ${original.winRate.padStart(6)}% | ${original.roi.padStart(11)}% | ${original.finalBalance} BNB`);
  console.log(`REVERSED        | ${reversed.totalTrades.toString().padEnd(6)} | ${reversed.wins.toString().padEnd(4)} | ${reversed.losses.toString().padEnd(6)} | ${reversed.winRate.padStart(6)}% | ${reversed.roi.padStart(11)}% | ${reversed.finalBalance} BNB`);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // Verify they're true opposites
  const originalWinRate = parseFloat(original.winRate);
  const reversedWinRate = parseFloat(reversed.winRate);
  const sumWinRates = originalWinRate + reversedWinRate;

  console.log(`\n✅ VERIFICATION:\n`);
  console.log(`Both strategies traded: ${original.totalTrades} rounds (should be identical)`);
  console.log(`Win rates: ${original.winRate}% + ${reversed.winRate}% = ${sumWinRates.toFixed(2)}%`);

  if (Math.abs(sumWinRates - 100) < 0.1) {
    console.log(`✅ CONFIRMED: Win rates add to ~100% (true opposites!)`);
  } else {
    console.log(`❌ ERROR: Win rates don't add to 100%`);
  }

  console.log(`\n🏆 WINNER:\n`);
  const originalROI = parseFloat(original.roi);
  const reversedROI = parseFloat(reversed.roi);

  if (originalROI > reversedROI) {
    console.log(`ORIGINAL wins: ${original.roi}% vs ${reversed.roi}%`);
    console.log(`Strategy: Bet AGAINST EMA (contrarian)`);
  } else {
    console.log(`REVERSED wins: ${reversed.roi}% vs ${original.roi}%`);
    console.log(`Strategy: Bet WITH EMA (trend following)`);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

test().catch(console.error);
