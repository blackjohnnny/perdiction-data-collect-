import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';

// Strategy Parameters
const EMA_GAP_THRESHOLD = 0.05; // 0.05%
const MAX_PAYOUT = 1.85; // 1.85x
const MOMENTUM_THRESHOLD = 0.10; // 0.10%

// TradingView API for BNB/USD 5-minute candles
const TRADINGVIEW_API = 'https://api.binance.com/api/v3/klines';

// Calculate EMA
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];

  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }

  return ema;
}

// Fetch historical candles from Binance
async function fetchCandles(timestamp, count = 10) {
  try {
    const endTime = timestamp * 1000; // Convert to milliseconds
    const startTime = endTime - (count * 5 * 60 * 1000); // 5-minute candles

    const url = `${TRADINGVIEW_API}?symbol=BNBUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=${count}`;
    const response = await fetch(url);
    const data = await response.json();

    // Extract close prices
    const closePrices = data.map(candle => parseFloat(candle[4]));
    return closePrices;
  } catch (error) {
    console.error('Error fetching candles:', error.message);
    return null;
  }
}

// Calculate signal
async function calculateSignal(lockTimestamp) {
  const prices = await fetchCandles(lockTimestamp, 10);
  if (!prices || prices.length < 7) return null;

  const ema3 = calculateEMA(prices, 3);
  const ema7 = calculateEMA(prices, 7);

  const gapPercent = Math.abs((ema3 - ema7) / ema7 * 100);
  const momentum = ((prices[prices.length - 1] - prices[prices.length - 2]) / prices[prices.length - 2]) * 100;

  // Check EMA gap filter
  if (gapPercent < EMA_GAP_THRESHOLD) {
    return { signal: 'SKIP', reason: 'EMA gap too small', gap: gapPercent, momentum };
  }

  // Determine EMA direction
  const emaSignal = ema3 > ema7 ? 'BULL' : 'BEAR';

  return {
    signal: emaSignal,
    ema3,
    ema7,
    gap: gapPercent,
    momentum,
    prices
  };
}

// Run backtest
async function runBacktest() {
  const db = initDatabase(DB_PATH);

  // Get rounds with T-20s data and winner
  const rounds = db.prepare(`
    SELECT * FROM rounds
    WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND close_price IS NOT NULL
    ORDER BY sample_id ASC
  `).all();

  console.log(`\n🎯 Backtesting Strategy on ${rounds.length} Rounds`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`Parameters:`);
  console.log(`  EMA Gap: ${EMA_GAP_THRESHOLD}%`);
  console.log(`  Max Payout: ${MAX_PAYOUT}x`);
  console.log(`  Momentum: ${MOMENTUM_THRESHOLD}%`);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  let balance = 1.0; // Start with 1 BNB
  let tradeHistory = [];
  let lastTwoResults = []; // Track last 2 results for dynamic sizing

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

    // Get EMA signal
    const signal = await calculateSignal(round.lock_timestamp);

    if (!signal || signal.signal === 'SKIP') {
      skipped++;
      continue;
    }

    // Momentum filter: Check if momentum aligns with EMA signal
    const momentumAligned = (signal.signal === 'BULL' && signal.momentum > 0) ||
                           (signal.signal === 'BEAR' && signal.momentum < 0);

    if (!momentumAligned || Math.abs(signal.momentum) < MOMENTUM_THRESHOLD) {
      skipped++;
      continue;
    }

    // Contrarian logic: Bet OPPOSITE of EMA when crowd is ≥65% on EMA side
    let betSide = null;

    if (signal.signal === 'BULL' && bullPercent >= 65) {
      betSide = 'BEAR'; // EMA bullish, crowd ≥65% bull → bet BEAR (contrarian)
    } else if (signal.signal === 'BEAR' && bearPercent >= 65) {
      betSide = 'BULL'; // EMA bearish, crowd ≥65% bear → bet BULL (contrarian)
    } else {
      skipped++;
      continue; // No contrarian opportunity
    }

    // Dynamic position sizing based on last 2 results
    const basePercent = 6.5;
    let multiplier = 1.0;

    if (lastTwoResults.length >= 2) {
      const [prev1, prev2] = lastTwoResults;

      // Recovery mode: First loss after wins
      if (prev1 === 'loss' && prev2 === 'win') {
        multiplier = 1.5;
      }

      // Profit-taking mode: Two wins in a row
      if (prev1 === 'win' && prev2 === 'win') {
        multiplier = 0.75;
      }
    }

    const betSize = balance * (basePercent / 100) * multiplier;

    // Determine win/loss
    const won = (betSide === round.winner.toUpperCase());

    if (won) {
      const profit = betSize * (payout - 1);
      balance += profit;
      wins++;
      lastTwoResults.unshift('win');
      tradeHistory.push({
        sample: round.sample_id,
        epoch: round.epoch,
        betSide,
        winner: round.winner,
        betSize: betSize.toFixed(4),
        payout: payout.toFixed(2),
        profit: profit.toFixed(4),
        balance: balance.toFixed(4),
        multiplier: multiplier.toFixed(2),
        result: 'WIN'
      });
    } else {
      balance -= betSize;
      losses++;
      lastTwoResults.unshift('loss');
      tradeHistory.push({
        sample: round.sample_id,
        epoch: round.epoch,
        betSide,
        winner: round.winner,
        betSize: betSize.toFixed(4),
        payout: payout.toFixed(2),
        profit: (-betSize).toFixed(4),
        balance: balance.toFixed(4),
        multiplier: multiplier.toFixed(2),
        result: 'LOSS'
      });
    }

    // Keep only last 2 results
    if (lastTwoResults.length > 2) {
      lastTwoResults.pop();
    }

    totalTrades++;

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  db.close();

  // Print results
  console.log(`\n📊 Backtest Results:\n`);
  console.log(`Total Rounds Analyzed: ${rounds.length}`);
  console.log(`Total Trades: ${totalTrades}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`Wins: ${wins} (${((wins / totalTrades) * 100).toFixed(2)}%)`);
  console.log(`Losses: ${losses} (${((losses / totalTrades) * 100).toFixed(2)}%)`);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`Starting Balance: 1.0000 BNB`);
  console.log(`Final Balance: ${balance.toFixed(4)} BNB`);
  console.log(`Total P&L: ${(balance - 1).toFixed(4)} BNB (${((balance - 1) * 100).toFixed(2)}%)`);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // Print trade history
  if (tradeHistory.length > 0) {
    console.log(`\n📈 Trade History (Last 10):\n`);
    const lastTrades = tradeHistory.slice(-10);
    lastTrades.forEach(trade => {
      const resultEmoji = trade.result === 'WIN' ? '✅' : '❌';
      console.log(`${resultEmoji} Sample #${trade.sample} - Epoch ${trade.epoch}`);
      console.log(`   Bet: ${trade.betSide} (${trade.betSize} BNB @ ${trade.multiplier}x) | Winner: ${trade.winner.toUpperCase()} | Payout: ${trade.payout}x`);
      console.log(`   P&L: ${trade.profit} BNB | Balance: ${trade.balance} BNB\n`);
    });
  }
}

runBacktest().catch(console.error);
