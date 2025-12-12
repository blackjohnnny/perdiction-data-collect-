# Project Summary

## What This System Does

Monitors PancakeSwap BNB prediction pools 24/7 and collects critical timing data for strategy backtesting.

### Key Features

✅ **Real-time WebSocket Monitoring**
- Captures StartRound, LockRound, EndRound events
- Auto-increments sample_id (1, 2, 3...)
- Tracks epochs and timestamps

✅ **Multi-Snapshot Data Collection**
- T-20s: Pool state 20 seconds before lock
- T-8s: Pool state 8 seconds before lock
- T-4s: Pool state 4 seconds before lock
- Lock: Final pool amounts and BNB price
- Settlement: Close price, winner, payout multiple

✅ **Historical Backfilling**
- Fill incomplete rounds
- Backfill last N rounds
- Backfill specific epoch ranges
- Rate-limited for stability

✅ **SQLite Database**
- Fast, reliable storage
- WAL mode for concurrent access
- Indexed for quick queries
- Auto-schema creation

---

## Project Structure

```
perdiction-data-collect-/
├── monitor.js              # 24/7 WebSocket monitoring
├── backfill.js             # Historical data fetching
├── db-init.js              # Database initialization
├── contract-abi.js         # PancakeSwap contract interface
├── db-stats.js             # Database statistics viewer
├── test-connection.js      # Connection testing utility
│
├── STRATEGY.md             # EMA 3/7 strategy documentation
├── SETUP.md                # Installation & deployment guide
├── COMMANDS.md             # Quick command reference
├── README.md               # Main documentation
│
├── package.json            # Dependencies & scripts
├── .gitignore              # Git ignore rules
└── prediction.db           # SQLite database (auto-created)
```

---

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 18+ |
| Blockchain | ethers.js v6 |
| Database | better-sqlite3 |
| Network | BSC WebSocket + HTTP RPC |
| Contract | PancakeSwap Prediction V2 |

---

## Data Flow

```
1. StartRound Event Fired
   ↓
2. Insert Round → DB (sample_id auto-increments)
   ↓
3. Schedule Timers (T-20s, T-8s, T-4s)
   ↓
4. Capture Snapshots → Update DB
   ↓
5. LockRound Event → Store lock price & final pools
   ↓
6. EndRound Event → Store close price & winner
   ↓
7. Round Complete ✅
```

---

## Database Schema Summary

**Key Fields:**
- `sample_id` - Auto-incrementing counter
- `epoch` - Round number (unique)
- `lock_timestamp` / `close_timestamp` - Round timing
- `t20s_bull_wei`, `t20s_bear_wei` - Snapshot at T-20s
- `t8s_bull_wei`, `t8s_bear_wei` - Snapshot at T-8s
- `t4s_bull_wei`, `t4s_bear_wei` - Snapshot at T-4s
- `lock_bull_wei`, `lock_bear_wei` - Final pools
- `lock_price`, `close_price` - BNB prices (8 decimals)
- `winner` - 'bull', 'bear', or 'draw'
- `winner_payout_multiple` - Payout ratio
- `is_complete` - Settlement status

---

## Strategy Context

**EMA 3/7 Contrarian Strategy:**
- EMA crossover on 5-minute candles
- Bet against crowd when ≥65% on opposite side
- Gap ≥0.05% for trend confirmation
- Risk 6.5% per trade

**Historical Performance:**
- 836 rounds tested
- 57.06% win rate
- +172.31% ROI

See [STRATEGY.md](STRATEGY.md) for full details.

---

## Next Steps

### Phase 1: Data Collection (Current)
- ✅ Monitor running 24/7
- ✅ Database collecting samples
- ⏳ Target: 2000+ complete rounds with T-20s data

### Phase 2: Backtesting (Next)
- Load complete rounds from database
- Fetch TradingView 5-min candles
- Calculate EMA 3/7 signals
- Simulate trades using T-20s crowd data
- Calculate P&L, win rate, drawdown

### Phase 3: Paper Trading
- Connect TradingView API
- Generate signals in real-time
- Log hypothetical trades
- Validate strategy on live data

### Phase 4: Live Trading
- Integrate Web3 wallet
- Gas fee estimation
- Auto-bet execution
- Performance monitoring
- Alert system

---

## Usage Examples

### Start monitoring
```bash
npm start
```

### Check progress
```bash
npm run stats
```

### Backfill data
```bash
npm run backfill
node backfill.js last 1000
```

### Query database
```bash
sqlite3 prediction.db "SELECT * FROM rounds WHERE is_complete=1 LIMIT 5;"
```

---

## Contract Details

- **Address**: `0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA`
- **Network**: Binance Smart Chain (BSC)
- **Version**: PancakeSwap Prediction V2
- **Round Duration**: 5 minutes
- **Verified**: Yes (BscScan)

---

## Deployment Targets

- **Raspberry Pi 5** - Primary (24/7 local monitoring)
- **VPS** - Backup (cloud redundancy)
- **Local Dev** - Testing & development

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Uptime | >99% (monitor running) |
| Samples | 2000+ with T-20s data |
| Complete Rounds | >1500 with settlement |
| Data Accuracy | 100% (verified on-chain) |

---

## Contact & Support

- **Issues**: Check logs in monitor output
- **Database**: Use `npm run stats` to inspect
- **Strategy**: See [STRATEGY.md](STRATEGY.md)
- **Setup**: See [SETUP.md](SETUP.md)

---

**Status**: ✅ System Ready - Data Collection Phase
**Last Updated**: 2025-01-06
**Version**: 1.0.0
