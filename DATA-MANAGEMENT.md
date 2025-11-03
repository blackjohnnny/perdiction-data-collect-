# DATA MANAGEMENT - READ THIS

## CRITICAL RULES

### ✅ live.db MUST ONLY CONTAIN:
1. Rounds with T-20s snapshot data (t20s_total_wei != 0)
2. Rounds that have settled (winner != UNKNOWN)
3. Complete data (prices, pool amounts, winner)

### ❌ NEVER ADD TO live.db:
- Rounds without T-20s snapshots
- Rounds still in progress (winner = UNKNOWN)
- Incomplete or placeholder data

## WHY?

**live.db is our STRATEGY DATASET.**

Our backtest strategy requires:
- T-20s implied payout for DECISION making (crowd confirmation)
- Final settlement data for PROFIT calculation

Without T-20s data, a round is USELESS for backtesting.

## DAILY WORKFLOW

### 1. Monitor is Running (24/7)
```bash
DB_PATH=./data/live-monitor.db npm start live
```

This captures:
- All rounds from the blockchain
- T-20s, T-8s, T-4s snapshots (in real-time)
- Final settlement data

Data goes to: `live-monitor.db`

### 2. Daily Merge (Run once per day)
```bash
node daily-merge.mjs
```

This:
- ✅ Takes ONLY rounds with T-20s data from live-monitor.db
- ✅ Takes ONLY settled rounds (winner != UNKNOWN)
- ✅ Adds them to live.db
- ❌ Ignores rounds without snapshots
- ❌ Ignores unsettled rounds

### 3. Verify Clean Data
```bash
node -e "import('sql.js').then(async (m) => { const SQL = await m.default(); const fs = await import('fs'); const buf = fs.readFileSync('./data/live.db'); const db = new SQL.Database(buf); const total = db.exec('SELECT COUNT(*) FROM rounds')[0].values[0][0]; const withT20s = db.exec('SELECT COUNT(*) FROM rounds WHERE t20s_total_wei != \"0\"')[0].values[0][0]; console.log('Total rounds:', total); console.log('With T-20s:', withT20s); console.log('Clean?', total === withT20s ? '✅ YES' : '❌ NO - RUN clean-live-db.mjs'); db.close(); })"
```

## IF DATA GETS DIRTY

If live.db somehow contains rounds without T-20s data:

```bash
node clean-live-db.mjs
```

This DELETES all rounds without T-20s data from live.db.

## FILE PURPOSES

| File | Purpose | Contains |
|------|---------|----------|
| **live.db** | Clean strategy dataset | ONLY rounds with T-20s + settled |
| **live-monitor.db** | Raw monitoring data | All rounds (some without snapshots) |
| **snapshots.db** | Backup snapshots | Raw snapshot storage |
| **historic.db** | Archive | Old rounds without snapshots |

## SCRIPTS

| Script | Purpose | When to Run |
|--------|---------|-------------|
| `daily-merge.mjs` | Merge new clean rounds | Daily |
| `clean-live-db.mjs` | Remove dirty data | If live.db gets corrupted |
| `merge-new-rounds.mjs` | Old script | ❌ DON'T USE |

## MONITORING STATUS

Check if monitor is running:
```bash
ps aux | grep "npm start live"
```

Check latest captured data:
```bash
node check-new-rounds.mjs
```

## REMEMBER

**T-20s snapshots can ONLY be captured in REAL-TIME.**

If you miss a round, you CANNOT get its T-20s data later. That round is USELESS for strategy backtesting.

This is why the monitor must run 24/7.
