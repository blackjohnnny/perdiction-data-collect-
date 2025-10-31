# Database Organization

## Database Files

### 1. `live-monitor.db` ✅ **USE THIS FOR ANALYSIS**
**Clean, organized database with monitored data only**

**Schema:**
- Single `rounds` table with snapshot data as columns
- Columns: `t20s_bull_wei`, `t20s_bear_wei`, `t20s_implied_up_multiple`, etc.
- Columns: `t8s_bull_wei`, `t8s_bear_wei`, `t8s_implied_up_multiple`, etc.
- Columns: `t4s_bull_wei`, `t4s_bear_wei`, `t4s_implied_down_multiple`, etc.
- No separate snapshots table - everything in one row per epoch

**Contents:**
- 494 monitored rounds total
- 314 rounds with T-20s snapshots ✅ (313 with settled results)
- 380 rounds with T-8s snapshots ✅ (379 with settled results)
- 378 rounds with T-4s snapshots ✅ (377 with settled results)

**Query Examples:**
```sql
-- Get all rounds with T-20s data and results
SELECT * FROM rounds
WHERE t20s_total_wei IS NOT NULL
  AND winner != 'UNKNOWN';

-- Get all rounds with T-8s data and results
SELECT * FROM rounds
WHERE t8s_total_wei IS NOT NULL
  AND winner != 'UNKNOWN';

-- Calculate T-20s crowd percentage
SELECT
  epoch,
  CAST(t20s_bull_wei AS REAL) / CAST(t20s_total_wei AS REAL) as bull_pct,
  winner
FROM rounds
WHERE t20s_total_wei IS NOT NULL;
```

---

### 2. `prediction-data-clean.db`
**Complete historical data (53K+ rounds) with monitored snapshots**

**Schema:**
- Single `rounds` table with snapshot columns (same as live-monitor.db)
- Includes T-20s, T-25s, T-8s, T-4s columns

**Contents:**
- 53,961 total rounds (all historical backfilled data)
- 53,865 rounds with settled results
- 113 rounds with T-20s snapshots
- 178 rounds with T-25s snapshots
- 178 rounds with T-8s snapshots
- 176 rounds with T-4s snapshots

---

### 3. `prediction-data.db` (Original)
**⚠️ DO NOT USE FOR ANALYSIS - Use live-monitor.db or prediction-data-clean.db instead**

**Schema:**
- `rounds` table (round results)
- `snapshots` table (separate rows for each snapshot type)

**Issues:**
- Messy structure with snapshots in separate table
- Mix of T-20s, T-25s, T-8s, T-4s snapshot types
- Hard to query - need JOINs
- Currently used by live monitoring (writes here first)

---

## Current Live Monitoring Setup

**Status:** ✅ Running and capturing T-20s, T-8s, T-4s

**Process:**
1. Live monitor writes to `prediction-data.db` (old schema)
2. Periodically run reorganization script to update `live-monitor.db`
3. Use `live-monitor.db` for all analysis

**To sync latest monitored data:**
```bash
node create-live-monitor-db.mjs
```

This extracts all monitored rounds from `prediction-data.db` and creates a clean `live-monitor.db`.

---

## Strategy Analysis - Which Database To Use?

### For T-20s Strategy Testing:
**Use: `live-monitor.db`**
- **313 complete T-20s rounds** with settled results ✅
- Clean schema, easy to query
- No confusion

### For T-8s/T-4s Analysis:
**Use: `live-monitor.db`**
- **379 complete T-8s rounds** with settled results ✅
- **377 complete T-4s rounds** with settled results ✅
- All yesterday's collected data is now backfilled and ready

### For Historical EMA-only Testing (50K+ rounds):
**Use: `prediction-data-clean.db`**
- 53,865 rounds with results
- No snapshot data needed for EMA-only

---

## Maintenance

### Backfill Results for Monitored Rounds:
```bash
# Check latest monitored epoch in live-monitor.db
# Then backfill from prediction-data.db
npm start backfill -- --from 424496 --to latest

# Sync to clean database
node create-live-monitor-db.mjs
```

### Future: Migrate to Clean Schema Fully
Once comfortable, update `src/store/sqlite.ts` to write directly to the new schema (columns instead of snapshots table). For now, keep using the sync script.
