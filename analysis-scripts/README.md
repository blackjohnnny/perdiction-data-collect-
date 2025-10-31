# Analysis Scripts

This directory contains all analysis, testing, and experimental scripts for the PancakeSwap Prediction V2 strategy.

## Directory Structure

All scripts in this folder read/write data from the `../data/` directory.

## Key Scripts

### Strategy Testing
- `test-t20-strategy-final.mjs` - Final optimized strategy test (EMA + T-20s crowd)
- `test-ema-gap-65percent.mjs` - Tests different EMA gap thresholds
- `paper-trade-*.mjs` - Paper trading simulations with different position sizing

### Analysis
- `analyze-losses.mjs` - Analyzes why trades lose
- `analyze-time-of-day.mjs` - Performance by UTC hour analysis
- `analyze-wallets-optimized.mjs` - Blockchain wallet tracking (requires RPC access)
- `statistical-*.mjs` - Statistical comparisons between different periods

### Data Management
- `backfill-*.mjs` - Scripts to backfill historical data
- `create-live-monitor-db.mjs` - Creates the live monitoring database
- `migrate-*.mjs` - Database schema migration scripts
- `export-to-csv.mjs` - Export database data to CSV

### Testing & Validation
- `check-*.mjs` - Various data validation scripts
- `verify-*.mjs` - Verification scripts for data integrity
- `debug-*.mjs` - Debugging utilities

## Running Scripts

All scripts should be run from the project root:

```bash
node analysis-scripts/test-t20-strategy-final.mjs
```

## Data Files

Scripts read from and write to `../data/`:
- `live-monitor.db` - Main database with T-20s snapshot data (578 rounds)
- `prediction-data-btc.db` - Historical BTC prediction data (50K+ rounds)
- Various CSV exports for analysis

## Notes

- Most scripts use `sql.js` to read SQLite databases
- EMA calculations use TradingView/Pyth API for 5-minute BNB/USD candles
- Wallet tracking scripts require BSC RPC access (may hit rate limits on public nodes)
