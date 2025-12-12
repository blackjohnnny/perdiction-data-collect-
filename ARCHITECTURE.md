# System Architecture

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    PancakeSwap Prediction                   │
│                    Smart Contract (BSC)                      │
│                 0x18B2A6...582A49cdA                         │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      │ WebSocket Events
                      │ (StartRound, LockRound, EndRound)
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                      monitor.js                              │
│                   (24/7 Monitoring)                          │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  1. Detect StartRound                                 │  │
│  │  2. Schedule T-20s, T-8s, T-4s snapshots             │  │
│  │  3. Capture pool data at each interval               │  │
│  │  4. Store lock price on LockRound                    │  │
│  │  5. Store close price + winner on EndRound           │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      │ Write Data
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  prediction.db (SQLite)                      │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │ sample_id | epoch | timestamps | snapshots | ...  │    │
│  ├────────────────────────────────────────────────────┤    │
│  │     1     | 54321 |  T-20s, T-8s, T-4s  | winner  │    │
│  │     2     | 54322 |  T-20s, T-8s, T-4s  | winner  │    │
│  │     3     | 54323 |  T-20s, T-8s, T-4s  | winner  │    │
│  │    ...    |  ...  |        ...          |   ...   │    │
│  └────────────────────────────────────────────────────┘    │
└───────┬──────────────────────────────────────────┬──────────┘
        │                                          │
        │ Read Data                                │ Fill Gaps
        │                                          │
        ▼                                          ▼
┌──────────────────┐                    ┌──────────────────────┐
│   db-stats.js    │                    │    backfill.js       │
│  (View Stats)    │                    │ (Historical Data)    │
└──────────────────┘                    └──────────────────────┘
```

---

## Component Breakdown

### 1. Monitor (`monitor.js`)

**Purpose**: Real-time 24/7 monitoring of prediction rounds

**Process Flow**:
```
StartRound Event
   ↓
Create DB record (sample_id auto-increments)
   ↓
Schedule 3 timers (T-20s, T-8s, T-4s)
   ↓
Timer fires → Query contract → Store snapshot
   ↓
LockRound Event → Store final pools + lock price
   ↓
EndRound Event → Store close price + winner
   ↓
Round Complete ✅
```

**Key Features**:
- WebSocket connection (auto-reconnect)
- Precise timing for snapshots
- Concurrent round handling
- Graceful shutdown

---

### 2. Database (`db-init.js`)

**Purpose**: SQLite database with optimized schema

**Schema**:
```sql
CREATE TABLE rounds (
  sample_id INTEGER PRIMARY KEY AUTOINCREMENT,  -- 1, 2, 3...
  epoch INTEGER UNIQUE NOT NULL,                 -- Contract epoch

  lock_timestamp INTEGER NOT NULL,
  close_timestamp INTEGER NOT NULL,

  -- Snapshots
  t20s_bull_wei TEXT, t20s_bear_wei TEXT, t20s_timestamp INTEGER,
  t8s_bull_wei TEXT, t8s_bear_wei TEXT, t8s_timestamp INTEGER,
  t4s_bull_wei TEXT, t4s_bear_wei TEXT, t4s_timestamp INTEGER,

  -- Lock data
  lock_bull_wei TEXT, lock_bear_wei TEXT, lock_price TEXT,

  -- Settlement
  close_price TEXT, winner TEXT, winner_payout_multiple REAL,

  -- Metadata
  is_complete BOOLEAN DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);
```

**Indexes**:
- `idx_epoch` - Fast epoch lookups
- `idx_complete` - Filter complete rounds
- `idx_lock_timestamp` - Time-based queries

---

### 3. Backfill (`backfill.js`)

**Purpose**: Fill historical or incomplete rounds

**Modes**:
```bash
# Fill incomplete rounds in DB
node backfill.js incomplete

# Backfill last N rounds
node backfill.js last 1000

# Backfill specific range
node backfill.js range 54000 55000
```

**Limitations**:
- Cannot capture T-20s/T-8s/T-4s snapshots (past data)
- Can fill: lock_price, close_price, winner, payout
- Rate-limited to avoid RPC throttling

---

### 4. Contract Interface (`contract-abi.js`)

**Purpose**: Smart contract interaction layer

**Key Functions**:
```javascript
// Events
StartRound(epoch)
LockRound(epoch, roundId, price)
EndRound(epoch, roundId, price)

// Read Functions
currentEpoch() → uint256
rounds(epoch) → RoundData
```

**Helpers**:
- `parseRoundData()` - Convert contract response
- `calculateWinner()` - Determine winner + payout

---

### 5. Statistics (`db-stats.js`)

**Purpose**: View database metrics

**Output**:
- Total samples collected
- Complete vs incomplete rounds
- Rounds with T-20s data
- Recent 5 rounds (details)
- Win distribution (bull/bear/draw)
- Average payout multiple

---

### 6. Connection Test (`test-connection.js`)

**Purpose**: Verify system setup

**Tests**:
1. HTTP RPC connection
2. WebSocket connection
3. Contract interface
4. Current epoch fetch
5. Latest round data

---

## Data Capture Timeline

```
5-Minute Round Timeline:

T=0s          T=20s before lock   T=8s    T=4s      T=300s (Lock)    T=600s (Close)
│             │                   │       │         │                │
│ StartRound  │ Snapshot 1        │ Snap2 │ Snap3   │ LockRound      │ EndRound
│ Detected    │ (T-20s)           │ (T-8s)│ (T-4s)  │ (Final Pools)  │ (Winner)
│             │                   │       │         │                │
│             │ Crowd: 60%/40%    │ ...   │ ...     │ Crowd: 65%/35% │ BNB Up/Down
│             │ Total: 10 BNB     │ ...   │ ...     │ Total: 15 BNB  │ Payout: 1.95x
│             │                   │       │         │                │
▼             ▼                   ▼       ▼         ▼                ▼
Insert DB     Update DB           Update  Update    Update DB        Update DB
sample_id++   t20s_*              t8s_*   t4s_*     lock_*           close_*, winner
```

---

## Network Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Binance Smart Chain                        │
│                         (BSC)                                 │
└───────────┬──────────────────────────────────────┬───────────┘
            │                                      │
            │ WebSocket                            │ HTTP
            │ wss://bsc-ws-node.nariox.org        │ https://bsc-dataseed1.binance.org
            │                                      │
            │                                      │
┌───────────▼──────────┐              ┌───────────▼──────────┐
│   monitor.js         │              │   backfill.js        │
│   (Live Events)      │              │   (Historical)       │
└──────────────────────┘              └──────────────────────┘
```

---

## File Dependencies

```
monitor.js
  ├── ethers (WebSocketProvider)
  ├── db-init.js (database operations)
  └── contract-abi.js (contract interface)

backfill.js
  ├── ethers (JsonRpcProvider)
  ├── db-init.js (database operations)
  └── contract-abi.js (contract interface)

db-init.js
  └── better-sqlite3 (SQLite driver)

db-stats.js
  ├── db-init.js
  └── ethers (formatting)

test-connection.js
  ├── ethers
  └── contract-abi.js
```

---

## Future Architecture (Trading Bot)

```
┌─────────────────────────────────────────────────────────────┐
│                   TradingView API                            │
│               (BNB/USD 5-min candles)                        │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      │ Fetch Candles
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  strategy-engine.js                          │
│                                                              │
│  1. Calculate EMA 3/7                                        │
│  2. Check gap ≥0.05%                                         │
│  3. Get T-20s crowd data from monitor                        │
│  4. Check if crowd ≥65% opposite                             │
│  5. Generate signal: BULL / BEAR / NONE                      │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      │ Trade Signal
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   trading-bot.js                             │
│                                                              │
│  1. Calculate position size (6.5% bankroll)                 │
│  2. Estimate gas fees                                        │
│  3. Sign transaction (Web3 wallet)                           │
│  4. Execute bet on PancakeSwap                               │
│  5. Log trade                                                │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      │ Write Trade
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    trades.db                                 │
│        (Trade history, P&L tracking)                         │
└─────────────────────────────────────────────────────────────┘
```

---

## Deployment Architecture

### Option 1: Raspberry Pi 5 (Recommended)
```
┌──────────────────────────────────────┐
│       Raspberry Pi 5 (24/7)          │
│                                      │
│  PM2 Process Manager                 │
│    ├── monitor.js (always running)   │
│    └── Auto-restart on crash         │
│                                      │
│  Local Storage                       │
│    └── prediction.db (SQLite)        │
│                                      │
│  Cron Jobs (optional)                │
│    └── Daily backfill                │
└──────────────────────────────────────┘
```

### Option 2: VPS (Cloud)
```
┌──────────────────────────────────────┐
│    Ubuntu VPS (DigitalOcean/AWS)     │
│                                      │
│  PM2 + Systemd                       │
│    ├── monitor.js                    │
│    └── Auto-restart + boot startup   │
│                                      │
│  Remote Access                       │
│    ├── SSH                           │
│    └── PM2 Web Dashboard             │
└──────────────────────────────────────┘
```

---

**Last Updated**: 2025-01-06
