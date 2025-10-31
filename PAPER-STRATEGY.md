# Paper Trading Strategy

## Overview

This strategy combines technical analysis (EMA crossover) with crowd sentiment to predict 5-minute BNB/USD price movements on PancakeSwap Prediction V2.

## Strategy Components

### 1. EMA Crossover Signal

**What it does:** Identifies short-term price momentum using two moving averages.

- **Fast EMA:** 3-period exponential moving average
- **Slow EMA:** 7-period exponential moving average
- **Signal Generation:**
  - **Bullish:** Fast EMA > Slow EMA (price trending up)
  - **Bearish:** Fast EMA < Slow EMA (price trending down)

**Gap Filter:** Only trade when EMAs are at least 0.05% apart. This filters out weak signals during sideways markets.

### 2. Crowd Confirmation

**What it does:** Validates EMA signal by checking if the betting pool agrees.

- **Measurement:** Pool distribution at T-20s (20 seconds before round locks)
- **Threshold:** Require ≥65% of pool on one side
- **Logic:** If crowd is heavily bullish/bearish, they likely see the same trend

### 3. Signal Agreement

**Entry Condition:** Only enter a trade when BOTH indicators agree:

- EMA says BULL + Crowd says BULL = **BET BULL**
- EMA says BEAR + Crowd says BEAR = **BET BEAR**

If they disagree, skip the round.

## Position Sizing

**Bet Amount:** 6.5% of current bankroll per trade

- Uses compound growth (bankroll adjusts after each trade)
- Aggressive sizing for higher returns but larger drawdowns
- Alternative: 2% for conservative approach

## Execution

### Data Sources

1. **Price Data:** TradingView API via Pyth Network (5-minute BNB/USD candles)
2. **Pool Data:** PancakeSwap Prediction V2 smart contract (BSC blockchain)
3. **Snapshot Timing:** T-20s (20 seconds before lock)

### Trade Flow

1. **Before Lock (-20s):** Capture pool distribution from blockchain
2. **At Decision Time:** Calculate EMAs from TradingView candles
3. **Check Agreement:** Verify EMA + crowd both bullish or both bearish
4. **Verify Gap:** Ensure EMAs are at least 0.05% apart
5. **Enter Trade:** Place bet with 6.5% of bankroll
6. **Wait for Settlement:** Round closes in 5 minutes, winner determined

## Expected Performance

Based on 820 rounds of historical data (Oct 22-31, 2025):

| Metric | Value |
|--------|-------|
| **Win Rate** | 59.46% |
| **Trade Frequency** | 18.0% |
| **ROI** | +436.84% |
| **Total Trades** | 148 out of 820 rounds |

**Risk Metrics:**
- Maximum drawdown: ~30-35% (estimated based on 6.5% position size)
- Losing streaks: 6+ trades observed
- Losing days: ~33% of trading days

## Why This Works

### 1. Trend Following

EMAs capture short-term momentum. When fast EMA crosses above slow EMA, price is accelerating upward.

### 2. Informed Crowd

The betting pool includes traders analyzing the same charts. When 65%+ bet one direction, they collectively validate the trend.

### 3. Selective Trading

By requiring both signals AND a minimum gap, we filter out:
- Sideways/choppy markets (low EMA gap)
- Weak trends (crowd not convinced)
- Disagreement periods (mixed signals)

Only trading 18% of rounds means we focus on high-conviction setups.

## Risk Warnings

⚠️ **This is paper trading only - not financial advice**

- Strategy is based on historical data that may not repeat
- 6.5% position size creates significant drawdown risk
- Past performance does not guarantee future results
- Blockchain betting involves smart contract risks
- Market conditions can change rapidly

## Configuration

To test different scenarios, edit `test-strategy.mjs`:

```javascript
const CONFIG = {
  DATABASE: './data/live.db',

  ROUNDS: {
    mode: 'all',        // 'all', 'latest', 'range', 'first'
    count: 150,         // For 'latest' or 'first'
    from: 423620,       // For 'range'
    to: 425000
  },

  STRATEGY: {
    emaFast: 3,
    emaSlow: 7,
    emaGap: 0.0005,          // 0.05%
    crowdThreshold: 0.65,     // 65%
    positionSize: 0.065       // 6.5%
  }
};
```

## Data Files

- **live.db:** 820 rounds with T-20s snapshot data (strategy-ready)
- **snapshots.db:** Raw snapshot storage (all timing types)
- **historic.db:** 208 rounds without snapshots (reference only)

---

*Strategy validated on October 2025 data. Always paper trade before risking real capital.*
