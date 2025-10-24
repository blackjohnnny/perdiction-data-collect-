# PancakeSwap Prediction Market Statistical Findings

## Market Context
- **Market**: BNB/USD binary predictions on PancakeSwap V2
- **Round Duration**: 5 minutes
- **House Edge**: 3% (need >51.5% win rate to be profitable)
- **Data Period**: 90 days of historical analysis
- **Total Rounds Analyzed**: 53,574+

## Pattern-Based Strategies

### 1. Three Consecutive UP Moves → DOWN Reversal
**Statistical Edge**: 60-71% DOWN on 4th round (depending on threshold)

| Threshold | DOWN Win Rate | Sample Size (90 days) | Edge Over Random |
|-----------|---------------|----------------------|------------------|
| ≥0.2% each | 59.7% | ~82 occurrences | +9.7% |
| ≥0.25% each | 63.4% | 41 occurrences | +13.4% |
| ≥0.3% each | ~65% | ~28 occurrences | +15% |
| ≥0.5% each | 71.4% | 7 occurrences | +21.4% |

**Best Practical Strategy**: Use ≥0.25% threshold (63.4% win rate, 41 opportunities/90 days)
**Frequency**: ~0.45 opportunities per day at ≥0.25% threshold

### 2. Large Move + Weak Follow-Through → Reversal
**Statistical Edge**: 57-60% reversal probability

**Pattern**:
- Large move ≥0.3% in one direction
- Followed by small move <0.1% in same direction
- Next round tends to reverse

**Win Rate**: 57.3%
**Sample Size**: Moderate (specific count not recorded)
**Edge Over Random**: +7.3%

### 3. Two Consecutive Large UPs → DOWN Reversal
**Statistical Edge**: 67.9% DOWN on 3rd round

| Threshold | DOWN Win Rate | Sample Size (30 days) |
|-----------|---------------|----------------------|
| ≥0.5% each | 67.9% | 28 occurrences |
| ≥0.6% each | 66.7% | 18 occurrences |

**Note**: Less frequent than 3-consecutive pattern, but slightly higher win rate

## Trend-Following Strategy

### BNB Price Trend Correlation (2-3 Hour Windows)
**Statistical Edge**: 60-83% win rates during strong trends

**Key Findings**:
- **Correlation**: 87% alignment between BNB price movement and prediction outcomes
- **Optimal Window**: 2-3 hours
- **Frequency**: ~10 tradeable periods per 90 days
- **Win Rate Range**: 60-83% when BNB moves >1-2% in 2-3 hour window

**Window Analysis**:
- 1-hour windows: Too noisy, low correlation
- 2-3 hour windows: **OPTIMAL** - 87% correlation
- 6-12 hour windows: Correlation exists but weaker bias

**Strategy**:
- Monitor BNB price over rolling 2-3 hour periods
- When BNB moves >1-2% in one direction, bet in that direction
- Expected win rate: 60-83% during these periods
- ~10 opportunities per 90 days = 0.11 per day

## Patterns With NO Edge (Around 50/50)

### Failed Patterns (Do NOT Use):
1. **Alternating Pattern Breaks** (UP-DOWN-UP-DOWN): 51.2% continuation vs 48.8% break
2. **Streak Exhaustion** (4-7 in a row): ~50% reversal
3. **Building Momentum** (increasing magnitude): 49.8% reversal
4. **Sharp Reversal Continuation**: ~50% split
5. **Single Large Move Reversal** (most thresholds): ~50-52%
6. **12+ hour trend windows**: Weak/no directional bias

## Volatility Insights

### Movement Distribution (30 days):
- Small moves (<0.2%): ~70% of rounds
- Medium moves (0.2-0.5%): ~25% of rounds
- Large moves (>0.5%): ~5% of rounds

### Volatility Clustering:
- Large moves tend to follow large moves
- No consistent directional pattern after single large move

## Contrarian Strategy Status

**Previous Finding**: +24.64% ROI betting against majority
**Status**: UNVALIDATED - used final pool distributions instead of T-8s/T-25s snapshots
**Current Action**: Collecting T-25s, T-8s, T-4s snapshot data for proper validation
**Data Needed**: Hundreds of snapshots with winner outcomes

## Snapshot Timing System

### Three Capture Windows:
1. **T-25s** (25-20s before lock): Manual betting window
2. **T-8s** (8-4s before lock): Standard automated betting
3. **T-4s** (4-0s before lock): Ultra-fast automated betting

**Purpose**: Capture pool distributions at different times to measure last-minute betting behavior

## Combined Strategy Recommendations

### High Frequency (Daily Opportunities):
**Pattern**: 3 consecutive UPs ≥0.25% → Bet DOWN
- Win Rate: 63.4%
- Frequency: 0.45 times/day
- ROI Potential: ~11.9% per bet (63.4% - 51.5% breakeven)

### Medium Frequency (Weekly Opportunities):
**Pattern**: 2-3 hour BNB trend >1-2% → Bet with trend
- Win Rate: 60-83% (average ~70%)
- Frequency: ~10 per 90 days = 0.77/week
- ROI Potential: ~18.5% per bet (70% - 51.5% breakeven)

### Supplementary Pattern:
**Pattern**: Large move ≥0.3% + weak follow-through <0.1% → Bet reversal
- Win Rate: 57.3%
- ROI Potential: ~5.8% per bet

## Risk Considerations

1. **Sample Size**: Some patterns (≥0.5% threshold) have small samples (7-28 occurrences)
2. **Market Dynamics**: Patterns may change if market participants discover them
3. **House Edge**: 3% fee requires >51.5% win rate minimum
4. **Timing**: T-4s snapshots enable latest data but require fast execution
5. **False Signals**: All patterns have 29-40% failure rate

## Data Quality Notes

- 53,574+ completed rounds collected
- Database: SQLite with rounds, snapshots tables
- Lock prices, close prices, pool distributions all recorded
- Snapshot collection: In progress (T-25s, T-8s working; T-4s pending fix)
