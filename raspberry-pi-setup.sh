#!/bin/bash
# Raspberry Pi 5 Setup Script for PancakeSwap Prediction Monitor
# Run this on your Raspberry Pi 5

set -e

echo "=========================================="
echo "Raspberry Pi 5 - Prediction Monitor Setup"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Update system
echo -e "${BLUE}[1/8] Updating system...${NC}"
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 (latest LTS)
echo -e "${BLUE}[2/8] Installing Node.js 20...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify Node.js
NODE_VERSION=$(node --version)
NPM_VERSION=$(npm --version)
echo -e "${GREEN}✓ Node.js $NODE_VERSION installed${NC}"
echo -e "${GREEN}✓ npm $NPM_VERSION installed${NC}"

# Install PM2 globally
echo -e "${BLUE}[3/8] Installing PM2 process manager...${NC}"
sudo npm install -g pm2
echo -e "${GREEN}✓ PM2 installed${NC}"

# Install git if not present
echo -e "${BLUE}[4/8] Installing git...${NC}"
sudo apt install -y git
echo -e "${GREEN}✓ Git installed${NC}"

# Create project directory
echo -e "${BLUE}[5/8] Setting up project directory...${NC}"
mkdir -p ~/prediction-monitor
mkdir -p ~/prediction-monitor/data
mkdir -p ~/prediction-monitor/backups
echo -e "${GREEN}✓ Directories created${NC}"

# Install dependencies
echo -e "${BLUE}[6/8] Installing project dependencies...${NC}"
cd ~/prediction-monitor
if [ -f "package.json" ]; then
  npm install
  echo -e "${GREEN}✓ Dependencies installed${NC}"
else
  echo "⚠ package.json not found. Please transfer your project files first."
fi

# Create .env file template
echo -e "${BLUE}[7/8] Creating .env configuration...${NC}"
if [ ! -f ".env" ]; then
  cat > .env << 'EOF'
# BSC RPC endpoint
BSC_RPC=https://bsc-dataseed.binance.org

# Database path
DB_PATH=./data/live-monitor.db

# Poll interval in milliseconds (1000 = 1 second)
POLL_INTERVAL_MS=1000

# Prediction contract address
PREDICTION_CONTRACT=0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA
EOF
  echo -e "${GREEN}✓ .env file created${NC}"
else
  echo -e "${GREEN}✓ .env already exists${NC}"
fi

# Setup PM2 startup
echo -e "${BLUE}[8/8] Setting up PM2 auto-startup...${NC}"
pm2 startup systemd -u $USER --hp $HOME | grep "sudo" | bash
echo -e "${GREEN}✓ PM2 startup configured${NC}"

echo ""
echo -e "${GREEN}=========================================="
echo "✓ Raspberry Pi 5 Setup Complete!"
echo "==========================================${NC}"
echo ""
echo "Next steps:"
echo "1. Transfer your project files to ~/prediction-monitor/"
echo "2. Run: cd ~/prediction-monitor && npm run build"
echo "3. Start monitor: pm2 start ecosystem.config.cjs"
echo "4. Save PM2 config: pm2 save"
echo "5. View logs: pm2 logs"
echo ""
