# Quick Command Reference

## Installation
```bash
npm install
```

## Testing
```bash
npm test                  # Test BSC connection and contract
```

## Monitoring
```bash
npm start                 # Start 24/7 monitoring
```

## Backfilling
```bash
npm run backfill          # Fill incomplete rounds
node backfill.js last 500        # Backfill last 500 rounds
node backfill.js range 54000 54500  # Backfill specific range
```

## Database
```bash
npm run stats             # Show database statistics
```

## PM2 (Production)
```bash
pm2 start monitor.js --name "pancake-monitor"
pm2 logs pancake-monitor
pm2 restart pancake-monitor
pm2 stop pancake-monitor
pm2 delete pancake-monitor
```

## Files
| File | Purpose |
|------|---------|
| `monitor.js` | 24/7 WebSocket monitoring |
| `backfill.js` | Historical data collection |
| `db-init.js` | Database setup & queries |
| `contract-abi.js` | Contract interface |
| `db-stats.js` | Database statistics |
| `test-connection.js` | Connection testing |
| `prediction.db` | SQLite database |
| `STRATEGY.md` | Strategy documentation |
| `SETUP.md` | Installation guide |

## Database Queries

### Count samples
```bash
sqlite3 prediction.db "SELECT COUNT(*) FROM rounds;"
```

### Latest rounds
```bash
sqlite3 prediction.db "SELECT sample_id, epoch, winner, winner_payout_multiple FROM rounds WHERE is_complete=1 ORDER BY epoch DESC LIMIT 10;"
```

### Rounds with T-20s data
```bash
sqlite3 prediction.db "SELECT COUNT(*) FROM rounds WHERE t20s_bull_wei IS NOT NULL;"
```
