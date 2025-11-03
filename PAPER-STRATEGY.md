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

### Dynamic Position Sizing (CONSERVATIVE Strategy)

**Base Position:** 6.5% of current bankroll

**Adjustments Based on Win/Loss Patterns:**

- **After 1 Loss:** Increase to 9.75% (1.5x) for ONE trade only
  - Exploits 71.79% win rate observed after losses (vs 59.46% baseline)
  - Returns to normal after next trade regardless of outcome

- **After 2+ Consecutive Wins:** Reduce to 4.875% (0.75x)
  - Win rate drops to 50-54% after win streaks
  - Protects accumulated profits during mean reversion

- **Normal Conditions:** 6.5% position size

**Rationale:**
- Statistical analysis shows mean reversion: win rate increases significantly after losses
- ONE-TIME approach avoids Martingale risk (no compounding during losing streaks)
- Reduces exposure when win probability decreases (after multiple wins)
- Uses compound growth (bankroll adjusts after each trade)

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

### Strategy Comparison

| Strategy | ROI | Win Rate | Max Drawdown |
|----------|-----|----------|--------------|
| **Fixed 6.5%** | +529.16% | 59.46% | ~-40% |
| **CONSERVATIVE (Dynamic)** | +781.46% | 59.46% | -48.60% |
| **CONSERVATIVE + 50% Split** | +170.75% | 59.46% | -23.45% |

**Trade Statistics (All Strategies):**
- Total Trades: 148 out of 820 rounds (18.0% trade frequency)
- Wins: 88 (59.46%)
- Losses: 60 (40.54%)

### CONSERVATIVE Strategy (Recommended)

**Performance with 10 BNB starting capital:**
- Final Balance: 88.15 BNB
- Profit: +78.15 BNB
- ROI: +781.46%
- Max Drawdown: -48.60%

**Risk Profile:**
- Medium risk with manageable drawdowns
- 48% better returns than fixed sizing (+781% vs +529%)
- Exploits mean reversion pattern (71.79% win rate after losses)

### Conservative Alternative (Lower Risk)

For more capital preservation, use 50% profit split:
- Take 50% of each winning trade to "safe" balance
- Compound other 50%
- With 10 BNB: 27.08 BNB total (23.48 BNB secured, 3.59 BNB at risk)
- ROI: +170.75%, Max Drawdown: -23.45%

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

### 4. Mean Reversion Pattern

Statistical analysis reveals a strong edge after losses:
- **After 1 loss:** Win rate jumps to 71.79% (vs 59.46% baseline)
- **After 2+ wins:** Win rate drops to 50-54% (below baseline)
- **After 3+ consecutive results:** Win rate significantly decreases

The CONSERVATIVE strategy exploits this by:
- Increasing position size when win probability is highest (after losses)
- Decreasing position size when win probability drops (after win streaks)
- Using ONE-TIME adjustments to avoid Martingale compounding risk

## Risk Warnings

⚠️ **This is paper trading only - not financial advice**

### Known Risks

1. **Small Sample Size:** Only 820 rounds (9 days) of data - patterns may not hold long-term
2. **Overfitting Risk:** Strategy optimized on limited historical data
3. **Drawdown Risk:** -48.60% max drawdown observed (CONSERVATIVE strategy)
4. **Market Changes:** Pool behavior and EMA patterns can shift
5. **Smart Contract Risk:** Blockchain betting involves technical risks
6. **Losing Streaks:** 6+ consecutive losses have occurred

### Risk Management Options

**High Return / Medium Risk:**
- Use CONSERVATIVE strategy (dynamic sizing)
- Accept -48.60% max drawdown
- Target +781% ROI

**Lower Return / Lower Risk:**
- Use 50% profit split approach
- Secure half of all profits immediately
- Max drawdown reduces to -23.45%
- Target +170% ROI with capital preservation

**Important:** Past performance does not guarantee future results. Always paper trade first before risking real capital.

## Implementation

### Testing Strategies

Use `test-fixed-one-time.mjs` to test dynamic position sizing strategies:

```javascript
// CONSERVATIVE Strategy (Recommended)
{
  name: 'CONSERVATIVE: 1.5x After Loss + 0.75x After 2 Wins',
  getPositionSize: (balance, justLost, currentWinStreak) => {
    const BASE = 0.065; // 6.5%
    if (justLost) return BASE * 1.5;        // 9.75% after loss
    if (currentWinStreak >= 2) return BASE * 0.75; // 4.875% after 2+ wins
    return BASE; // 6.5% normal
  }
}
```

### Configuration

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
    positionSize: 0.065       // 6.5% (base for dynamic sizing)
  }
};
```

## Data Files

- **live.db:** 820 rounds with T-20s snapshot data (strategy-ready)
- **snapshots.db:** Raw snapshot storage (all timing types)
- **historic.db:** 208 rounds without snapshots (reference only)

---

*Strategy validated on October 2025 data. Always paper trade before risking real capital.*
