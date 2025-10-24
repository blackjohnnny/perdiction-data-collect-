# PancakeSwap Prediction V2 Data Collector

A reliable, TypeScript-based data collector for PancakeSwap Prediction V2 on BNB Smart Chain. Collects historical and live round data for analysis, storing in SQLite with CSV export capabilities.

## Features

- **Historical backfill**: Fetch and store past prediction rounds with configurable concurrency
- **Live monitoring**: Real-time tracking of new rounds with T-20s snapshots (20 seconds before lock)
- **Persistent storage**: SQLite database with idempotent upserts
- **CSV export**: Export rounds and snapshots to CSV format
- **Winner calculation**: Automatic computation of round winners and payout multiples
- **Type-safe**: Full TypeScript implementation with viem for blockchain interactions
- **Retry logic**: Built-in exponential backoff for failed RPC calls

## Data Points Collected

### Rounds Table
- **Timestamps**: start, lock, close
- **Oracle prices**: lock price, close price (int256)
- **Betting pools**: total amount, bull amount, bear amount (wei, 18 decimals)
- **Rewards**: reward base calculation amount, reward amount (exact on-chain values)
- **Metadata**: oracle called status, derived winner (UP/DOWN/DRAW/UNKNOWN)
- **Payout**: winner_multiple = rewardAmount / rewardBaseCalAmount

### Snapshots Table (Live Mode)
- **T-20s snapshot**: Total/bull/bear amounts ~20 seconds before lock
- **Implied multiples**: Calculated UP and DOWN payouts at snapshot time
- **Timestamp**: When the snapshot was captured

## Installation

```bash
# Install dependencies
pnpm install

# Copy environment template
cp .env.example .env

# Edit .env with your BSC RPC endpoint (optional)
```

## Configuration

Environment variables (`.env`):

```bash
BSC_RPC=https://bsc-dataseed.binance.org  # BSC RPC endpoint
POLL_INTERVAL_MS=3000                      # Live mode polling interval
DB_PATH=./prediction-data.db               # SQLite database path
CONCURRENCY=6                              # Backfill concurrency
MAX_RETRIES=5                              # Max RPC retry attempts
RETRY_BASE_DELAY_MS=200                    # Retry backoff base delay
```

## Usage

### Build

```bash
pnpm build
```

### Historical Backfill

Fetch historical rounds from epoch range:

```bash
# Backfill from epoch 423000 to latest
pnpm start backfill --from 423000 --to latest

# Backfill specific range
pnpm start backfill --from 423000 --to 425000
```

Features:
- Configurable concurrency (default: 6)
- Automatic retry with exponential backoff
- Progress logging every 100 epochs
- Idempotent (safe to re-run)

### Live Mode

Monitor new rounds and capture T-20s snapshots:

```bash
pnpm start live
```

Features:
- Polls current epoch every 3 seconds (configurable)
- Stores finalized round data when new epoch begins
- Captures snapshot ~20 seconds before lock timestamp
- Runs indefinitely (Ctrl+C to stop)
- One T-20s snapshot per epoch (idempotent)

### CSV Export

Export database tables to CSV:

```bash
# Export rounds (raw wei values)
pnpm start export --table rounds --out rounds.csv

# Export rounds with human-readable BNB values
pnpm start export --table rounds --out rounds-human.csv --human

# Export snapshots
pnpm start export --table snapshots --out snapshots.csv
```

### Database Statistics

View collection statistics:

```bash
pnpm start stats
```

Output includes:
- Current on-chain epoch
- Total rounds stored
- Total snapshots captured
- Winner breakdown (UP/DOWN/DRAW/UNKNOWN percentages)

## Architecture

```
src/
├── abi/
│   └── prediction.json        # Minimal contract ABI
├── store/
│   └── sqlite.ts              # Database schema and operations
├── pipeline/
│   ├── historical.ts          # Backfill logic with concurrency
│   └── live.ts                # Live watcher with T-20s snapshots
├── export/
│   └── csv.ts                 # CSV export utilities
├── config.ts                  # Environment configuration
├── contract.ts                # Viem client + typed helpers
└── index.ts                   # CLI entry point
```

## Contract Details

- **Address**: `0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA`
- **Network**: BNB Smart Chain (mainnet)
- **Contract**: PancakeSwap Prediction V2
- **Read functions**: `currentEpoch()`, `rounds(uint256)`, `treasuryFee()`

## Data Accuracy

### Winner Determination

```typescript
if (!oracleCalled) → UNKNOWN
else if (closePrice > lockPrice) → UP
else if (closePrice < lockPrice) → DOWN
else → DRAW (house wins)
```

### Winner Multiple

```
winner_multiple = rewardAmount / rewardBaseCalAmount
```

Where:
- `rewardBaseCalAmount` = winning side's pool (bullAmount or bearAmount)
- `rewardAmount` = totalAmount - treasuryFee (exact on-chain value)

### Implied Multiples (T-20s snapshots)

```
implied_up = totalAmount / bullAmount
implied_down = totalAmount / bearAmount
```

Note: Implied multiples are **estimates** at T-20s. Final payouts differ due to:
- Late bets after snapshot
- Treasury fee (already factored into on-chain `rewardAmount`)

## Important Notes

### Precision
- All amounts stored as **strings** in wei (18 decimals)
- Prices stored as raw int256 values
- Convert to BNB: `amount / 1e18`
- Multiples stored as floats for convenience

### Idempotency
- Re-running backfill updates existing rows (safe)
- Re-running live mode updates rounds in-place
- Snapshots use `(epoch, snapshot_type)` composite primary key

### DRAW/House Wins
- When `lockPrice == closePrice`:
  - `winner = 'DRAW'`
  - `rewardBaseCalAmount = 0`
  - `rewardAmount = 0`
  - `winner_multiple = NULL`

### T-20s Snapshots
- Only captured in live mode
- Not reconstructible from historical data
- Best-effort (may miss if process not running)
- Saved once per epoch (idempotent)

## Testing

Run unit tests:

```bash
pnpm test
```

Tests cover:
- Winner determination logic
- Winner multiple calculation
- Implied multiple calculation
- Database upsert idempotency

## Development

```bash
# Development mode (tsx)
pnpm dev backfill --from 423000 --to 423100

# Type check
pnpm typecheck

# Build
pnpm build
```

## References

- [Contract on BscScan](https://bscscan.com/address/0x18b2a687610328590bc8f2e5fedde3b582a49cda)
- [PancakeSwap Prediction Docs](https://docs.pancakeswap.finance/play/prediction)
- [Viem Documentation](https://viem.sh)

## License

MIT
