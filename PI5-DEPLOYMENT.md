# Raspberry Pi 5 Deployment Guide

Complete guide to deploy your PancakeSwap Prediction Monitor on Raspberry Pi 5.

## Prerequisites

- Raspberry Pi 5 (any RAM size, 4GB+ recommended)
- MicroSD card with Raspberry Pi OS installed
- Network connection (WiFi or Ethernet)
- SSH enabled on your Pi

## Quick Start

### Option 1: Automated Deployment (Recommended)

**From your Windows machine (Git Bash or WSL):**

```bash
# 1. Make sync script executable
chmod +x sync-to-pi.sh

# 2. Edit the script to set your Pi's IP/hostname
nano sync-to-pi.sh
# Change PI_HOST to your Pi's IP (e.g., "192.168.1.100")

# 3. Run sync script
./sync-to-pi.sh
```

**On your Raspberry Pi:**

```bash
# 1. Setup the Pi environment
cd ~/prediction-monitor
chmod +x raspberry-pi-setup.sh
./raspberry-pi-setup.sh

# 2. Start the monitor
pm2 start ecosystem.config.cjs

# 3. Save PM2 config (auto-start on boot)
pm2 save

# 4. View logs
pm2 logs prediction-monitor
```

### Option 2: Manual Setup

**Step 1: Prepare Your Pi**

```bash
# SSH into your Pi
ssh pi@raspberrypi.local

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2
sudo npm install -g pm2

# Create project directory
mkdir -p ~/prediction-monitor
cd ~/prediction-monitor
```

**Step 2: Transfer Files**

From Windows PowerShell:
```powershell
scp -r "c:\Users\Micha\fuzzy-cake\perdiction-data-collect-\*" pi@raspberrypi.local:~/prediction-monitor/
```

**Step 3: Build & Start**

On Raspberry Pi:
```bash
cd ~/prediction-monitor
npm install
npm run build

# Start with PM2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## Configuration

### Environment Variables (.env)

```env
BSC_RPC=https://bsc-dataseed.binance.org
DB_PATH=./data/live-monitor.db
POLL_INTERVAL_MS=1000
PREDICTION_CONTRACT=0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA
```

### PM2 Ecosystem Config

The `ecosystem.config.cjs` file controls:
- Auto-restart on crash
- Memory limit (500MB)
- Daily restart at 3 AM (optional)
- Log rotation

Edit if needed:
```bash
nano ecosystem.config.cjs
```

## Database Backups

### Automatic Daily Backups

```bash
# Make backup script executable
chmod +x backup-database.sh

# Test it
./backup-database.sh

# Schedule daily at 2 AM
crontab -e
```

Add line:
```
0 2 * * * /home/pi/prediction-monitor/backup-database.sh >> /home/pi/prediction-monitor/logs/backup.log 2>&1
```

### Manual Backup

```bash
# Create backup
cp data/live-monitor.db backups/backup-$(date +%Y%m%d).db

# Download to Windows
scp pi@raspberrypi.local:~/prediction-monitor/data/live-monitor.db ./data/
```

## Monitoring & Maintenance

### PM2 Commands

```bash
# View status
pm2 status

# View logs (live tail)
pm2 logs prediction-monitor

# View last 100 lines
pm2 logs prediction-monitor --lines 100

# Restart
pm2 restart prediction-monitor

# Stop
pm2 stop prediction-monitor

# View resource usage
pm2 monit
```

### System Monitoring

```bash
# Check CPU/RAM usage
htop

# Check disk space
df -h

# Check temperature (Pi 5 specific)
vcgencmd measure_temp
```

### Log Files

Logs are stored in `~/prediction-monitor/logs/`:
- `output.log` - Standard output
- `error.log` - Error messages
- `backup.log` - Backup script output

```bash
# View recent logs
tail -f logs/output.log

# Search for errors
grep -i error logs/error.log
```

## Remote Access

### SSH Tunnel for Database Access

From Windows, create secure tunnel:
```bash
ssh -L 5000:localhost:5000 pi@raspberrypi.local
```

### Download Database for Analysis

```bash
# From Windows (PowerShell)
scp pi@raspberrypi.local:~/prediction-monitor/data/live-monitor.db ./data/live-monitor-remote.db

# Then analyze locally
node test-strategy.mjs
```

### Remote Code Updates

```bash
# From Windows, run sync script
./sync-to-pi.sh

# Or manually
rsync -avz --exclude 'node_modules' --exclude 'data' ./ pi@raspberrypi.local:~/prediction-monitor/

# Then on Pi
ssh pi@raspberrypi.local
cd ~/prediction-monitor
npm run build
pm2 restart prediction-monitor
```

## Performance Tuning

### Raspberry Pi 5 Optimizations

**Increase swap (if needed):**
```bash
sudo dphys-swapfile swapoff
sudo nano /etc/dphys-swapfile
# Change CONF_SWAPSIZE=2048
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

**Monitor network quality:**
```bash
# Ping BSC RPC
ping bsc-dataseed.binance.org

# Check if RPC is responsive
curl -X POST https://bsc-dataseed.binance.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

## Troubleshooting

### Monitor Not Starting

```bash
# Check PM2 logs
pm2 logs prediction-monitor --err

# Try manual start
cd ~/prediction-monitor
npm start live

# Check if port is blocked
sudo netstat -tlnp | grep node
```

### Database Locked

```bash
# Check if multiple processes are accessing DB
ps aux | grep node

# Kill old processes
pm2 delete all
pm2 start ecosystem.config.cjs
```

### Connection Issues

```bash
# Test BSC RPC
curl https://bsc-dataseed.binance.org

# Try alternate RPC
# Edit .env and change BSC_RPC to:
# BSC_RPC=https://bsc-dataseed1.binance.org
# or
# BSC_RPC=https://bsc-dataseed2.binance.org
```

### Out of Memory

```bash
# Check memory
free -h

# Reduce PM2 memory limit in ecosystem.config.cjs
# Change: max_memory_restart: '300M'

pm2 restart prediction-monitor
```

## Security

### Basic Security Setup

```bash
# Change default password
passwd

# Update SSH config (disable password auth, use keys only)
sudo nano /etc/ssh/sshd_config
# Set: PasswordAuthentication no
sudo systemctl restart ssh

# Setup firewall
sudo apt install ufw
sudo ufw allow ssh
sudo ufw enable
```

### Database Security

```bash
# Set proper permissions
chmod 600 data/live-monitor.db
chmod 700 data/

# Never commit .env to git
echo ".env" >> .gitignore
```

## Expected Performance

**Raspberry Pi 5:**
- CPU Usage: 5-15%
- RAM Usage: 100-200MB
- Disk I/O: Minimal (writes every snapshot)
- Power: ~5-8W
- Temperature: 40-55°C (with passive cooling)

**Network:**
- Bandwidth: <1MB/hour
- Latency: <100ms to BSC RPC (important for snapshot timing)

## Cost Analysis

**Hardware:** ~$80-120 (Pi 5 + accessories)
**Electricity:** ~$5/year (8W × 24/7)
**Total:** One-time setup, minimal ongoing cost

**vs Cloud (VPS):**
- Raspberry Pi: $5/year
- VPS: $60-120/year ($5-10/month)

Pi wins after 1-2 months! 🎉

## Next Steps

Once monitoring is stable:
1. Let it collect 1-2 weeks of data
2. Download database periodically
3. Run strategy analysis locally
4. Consider building automated trading bot (⚠️ paper trade first!)

---

**Questions?** Check logs with `pm2 logs` or open an issue on GitHub.
