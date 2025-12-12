import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const BINANCE_API = 'https://api.binance.com/api/v3/klines';

// Calculate EMA
function calculateEMA(prices, period) {
  if (prices.length < period) return null;

  const k = 2 / (period + 1);
  let ema = prices[0];

  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }

  return ema;
}

// Fetch Binance candles
async function fetchCandles(symbol, interval, limit) {
  const url = `${BINANCE_API}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await fetch(url);
  const data = await response.json();

  return data.map(candle => ({
    timestamp: candle[0],
    close: parseFloat(candle[4]),
    volume: parseFloat(candle[5])
  }));
}

// Get EMA signal
async function getEMASignal() {
  try {
    const candles = await fetchCandles('BNBUSDT', '5m', 20);
    const closes = candles.map(c => c.close);

    const ema3 = calculateEMA(closes.slice(-3), 3);
    const ema7 = calculateEMA(closes.slice(-7), 7);

    if (!ema3 || !ema7) return null;

    const gap = Math.abs((ema3 - ema7) / ema7) * 100;

    if (gap < 0.05) return null;

    return {
      signal: ema3 > ema7 ? 'BULL' : 'BEAR',
      ema3,
      ema7,
      gap
    };
  } catch (error) {
    return null;
  }
}

// ORIGINAL STRATEGY: Bet WITH crowd when indicators align
function shouldTradeOriginal(signal, bullPercent, bearPercent) {
  if (!signal) return null;

  const { signal: emaDirection } = signal;

  // Bet WITH crowd when crowd ≥65% AND EMA confirms same direction
  if (emaDirection === 'BULL' && bullPercent >= 65) {
    return 'BULL'; // Crowd is bullish, EMA is bullish → Bet BULL (trend following)
  }

  if (emaDirection === 'BEAR' && bearPercent >= 65) {
    return 'BEAR'; // Crowd is bearish, EMA is bearish → Bet BEAR (trend following)
  }

  return null;
}

// REVERSE STRATEGY: Bet OPPOSITE direction on same conditions
function shouldTradeReverse(signal, bullPercent, bearPercent) {
  if (!signal) return null;

  const { signal: emaDirection } = signal;

  // Bet OPPOSITE when conditions align
  if (emaDirection === 'BULL' && bullPercent >= 65) {
    return 'BEAR'; // Original would bet BULL → Reverse bets BEAR
  }

  if (emaDirection === 'BEAR' && bearPercent >= 65) {
    return 'BULL'; // Original would bet BEAR → Reverse bets BULL
  }

  return null;
}

// Calculate payout multiple
function calculatePayout(betSide, bullWei, bearWei) {
  const bullAmount = parseFloat(bullWei) / 1e18;
  const bearAmount = parseFloat(bearWei) / 1e18;
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

// Dynamic position sizing
function calculateBetSize(bankroll, mode, lastTwoResults) {
  const basePercent = mode === 'safe' ? 4.5 : 6.5;
  let multiplier = 1.0;

  const [prev1, prev2] = lastTwoResults;

  if (prev1 === 'loss' && prev2 === 'win') {
    multiplier = 1.5; // Recovery mode
  }

  if (prev1 === 'win' && prev2 === 'win') {
    multiplier = 0.75; // Profit-taking mode
  }

  return bankroll * (basePercent / 100) * multiplier;
}

// Backtest
async function backtest() {
  const db = initDatabase();

  const rounds = db.prepare(`
    SELECT * FROM rounds
    WHERE is_complete = 1
    AND t20s_bull_wei IS NOT NULL
    AND t20s_bear_wei IS NOT NULL
    ORDER BY sample_id ASC
  `).all();

  console.log(`\n📊 Testing CORRECTED strategies on ${rounds.length} rounds\n`);

  // Fetch candles once
  const candles = await fetchCandles('BNBUSDT', '5m', 20);
  const closes = candles.map(c => c.close);
  const ema3 = calculateEMA(closes.slice(-3), 3);
  const ema7 = calculateEMA(closes.slice(-7), 7);
  const gap = Math.abs((ema3 - ema7) / ema7) * 100;

  const signal = gap >= 0.05 ? {
    signal: ema3 > ema7 ? 'BULL' : 'BEAR',
    ema3,
    ema7,
    gap
  } : null;

  console.log(`EMA Signal: ${signal ? signal.signal : 'NONE'} (Gap: ${gap.toFixed(4)}%)\n`);

  // Test both strategies
  const strategies = [
    { name: 'ORIGINAL (Trend Following)', fn: shouldTradeOriginal },
    { name: 'REVERSE (Contrarian)', fn: shouldTradeReverse }
  ];

  for (const strategy of strategies) {
    let bankroll = 1.0;
    let totalTrades = 0;
    let wins = 0;
    let losses = 0;
    let totalProfit = 0;
    const recentResults = [];

    for (const round of rounds) {
      const bullWei = round.t20s_bull_wei;
      const bearWei = round.t20s_bear_wei;
      const bullAmount = parseFloat(bullWei) / 1e18;
      const bearAmount = parseFloat(bearWei) / 1e18;
      const totalPool = bullAmount + bearAmount;

      if (totalPool === 0) continue;

      const bullPercent = (bullAmount / totalPool) * 100;
      const bearPercent = (bearAmount / totalPool) * 100;

      const betSide = strategy.fn(signal, bullPercent, bearPercent);

      if (!betSide) continue;

      const payout = calculatePayout(betSide, bullWei, bearWei);

      const betSize = calculateBetSize(bankroll, 'normal', recentResults.slice(-2));

      const won = betSide.toLowerCase() === round.winner;

      totalTrades++;

      if (won) {
        const profit = betSize * (payout - 1);
        bankroll += profit;
        totalProfit += profit;
        wins++;
        recentResults.push('win');
      } else {
        bankroll -= betSize;
        totalProfit -= betSize;
        losses++;
        recentResults.push('loss');
      }

      if (recentResults.length > 2) recentResults.shift();
    }

    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const roi = ((bankroll - 1.0) / 1.0) * 100;

    console.log(`\n${strategy.name}:`);
    console.log(`├─ Trades: ${totalTrades}`);
    console.log(`├─ Wins: ${wins} | Losses: ${losses}`);
    console.log(`├─ Win Rate: ${winRate.toFixed(2)}%`);
    console.log(`├─ Final Bankroll: ${bankroll.toFixed(4)} BNB`);
    console.log(`├─ Total Profit: ${totalProfit.toFixed(4)} BNB`);
    console.log(`└─ ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`);
  }

  db.close();
}

backtest();
