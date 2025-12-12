# PancakeSwap BNB Prediction Strategy

## Overview
This document outlines the **EMA 3/7 Crowd-Following Strategy** for trading PancakeSwap's BNB price prediction pools.

---

## Core Strategy

### Signal Generation

**EMA Crossover (3/7 on 5-minute candles)**
- **Fast EMA**: 3-period exponential moving average
- **Slow EMA**: 7-period exponential moving average
- **Data Source**: TradingView BNB/USD 5-minute candles (Pyth Network endpoint)

### Entry Rules

1. **Trend Confirmation**
   - **Bullish Signal**: Fast EMA > Slow EMA
   - **Bearish Signal**: Fast EMA < Slow EMA
   - **Gap Filter**: EMAs must be ≥0.05% apart for valid signal

2. **Crowd Confirmation**
   - Only trade **WITH** the crowd when ≥65% on same side
   - **Example**: If EMA shows bullish trend, bet UP when crowd is ≥65% BULL

3. **Payout Filter**
   - Only trade when T-20s payout is <1.85x
   - Ensures favorable risk/reward ratio

4. **Position Sizing**
   - Dynamic sizing based on win/loss performance
   - See **Dynamic Order Placement** section below

---

## Logic Flow

```
1. Monitor round at T-20s (20 seconds before lock)
2. Fetch latest 5-minute BNB/USD candles from TradingView
3. Calculate EMA(3) and EMA(7)
4. Check if |EMA_gap| ≥ 0.05%
5. Check if crowd sentiment ≥ 65% on SAME side as EMA
6. Check if T-20s payout < 1.85x
7. If all conditions met → Place bet (6.5% of bankroll)
8. Track outcome and update P&L
```

---

## Strategy Rationale

### Why It Works

**Crowd Psychology Exploitation**
- When crowd is heavily one-sided (≥65%) and EMA confirms, it signals strong momentum
- Follow the strong side when technical and sentiment align
- Winners split the entire pool proportionally

**Technical Confirmation**
- EMA crossover filters out noise
- 0.05% gap ensures strong trend (not sideways chop)
- 5-minute timeframe matches round duration

**Risk Management**
- 6.5% position sizing balances growth vs. drawdown
- Payout filter (<1.85x) ensures favorable risk/reward
- Only trade high-confidence setups (dual confirmation)

---

## Historical Performance

### Overall (836 rounds, 10.7 days)
- **Trades**: 163
- **Win Rate**: 57.06%
- **ROI**: +172.31% ✅

### Recent (Last 200 rounds, 3.4 days)
- **Trades**: 44
- **Win Rate**: 54.55%
- **ROI**: -3.09% ❌

**Note**: Recent performance degradation suggests market adaptation. Monitor ongoing.

---

## Data Requirements

### Blockchain Data (Live Monitor)
- **T-20s snapshot**: Bull/Bear amounts 20 seconds before lock
- **T-8s snapshot**: Bull/Bear amounts 8 seconds before lock
- **T-4s snapshot**: Bull/Bear amounts 4 seconds before lock
- **Lock data**: Final pool amounts, lock price
- **Settlement**: Close price, winner, payout multiple

### TradingView Data
- **Endpoint**: BNB/USD 5-minute candles
- **Source**: Pyth Network (via TradingView API)
- **Required fields**: timestamp, open, high, low, close

---

## TradingView API Integration

### Endpoint
```javascript
const TRADINGVIEW_API = 'https://scanner.tradingview.com/symbol';
const SYMBOL = 'BINANCE:BNBUSD';
const INTERVAL = '5'; // 5-minute candles
```

### Fetch Candles
```javascript
async function fetchCandles(symbol, interval, count) {
  const url = `https://scanner.tradingview.com/crypto/scan`;

  const payload = {
    symbols: { tickers: [symbol] },
    columns: ['close', 'time']
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  return data;
}
```

### Calculate EMA
```javascript
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0]; // Start with first price

  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }

  return ema;
}

function getEMASignal(candles) {
  const closes = candles.map(c => c.close);

  const ema3 = calculateEMA(closes.slice(-3), 3);
  const ema7 = calculateEMA(closes.slice(-7), 7);

  const gap = Math.abs((ema3 - ema7) / ema7) * 100;

  if (gap < 0.05) return null; // No signal (insufficient gap)

  return {
    trend: ema3 > ema7 ? 'bullish' : 'bearish',
    ema3,
    ema7,
    gap
  };
}
```

---

## Trade Execution Logic

```javascript
function shouldTrade(emaSignal, bullPct, bearPct, t20sPayout) {
  if (!emaSignal) return null;

  const { trend } = emaSignal;

  // Payout filter: only trade if payout < 1.85x
  if (t20sPayout >= 1.85) return null;

  // Crowd-following logic: bet WITH crowd when EMA confirms same direction
  if (trend === 'bullish' && bullPct >= 65) {
    return 'BULL'; // Crowd is 65%+ bull, EMA shows bullish → bet BULL (with crowd)
  }

  if (trend === 'bearish' && bearPct >= 65) {
    return 'BEAR'; // Crowd is 65%+ bear, EMA shows bearish → bet BEAR (with crowd)
  }

  return null; // No trade
}
```

---

## Dynamic Order Placement System

### Base Position Size
- **Normal mode**: 6.5% of balance
- **Safe mode**: 4.5% of balance

### Dynamic Adjustments

**1. After a Loss (Recovery Mode)**
- First loss after wins → Increase position to 150% of base
  - Normal: 6.5% × 1.5 = 9.75%
  - Safe: 4.5% × 1.5 = 6.75%
- Goal: Recover the loss faster
- Only applies to first loss, then returns to base

**2. After 2 Wins in a Row (Profit-Taking Mode)**
- Reduce next position to 75% of base
  - Normal: 6.5% × 0.75 = 4.875%
  - Safe: 4.5% × 0.75 = 3.375%
- Goal: Lock in profits, reduce risk after winning streak

**3. Safe Mode Extra Rule**
- Requires positive momentum to trade
- If momentum < threshold → skip trade entirely

### Example Sequence (Balance: 1.0 BNB, Normal Mode)
1. Trade 1: Base size → 0.0650 BNB (6.5%) → WIN ✅
2. Trade 2: Base size → 0.0650 BNB (6.5%) → WIN ✅ (2 wins!)
3. Trade 3: Reduced → 0.0487 BNB (4.875%) → LOSS ❌
4. Trade 4: Recovery → 0.0975 BNB (9.75%) → WIN ✅
5. Trade 5: Back to base → 0.0650 BNB (6.5%)

### Implementation

```javascript
function calculateBetSize(bankroll, mode, lastTwoResults) {
  const basePercent = mode === 'safe' ? 4.5 : 6.5;
  let multiplier = 1.0;

  // Check last two results
  const [prev1, prev2] = lastTwoResults; // ['win', 'win'] or ['loss', 'win'], etc.

  // Recovery mode: First loss after wins
  if (prev1 === 'loss' && prev2 === 'win') {
    multiplier = 1.5;
  }

  // Profit-taking mode: Two wins in a row
  if (prev1 === 'win' && prev2 === 'win') {
    multiplier = 0.75;
  }

  return bankroll * (basePercent / 100) * multiplier;
}

// Example
const bankroll = 1.0; // 1 BNB
const mode = 'normal';
const lastTwo = ['win', 'win']; // Two wins

const betSize = calculateBetSize(bankroll, mode, lastTwo);
// betSize = 0.04875 BNB (profit-taking mode)
```

---

## P&L Tracking

```javascript
function calculatePnL(betSize, payoutMultiple, won) {
  if (won) {
    return betSize * (payoutMultiple - 1); // Profit
  } else {
    return -betSize; // Loss
  }
}

// Example
const betSize = 0.065; // BNB
const payoutMultiple = 1.95;
const won = true;

const pnl = calculatePnL(betSize, payoutMultiple, won);
// pnl = 0.06175 BNB profit
```

---

## Future Improvements

### Potential Enhancements
- **Dynamic crowd threshold**: Adjust based on market conditions
- **Multiple timeframes**: Combine 1m, 5m, 15m signals
- **Volume confirmation**: Trade only high-volume rounds
- **Volatility filter**: Avoid trading during extreme volatility
- **Machine learning**: Train on historical patterns

### Risk Mitigation
- **Stop-loss**: Pause trading after N consecutive losses
- **Drawdown limits**: Reduce position size during drawdowns
- **Paper trading**: Test new parameters before live deployment

---

## Monitoring & Alerts

### Key Metrics to Track
- Win rate (rolling 50 trades)
- ROI (daily, weekly, overall)
- Max consecutive losses
- Average payout multiple
- Crowd sentiment distribution

### Alert Conditions
- Win rate drops below 50% (over 50 trades)
- ROI negative for 7+ days
- 5+ consecutive losses

---

## Deployment Checklist

- [ ] Database initialized with monitor running 24/7
- [ ] Backfill historical data (500+ rounds minimum)
- [ ] TradingView API tested and functional
- [ ] EMA calculation verified against known data
- [ ] Strategy logic tested on backfilled data
- [ ] Web3 wallet configured for live trading
- [ ] Gas fee estimation implemented
- [ ] Error handling and auto-recovery
- [ ] Performance logging and dashboards

---

**Last Updated**: 2025-01-06
**Status**: Paper Trading Phase
