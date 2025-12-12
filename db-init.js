import Database from 'better-sqlite3';

/**
 * Initialize SQLite database for PancakeSwap prediction monitoring
 */
export function initDatabase(dbPath = './prediction.db') {
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');

  // Create main rounds table
  db.exec(`
    CREATE TABLE IF NOT EXISTS rounds (
      sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
      epoch INTEGER UNIQUE NOT NULL,
      lock_timestamp INTEGER NOT NULL,
      close_timestamp INTEGER NOT NULL,

      -- T-20s snapshot (20 seconds before lock)
      t20s_bull_wei TEXT,
      t20s_bear_wei TEXT,
      t20s_total_wei TEXT,
      t20s_timestamp INTEGER,

      -- T-8s snapshot (8 seconds before lock)
      t8s_bull_wei TEXT,
      t8s_bear_wei TEXT,
      t8s_total_wei TEXT,
      t8s_timestamp INTEGER,

      -- T-4s snapshot (4 seconds before lock)
      t4s_bull_wei TEXT,
      t4s_bear_wei TEXT,
      t4s_total_wei TEXT,
      t4s_timestamp INTEGER,

      -- Final amounts at lock
      lock_bull_wei TEXT,
      lock_bear_wei TEXT,
      lock_total_wei TEXT,

      -- Settlement data
      lock_price TEXT,
      close_price TEXT,
      winner TEXT, -- 'bull', 'bear', or 'draw'
      winner_payout_multiple REAL,

      -- Metadata
      is_complete BOOLEAN DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // Create index for faster epoch lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_epoch ON rounds(epoch);
    CREATE INDEX IF NOT EXISTS idx_complete ON rounds(is_complete);
    CREATE INDEX IF NOT EXISTS idx_lock_timestamp ON rounds(lock_timestamp);
  `);

  console.log('✅ Database initialized successfully');

  return db;
}

/**
 * Get current sample count
 */
export function getSampleCount(db) {
  const result = db.prepare('SELECT COUNT(*) as count FROM rounds').get();
  return result.count;
}

/**
 * Insert new round (from StartRound event)
 */
export function insertRound(db, epoch, lockTimestamp, closeTimestamp) {
  const stmt = db.prepare(`
    INSERT INTO rounds (epoch, lock_timestamp, close_timestamp)
    VALUES (?, ?, ?)
    ON CONFLICT(epoch) DO NOTHING
  `);

  try {
    const info = stmt.run(epoch.toString(), lockTimestamp, closeTimestamp);
    return info.changes > 0;
  } catch (err) {
    console.error(`Error inserting round ${epoch}:`, err.message);
    return false;
  }
}

/**
 * Update round with snapshot data
 */
export function updateSnapshot(db, epoch, snapshotType, bullWei, bearWei, timestamp) {
  const prefix = snapshotType; // 't20s', 't8s', 't4s'
  const totalWei = (BigInt(bullWei) + BigInt(bearWei)).toString();

  const stmt = db.prepare(`
    UPDATE rounds
    SET ${prefix}_bull_wei = ?,
        ${prefix}_bear_wei = ?,
        ${prefix}_total_wei = ?,
        ${prefix}_timestamp = ?,
        updated_at = strftime('%s', 'now')
    WHERE epoch = ?
  `);

  try {
    stmt.run(bullWei, bearWei, totalWei, timestamp, epoch.toString());
    return true;
  } catch (err) {
    console.error(`Error updating ${snapshotType} for epoch ${epoch}:`, err.message);
    return false;
  }
}

/**
 * Update round with lock data
 */
export function updateLockData(db, epoch, bullWei, bearWei, lockPrice) {
  const totalWei = (BigInt(bullWei) + BigInt(bearWei)).toString();

  const stmt = db.prepare(`
    UPDATE rounds
    SET lock_bull_wei = ?,
        lock_bear_wei = ?,
        lock_total_wei = ?,
        lock_price = ?,
        updated_at = strftime('%s', 'now')
    WHERE epoch = ?
  `);

  try {
    stmt.run(bullWei, bearWei, totalWei, lockPrice, epoch.toString());
    return true;
  } catch (err) {
    console.error(`Error updating lock data for epoch ${epoch}:`, err.message);
    return false;
  }
}

/**
 * Update round with settlement data
 */
export function updateSettlement(db, epoch, closePrice, winner, payoutMultiple) {
  const stmt = db.prepare(`
    UPDATE rounds
    SET close_price = ?,
        winner = ?,
        winner_payout_multiple = ?,
        is_complete = 1,
        updated_at = strftime('%s', 'now')
    WHERE epoch = ?
  `);

  try {
    stmt.run(closePrice, winner, payoutMultiple, epoch.toString());
    return true;
  } catch (err) {
    console.error(`Error updating settlement for epoch ${epoch}:`, err.message);
    return false;
  }
}

/**
 * Get incomplete rounds (for backfilling)
 */
export function getIncompleteRounds(db, limit = 100) {
  const stmt = db.prepare(`
    SELECT * FROM rounds
    WHERE is_complete = 0
    ORDER BY epoch DESC
    LIMIT ?
  `);

  return stmt.all(limit);
}

/**
 * Get complete rounds for backtesting
 */
export function getCompleteRounds(db, limit = null) {
  let sql = `
    SELECT * FROM rounds
    WHERE is_complete = 1
    AND t20s_bull_wei IS NOT NULL
    ORDER BY epoch ASC
  `;

  if (limit) {
    sql += ` LIMIT ${limit}`;
  }

  const stmt = db.prepare(sql);
  return stmt.all();
}

export default {
  initDatabase,
  getSampleCount,
  insertRound,
  updateSnapshot,
  updateLockData,
  updateSettlement,
  getIncompleteRounds,
  getCompleteRounds
};
