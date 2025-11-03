#!/bin/bash
# Sync project files from Windows to Raspberry Pi 5
# Run this from Git Bash on your Windows machine

# Configuration - EDIT THESE
PI_USER="pi"
PI_HOST="raspberrypi.local"  # or use IP like "192.168.1.100"
PI_DIR="~/prediction-monitor"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}Syncing project to Raspberry Pi 5...${NC}"
echo "Target: $PI_USER@$PI_HOST:$PI_DIR"
echo ""

# Test connection
echo -e "${BLUE}Testing SSH connection...${NC}"
if ssh -o ConnectTimeout=5 "$PI_USER@$PI_HOST" "echo 'Connected'" 2>/dev/null; then
  echo -e "${GREEN}✓ Connection successful${NC}"
else
  echo -e "${RED}✗ Cannot connect to Pi. Check:${NC}"
  echo "  1. Pi is powered on and connected to network"
  echo "  2. SSH is enabled on Pi"
  echo "  3. Hostname/IP is correct: $PI_HOST"
  echo "  4. Username is correct: $PI_USER"
  exit 1
fi

# Create directory on Pi
echo -e "${BLUE}Creating project directory on Pi...${NC}"
ssh "$PI_USER@$PI_HOST" "mkdir -p $PI_DIR/data $PI_DIR/logs $PI_DIR/backups"

# Sync files (excluding node_modules, data, and git files)
echo -e "${BLUE}Syncing files...${NC}"
rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'data/*.db' \
  --exclude 'backups' \
  --exclude '.git' \
  --exclude '*.log' \
  ./ "$PI_USER@$PI_HOST:$PI_DIR/"

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ Files synced successfully${NC}"
else
  echo -e "${RED}✗ Sync failed${NC}"
  exit 1
fi

# Build on Pi
echo -e "${BLUE}Building project on Pi...${NC}"
ssh "$PI_USER@$PI_HOST" "cd $PI_DIR && npm install && npm run build"

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ Build successful${NC}"
else
  echo -e "${RED}✗ Build failed${NC}"
  exit 1
fi

echo ""
echo -e "${GREEN}=========================================="
echo "✓ Deployment Complete!"
echo "==========================================${NC}"
echo ""
echo "To start the monitor, SSH into your Pi and run:"
echo "  ssh $PI_USER@$PI_HOST"
echo "  cd $PI_DIR"
echo "  pm2 start ecosystem.config.cjs"
echo "  pm2 save"
echo ""
echo "To view logs:"
echo "  pm2 logs prediction-monitor"
echo ""
