# PancakeSwap Prediction Data Collector

Automated monitoring system for PancakeSwap BNB price prediction pools. Collects real-time pool data with T-20s, T-8s, and T-4s snapshots for strategy backtesting.

## Quick Start

See [SETUP.md](SETUP.md) for detailed installation guide.

```bash
# Install dependencies
npm install

# Test connection
npm test

# Start 24/7 monitoring
npm start

# View database stats
npm run stats
```

For all commands, see [COMMANDS.md](COMMANDS.md).

## Database Schema

Each monitored round includes:

| Field | Description |
|-------|-------------|
| `sample_id` | Auto-incrementing counter (1, 2, 3...) |
| `epoch` | Round number from contract |
| `lock_timestamp` | When betting closes |
| `close_timestamp` | When round settles |
| `t20s_bull_wei` | Bull pool 20s before lock |
| `t20s_bear_wei` | Bear pool 20s before lock |
| `t8s_bull_wei` | Bull pool 8s before lock |
| `t8s_bear_wei` | Bear pool 8s before lock |
| `t4s_bull_wei` | Bull pool 4s before lock |
| `t4s_bear_wei` | Bear pool 4s before lock |
| `lock_bull_wei` | Final bull pool at lock |
| `lock_bear_wei` | Final bear pool at lock |
| `lock_price` | BNB price at lock (8 decimals) |
| `close_price` | BNB price at close (8 decimals) |
| `winner` | 'bull', 'bear', or 'draw' |
| `winner_payout_multiple` | Payout ratio (e.g., 1.95x) |
| `is_complete` | Settlement status |

## Strategy

See [STRATEGY.md](STRATEGY.md) for full details on the EMA 3/7 Contrarian Strategy.

### Key Rules
- EMA 3/7 crossover on 5-minute candles
- Gap ≥0.05% for trend confirmation
- Bet against crowd when ≥65% on opposite side
- Risk 6.5% of bankroll per trade

## Project Files

### Core Scripts
- [monitor.js](monitor.js) - 24/7 WebSocket monitoring
- [backfill.js](backfill.js) - Historical data collection
- [db-init.js](db-init.js) - Database setup & queries
- [contract-abi.js](contract-abi.js) - PancakeSwap contract interface

### Utilities
- [db-stats.js](db-stats.js) - Database statistics viewer
- [test-connection.js](test-connection.js) - Connection testing

### Documentation
- [SETUP.md](SETUP.md) - Installation & deployment guide
- [STRATEGY.md](STRATEGY.md) - EMA 3/7 strategy documentation
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture diagrams
- [COMMANDS.md](COMMANDS.md) - Quick command reference
- [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) - High-level overview

### Configuration
- [package.json](package.json) - Dependencies & scripts
- [.gitignore](.gitignore) - Git ignore rules
- `prediction.db` - SQLite database (auto-created)

## Contract Info

- **Address**: `0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA`
- **Network**: Binance Smart Chain (BSC)
- **Type**: PancakeSwap Prediction V2

## Requirements

- Node.js 18+
- Internet connection for BSC WebSocket
- ~10MB storage per 1000 rounds

## Troubleshooting

### Monitor disconnects
The WebSocket will auto-reconnect on network issues. If it doesn't, restart:
```bash
npm start
```

### Missing snapshots
Snapshots are scheduled when StartRound fires. If your system time is off or monitor started mid-round, snapshots may be missed. They'll be captured on the next round.

### Backfill fails
If RPC rate limits you, increase `DELAY_MS` in `backfill.js`.

## Next Steps

1. **Run monitor for 7+ days** to collect sufficient data
2. **Backfill historical rounds** for larger dataset
3. **Implement backtesting** to validate strategy
4. **Deploy live trading bot** with Web3 wallet integration

---

**Status**: Data Collection Phase
**Last Updated**: 2025-01-06
