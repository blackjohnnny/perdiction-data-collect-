# Setup Guide

## Step 1: Install Dependencies

```bash
npm install
```

This will install:
- `ethers` v6 - Blockchain interaction
- `better-sqlite3` - Fast SQLite database
- `node-fetch` - HTTP requests for TradingView API

---

## Step 2: Test Connection

Verify you can connect to BSC and the contract:

```bash
npm test
```

Expected output:
```
✅ HTTP Connected - Current block: 12345678
✅ Contract Connected - Current epoch: 54321
✅ WebSocket Connected - Current block: 12345679
🎉 System is ready to monitor!
```

---

## Step 3: Start Monitoring (24/7)

```bash
npm start
```

**What it does:**
- Connects to BSC via WebSocket
- Listens for new rounds (StartRound events)
- Schedules snapshots at T-20s, T-8s, T-4s before lock
- Captures lock and settlement data
- Stores everything in `prediction.db`

**Console output:**
```
🚀 Initializing PancakeSwap Prediction Monitor...
📊 Current database samples: 0
🔌 Connecting to BSC WebSocket...
✅ Connected to PancakeSwap Prediction V2
📈 Current epoch: 54321

🟢 StartRound Event - Epoch 54322
✅ Sample #1 - Epoch 54322
⏰ Scheduled t20s snapshot for epoch 54322 in 280s
⏰ Scheduled t8s snapshot for epoch 54322 in 292s
⏰ Scheduled t4s snapshot for epoch 54322 in 296s

📸 T20S Epoch 54322: Bull 62.34% | Bear 37.66% | Total 12.45 BNB
📸 T8S Epoch 54322: Bull 63.12% | Bear 36.88% | Total 13.21 BNB
📸 T4S Epoch 54322: Bull 64.01% | Bear 35.99% | Total 14.02 BNB

🔒 LockRound Event - Epoch 54322
   Lock Price: $598.23
   Final Pool: Bull 64.50% | Bear 35.50% | Total 14.5 BNB

🏁 EndRound Event - Epoch 54322
   Close Price: $599.45
   Winner: BULL 🎉
   Payout: 1.5493x
```

**Keep this running 24/7** on your Raspberry Pi or server!

---

## Step 4: Backfill Historical Data (Optional)

While monitor is running, open a new terminal and backfill past rounds:

### Fill incomplete rounds in database
```bash
npm run backfill
```

### Backfill last 500 rounds
```bash
node backfill.js last 500
```

### Backfill specific range
```bash
node backfill.js range 54000 54500
```

**Note**: Backfilled rounds won't have T-20s/T-8s/T-4s snapshots (only live monitoring captures those).

---

## Step 5: Check Database Stats

```bash
npm run stats
```

Output shows:
- Total samples collected
- Complete vs incomplete rounds
- Rounds with T-20s data
- Recent round details
- Win distribution (bull/bear/draw)
- Average payout multiples

---

## Deployment Tips

### Run on Raspberry Pi

1. Install Node.js 18+:
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

2. Clone project and install:
```bash
git clone <your-repo>
cd perdiction-data-collect-
npm install
```

3. Use PM2 for auto-restart:
```bash
npm install -g pm2
pm2 start monitor.js --name "pancake-monitor"
pm2 save
pm2 startup
```

4. Check logs:
```bash
pm2 logs pancake-monitor
```

### Run on VPS (Ubuntu/Debian)

Same as Raspberry Pi steps above.

### Run on Windows

1. Install Node.js 18+ from [nodejs.org](https://nodejs.org/)
2. Open PowerShell in project directory
3. Run `npm install` and `npm start`
4. Keep terminal open

---

## Troubleshooting

### "Cannot find module 'ethers'"
Run: `npm install`

### "WebSocket connection failed"
- Check internet connection
- Try alternate WSS endpoint in `monitor.js`:
  ```javascript
  const BSC_WSS_URL = 'wss://bsc.publicnode.com';
  ```

### "Database locked"
- Close all processes accessing the database
- Delete `.db-shm` and `.db-wal` files
- Restart monitor

### Missing snapshots
- Snapshots only work when monitor starts before StartRound event
- If you start mid-round, wait for next round
- Backfilled data won't have snapshots

---

## Next Steps

1. ✅ Let monitor run for **7+ days** minimum (collect 2000+ rounds)
2. ✅ Backfill historical data for larger dataset
3. Build backtesting script (analyze strategy performance)
4. Implement live trading bot (Web3 wallet integration)

---

**Questions?** Check [README.md](README.md) and [STRATEGY.md](STRATEGY.md)
