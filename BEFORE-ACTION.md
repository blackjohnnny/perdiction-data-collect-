# BEFORE-ACTION: Project Navigation & Structure Guide

## Purpose
This document helps AI assistants (Claude, etc.) navigate the codebase correctly and avoid information failures when working on this project.

---

## 📁 Directory Structure & File Locations

### Core Application Code
```
src/
├── config.ts              # Configuration (DB paths, RPC endpoints)
├── contract.ts            # Blockchain client & contract interactions
├── index.ts               # CLI entry point
├── abi/                   # Contract ABIs
├── store/
│   └── sqlite.ts          # Database schema & operations
├── pipeline/
│   ├── live.ts            # Live monitoring with T-20s snapshots
│   └── historical.ts      # Historical data backfill
├── export/
│   └── csv.ts             # CSV export utilities
└── analysis/              # Built-in TypeScript analysis modules
```

### Data Files (ALL databases and exports)
```
data/
├── live-monitor.db              # Main database (578 rounds with T-20s snapshots)
├── prediction-data.db           # General prediction data
├── prediction-data-btc.db       # BTC historical data (50K+ rounds)
├── prediction-data-clean.db     # Cleaned dataset
├── *.csv                        # All CSV exports
├── *.json                       # Cache files (wallet-analysis-cache.json)
├── DATABASE-README.md           # Database schema documentation
└── STRATEGY-FINDINGS-UPDATED.md # Strategy research findings
```

### Analysis & Test Scripts (ALL .mjs files)
```
analysis-scripts/
├── README.md                        # Scripts documentation
├── test-t20-strategy-final.mjs      # Main optimized strategy test
├── paper-trade-*.mjs                # Paper trading simulations
├── analyze-*.mjs                    # Analysis tools
├── test-*.mjs                       # Testing scripts
├── simulate-*.mjs                   # Simulation scripts
├── backfill-*.mjs                   # Data backfill utilities
├── check-*.mjs                      # Validation scripts
├── verify-*.mjs                     # Verification scripts
└── migrate-*.mjs                    # Database migration scripts
```

---

## 🎯 Navigation Rules

### Rule 1: Database Files
- **ALWAYS** look in `data/` directory for `.db` files
- **Main database**: `data/live-monitor.db` (578 rounds with T-20s data)
- **Historical**: `data/prediction-data-btc.db` (50K+ rounds for EMA testing)

### Rule 2: Analysis Scripts
- **ALWAYS** look in `analysis-scripts/` for `.mjs` files
- Scripts import data from `../data/`
- Scripts export results to `../data/`

### Rule 3: Source Code
- **ALWAYS** look in `src/` for `.ts` files
- Configuration: `src/config.ts`
- Database operations: `src/store/sqlite.ts`
- Live monitoring: `src/pipeline/live.ts`

### Rule 4: Running Scripts
- **ALWAYS** run from project root:
  ```bash
  node analysis-scripts/script-name.mjs
  ```
- **NEVER** cd into analysis-scripts/ to run

### Rule 5: File Paths in Code
- Analysis scripts use **relative paths**: `../data/live-monitor.db`
- Source code uses **relative paths**: `./data/prediction-data.db`
- Environment variable: `DB_PATH=./data/prediction-data.db`

---

## 🗄️ Data Arrangement

### Database Schema (SQLite)

#### `rounds` table (both databases)
```sql
CREATE TABLE rounds (
  epoch INTEGER PRIMARY KEY,
  start_timestamp INTEGER,
  lock_timestamp INTEGER,
  close_timestamp INTEGER,
  lock_price TEXT,        -- int256 as string
  close_price TEXT,       -- int256 as string
  total_amount TEXT,      -- wei (18 decimals)
  bull_amount TEXT,       -- wei
  bear_amount TEXT,       -- wei
  reward_base_cal_amount TEXT,
  reward_amount TEXT,
  oracle_called INTEGER,
  winner TEXT,            -- 'UP', 'DOWN', 'DRAW', 'UNKNOWN'
  winner_multiple REAL    -- Payout multiplier
);
```

#### `snapshots` table (live-monitor.db only)
```sql
CREATE TABLE snapshots (
  epoch INTEGER,
  snapshot_type TEXT,     -- 't20s', 't25s', etc.
  total_amount TEXT,
  bull_amount TEXT,
  bear_amount TEXT,
  implied_up_multiple REAL,
  implied_down_multiple REAL,
  timestamp INTEGER,
  PRIMARY KEY (epoch, snapshot_type)
);
```

### Key Data Files

1. **live-monitor.db**
   - 578 rounds with complete results
   - ALL rounds have T-20s snapshot data
   - Use for strategy testing with crowd data

2. **prediction-data-btc.db**
   - 50K+ historical rounds
   - NO T-20s snapshots
   - Use for EMA-only backtesting

3. **CSV Exports**
   - `live-monitor-data.csv` - Exported live monitor data
   - `paper-trade-results.csv` - Paper trading results
   - Various analysis outputs

---

## 🧭 Common Navigation Patterns

### Pattern 1: Finding Strategy Test Scripts
```bash
# CORRECT
ls analysis-scripts/test-*.mjs
ls analysis-scripts/paper-trade-*.mjs

# WRONG
ls test-*.mjs  # Won't find anything in root
```

### Pattern 2: Reading Database Files
```javascript
// In analysis-scripts/*.mjs
import { readFileSync } from 'fs';
import initSqlJs from 'sql.js';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/live-monitor.db');  // ✅ CORRECT
const db = new SQL.Database(buffer);

// NOT: './live-monitor.db' ❌ WRONG (old path)
```

### Pattern 3: Writing Output Files
```javascript
// In analysis-scripts/*.mjs
import { writeFileSync } from 'fs';

writeFileSync('../data/results.csv', csvData);  // ✅ CORRECT

// NOT: './results.csv' ❌ WRONG (would write to analysis-scripts/)
```

### Pattern 4: Source Code Database Paths
```typescript
// In src/*.ts
const dbPath = process.env.DB_PATH || './data/prediction-data.db';  // ✅ CORRECT
```

---

## 🔍 Method: Finding Files Quickly

### Use Glob Patterns
```bash
# Find all test scripts
ls analysis-scripts/test-*.mjs

# Find all databases
ls data/*.db

# Find strategy-related scripts
ls analysis-scripts/*strategy*.mjs
ls analysis-scripts/*ema*.mjs

# Find paper trading scripts
ls analysis-scripts/paper-trade-*.mjs
```

### Use grep for Content Search
```bash
# Find scripts that use live-monitor.db
grep -r "live-monitor.db" analysis-scripts/

# Find where EMA gap is tested
grep -r "emaGap" analysis-scripts/

# Find paper trading simulations
grep -r "paper.*trade" analysis-scripts/
```

---

## 📊 Data Flow Understanding

### Live Monitoring Flow
```
1. User runs: npm start live
2. src/pipeline/live.ts monitors blockchain
3. Captures T-20s snapshots → data/live-monitor.db
4. Saves finalized rounds → data/live-monitor.db
```

### Analysis Flow
```
1. User runs: node analysis-scripts/test-t20-strategy-final.mjs
2. Script reads: ../data/live-monitor.db
3. Queries rounds + snapshots (T-20s data)
4. Runs strategy simulation
5. Outputs results to console
6. Optionally writes: ../data/results.csv
```

### Backfill Flow
```
1. User runs: npm start backfill --from X --to Y
2. src/pipeline/historical.ts fetches blockchain data
3. Saves rounds → data/prediction-data.db (or custom DB_PATH)
```

---

## ⚠️ Common Pitfalls to Avoid

### ❌ WRONG: Looking for databases in root
```bash
ls *.db  # Won't find anything!
```
### ✅ CORRECT
```bash
ls data/*.db
```

---

### ❌ WRONG: Looking for test scripts in root
```bash
node test-t20-strategy-final.mjs  # File not found!
```
### ✅ CORRECT
```bash
node analysis-scripts/test-t20-strategy-final.mjs
```

---

### ❌ WRONG: Running scripts from analysis-scripts/
```bash
cd analysis-scripts
node test-t20-strategy-final.mjs  # Paths will break!
```
### ✅ CORRECT
```bash
# Stay in root
node analysis-scripts/test-t20-strategy-final.mjs
```

---

### ❌ WRONG: Hardcoded old paths in new scripts
```javascript
readFileSync('./live-monitor.db')  // OLD PATH - WRONG
```
### ✅ CORRECT
```javascript
// In analysis-scripts/*.mjs
readFileSync('../data/live-monitor.db')

// In src/*.ts
readFileSync('./data/live-monitor.db')
```

---

## 🎓 Strategy Context

### Current Proven Strategy
- **EMA 5/13 crossover** using TradingView/Pyth 5-minute BNB/USD candles
- **65-70% crowd threshold** at T-20s snapshot
- **0.10% minimum EMA gap** for signal strength
- **Results**: 58.9% win rate, +78.83% ROI on 73 trades
- **Best hours**: 16:00-20:00 UTC, 00:00-04:00 UTC
- **Avoid**: 12:00-16:00 UTC (worst performance)

### Key Finding
- **Whales/crowd alone have NO edge** (50-54% win rate)
- **Edge comes from EMA trend analysis**, not following big bets

### Main Strategy Script
- **File**: `analysis-scripts/test-t20-strategy-final.mjs`
- **Database**: `data/live-monitor.db` (578 rounds with T-20s)
- **Key filters**:
  - Crowd threshold (65-80%)
  - EMA gap (0.10-0.15%)
  - EMA 5/13 direction confirmation

---

## 📝 Quick Reference Card

| What You Need | Where to Look |
|---------------|---------------|
| Main database with T-20s | `data/live-monitor.db` |
| Historical data (50K rounds) | `data/prediction-data-btc.db` |
| Strategy test script | `analysis-scripts/test-t20-strategy-final.mjs` |
| Paper trading results | `data/paper-trade-results.csv` |
| Database schema | `data/DATABASE-README.md` |
| Strategy findings | `data/STRATEGY-FINDINGS-UPDATED.md` |
| Source code config | `src/config.ts` |
| Database operations | `src/store/sqlite.ts` |
| Live monitoring | `src/pipeline/live.ts` |
| All test scripts | `analysis-scripts/` |
| All data files | `data/` |

---

## 🚀 Action Checklist Before Starting Work

- [ ] Check if working with **databases** → Look in `data/`
- [ ] Check if working with **analysis scripts** → Look in `analysis-scripts/`
- [ ] Check if working with **source code** → Look in `src/`
- [ ] Verify file paths use **correct relative paths** (`../data/` from scripts)
- [ ] Run scripts from **project root**, not from subdirectories
- [ ] Check if database has **T-20s snapshots** (only `live-monitor.db` has them)
- [ ] Use `live-monitor.db` for **strategy testing** (578 rounds, complete T-20s data)
- [ ] Use `prediction-data-btc.db` for **EMA-only backtesting** (50K+ rounds, no T-20s)

---

## 🎯 Example Workflow

**User asks**: "Run the main strategy test and analyze results"

**AI should**:
1. ✅ Navigate to: `analysis-scripts/test-t20-strategy-final.mjs`
2. ✅ Verify it reads from: `../data/live-monitor.db`
3. ✅ Run from root: `node analysis-scripts/test-t20-strategy-final.mjs`
4. ✅ Check results in console output
5. ✅ If saving CSV, it goes to: `../data/*.csv`

**AI should NOT**:
1. ❌ Look for script in root directory
2. ❌ Look for database in root directory
3. ❌ cd into analysis-scripts before running
4. ❌ Use old paths like `./live-monitor.db`

---

## 📌 Remember

> **When in doubt:**
> - Databases are in `data/`
> - Scripts are in `analysis-scripts/`
> - Source code is in `src/`
> - Always run from project root
> - Always use relative paths correctly

**This structure is MANDATORY and must be followed in all operations.**
