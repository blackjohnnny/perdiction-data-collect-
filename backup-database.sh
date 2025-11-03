#!/bin/bash
# Database Backup Script for Raspberry Pi
# Backs up the live monitoring database with rotation

# Configuration
PROJECT_DIR="$HOME/prediction-monitor"
DB_FILE="$PROJECT_DIR/data/live-monitor.db"
BACKUP_DIR="$PROJECT_DIR/backups"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/live-monitor-$DATE.db"

# Retention (days)
KEEP_DAYS=7

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Check if database exists
if [ ! -f "$DB_FILE" ]; then
  echo "Error: Database file not found at $DB_FILE"
  exit 1
fi

# Create backup
echo "Backing up database..."
cp "$DB_FILE" "$BACKUP_FILE"

# Check if backup was successful
if [ -f "$BACKUP_FILE" ]; then
  DB_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo "✓ Backup created: $BACKUP_FILE ($DB_SIZE)"
else
  echo "✗ Backup failed!"
  exit 1
fi

# Remove old backups
echo "Cleaning old backups (keeping last $KEEP_DAYS days)..."
find "$BACKUP_DIR" -name "live-monitor-*.db" -mtime +$KEEP_DAYS -delete

# Count remaining backups
BACKUP_COUNT=$(ls -1 "$BACKUP_DIR"/live-monitor-*.db 2>/dev/null | wc -l)
echo "✓ Total backups: $BACKUP_COUNT"

# Optional: Compress old backups (older than 1 day)
find "$BACKUP_DIR" -name "live-monitor-*.db" -mtime +1 ! -name "*.gz" -exec gzip {} \;

echo "Backup complete!"
