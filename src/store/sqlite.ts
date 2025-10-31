import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { config } from '../config.js';
import type { RoundData, Winner } from '../contract.js';
import { determineWinner, calculateWinnerMultiple } from '../contract.js';

export type RoundRow = {
  epoch: number;
  start_ts: number;
  lock_ts: number;
  close_ts: number;
  lock_price: string;
  close_price: string;
  total_amount_wei: string;
  bull_amount_wei: string;
  bear_amount_wei: string;
  oracle_called: number;
  reward_base_cal_wei: string;
  reward_amount_wei: string;
  winner: Winner;
  winner_multiple: number | null;
  inserted_at: number;
  updated_at: number;
};

export type SnapshotRow = {
  epoch: number;
  snapshot_type: 'T_MINUS_20S' | 'T_MINUS_8S' | 'T_MINUS_4S';
  taken_at: number;
  total_amount_wei: string;
  bull_amount_wei: string;
  bear_amount_wei: string;
  implied_up_multiple: number | null;
  implied_down_multiple: number | null;
};

let db: SqlJsDatabase | null = null;
let SQL: any = null;

export async function getDb(): Promise<SqlJsDatabase> {
  if (!db) {
    if (!SQL) {
      SQL = await initSqlJs();
    }

    // Load existing database or create new one
    if (existsSync(config.dbPath)) {
      const buffer = readFileSync(config.dbPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    initSchema();
  }
  return db!;
}

export function saveDb(): void {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    writeFileSync(config.dbPath, buffer);
  }
}

export function closeDb(): void {
  if (db) {
    saveDb();
    db.close();
    db = null;
  }
}

function initSchema(): void {
  if (!db) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS rounds (
      epoch INTEGER PRIMARY KEY,
      start_ts INTEGER NOT NULL,
      lock_ts INTEGER NOT NULL,
      close_ts INTEGER NOT NULL,
      lock_price TEXT NOT NULL,
      close_price TEXT NOT NULL,
      total_amount_wei TEXT NOT NULL,
      bull_amount_wei TEXT NOT NULL,
      bear_amount_wei TEXT NOT NULL,
      oracle_called INTEGER NOT NULL,
      reward_base_cal_wei TEXT NOT NULL,
      reward_amount_wei TEXT NOT NULL,
      winner TEXT NOT NULL CHECK(winner IN ('UP','DOWN','DRAW','UNKNOWN')),
      winner_multiple REAL,
      t20s_total_wei TEXT,
      t20s_bull_wei TEXT,
      t20s_bear_wei TEXT,
      t20s_implied_up_multiple REAL,
      t20s_implied_down_multiple REAL,
      t20s_taken_at INTEGER,
      t8s_total_wei TEXT,
      t8s_bull_wei TEXT,
      t8s_bear_wei TEXT,
      t8s_implied_up_multiple REAL,
      t8s_implied_down_multiple REAL,
      t8s_taken_at INTEGER,
      t4s_total_wei TEXT,
      t4s_bull_wei TEXT,
      t4s_bear_wei TEXT,
      t4s_implied_up_multiple REAL,
      t4s_implied_down_multiple REAL,
      t4s_taken_at INTEGER,
      inserted_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rounds_winner ON rounds(winner);
    CREATE INDEX IF NOT EXISTS idx_rounds_lock_ts ON rounds(lock_ts);
  `);
}

export async function upsertRound(round: RoundData): Promise<void> {
  const database = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const winner = determineWinner(round);
  const winnerMultiple = calculateWinnerMultiple(round);

  database.run(`
    INSERT INTO rounds (
      epoch, start_ts, lock_ts, close_ts,
      lock_price, close_price,
      total_amount_wei, bull_amount_wei, bear_amount_wei,
      oracle_called, reward_base_cal_wei, reward_amount_wei,
      winner, winner_multiple,
      inserted_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(epoch) DO UPDATE SET
      start_ts = excluded.start_ts,
      lock_ts = excluded.lock_ts,
      close_ts = excluded.close_ts,
      lock_price = excluded.lock_price,
      close_price = excluded.close_price,
      total_amount_wei = excluded.total_amount_wei,
      bull_amount_wei = excluded.bull_amount_wei,
      bear_amount_wei = excluded.bear_amount_wei,
      oracle_called = excluded.oracle_called,
      reward_base_cal_wei = excluded.reward_base_cal_wei,
      reward_amount_wei = excluded.reward_amount_wei,
      winner = excluded.winner,
      winner_multiple = excluded.winner_multiple,
      updated_at = excluded.updated_at
  `, [
    Number(round.epoch),
    Number(round.startTimestamp),
    Number(round.lockTimestamp),
    Number(round.closeTimestamp),
    round.lockPrice.toString(),
    round.closePrice.toString(),
    round.totalAmount.toString(),
    round.bullAmount.toString(),
    round.bearAmount.toString(),
    round.oracleCalled ? 1 : 0,
    round.rewardBaseCalAmount.toString(),
    round.rewardAmount.toString(),
    winner,
    winnerMultiple,
    now,
    now
  ]);

  // Auto-save periodically
  saveDb();
}

export async function upsertSnapshot(
  epoch: bigint,
  totalAmount: bigint,
  bullAmount: bigint,
  bearAmount: bigint,
  impliedUpMultiple: number | null,
  impliedDownMultiple: number | null,
  snapshotType: 'T_MINUS_20S' | 'T_MINUS_8S' | 'T_MINUS_4S' = 'T_MINUS_8S'
): Promise<void> {
  const database = await getDb();
  const now = Math.floor(Date.now() / 1000);

  // Map snapshot type to column prefix
  const prefix = snapshotType === 'T_MINUS_20S' ? 't20s' :
                 snapshotType === 'T_MINUS_8S' ? 't8s' : 't4s';

  database.run(`
    UPDATE rounds SET
      ${prefix}_total_wei = ?,
      ${prefix}_bull_wei = ?,
      ${prefix}_bear_wei = ?,
      ${prefix}_implied_up_multiple = ?,
      ${prefix}_implied_down_multiple = ?,
      ${prefix}_taken_at = ?,
      updated_at = ?
    WHERE epoch = ?
  `, [
    totalAmount.toString(),
    bullAmount.toString(),
    bearAmount.toString(),
    impliedUpMultiple,
    impliedDownMultiple,
    now,
    now,
    Number(epoch)
  ]);

  saveDb();
}

export async function hasSnapshot(epoch: bigint, type: 'T_MINUS_20S' | 'T_MINUS_8S' | 'T_MINUS_4S' = 'T_MINUS_8S'): Promise<boolean> {
  const database = await getDb();
  const prefix = type === 'T_MINUS_20S' ? 't20s' :
                 type === 'T_MINUS_8S' ? 't8s' : 't4s';

  const result = database.exec(`
    SELECT 1 FROM rounds WHERE epoch = ? AND ${prefix}_total_wei IS NOT NULL LIMIT 1
  `, [Number(epoch)]);

  return result.length > 0 && result[0].values.length > 0;
}

export async function getRoundByEpoch(epoch: number): Promise<RoundRow | undefined> {
  const database = await getDb();
  const result = database.exec(`SELECT * FROM rounds WHERE epoch = ?`, [epoch]);

  if (result.length === 0 || result[0].values.length === 0) {
    return undefined;
  }

  const columns = result[0].columns;
  const values = result[0].values[0];
  const row: any = {};

  columns.forEach((col, idx) => {
    row[col] = values[idx];
  });

  return row as RoundRow;
}

export async function getAllRounds(): Promise<RoundRow[]> {
  const database = await getDb();
  const result = database.exec(`SELECT * FROM rounds ORDER BY epoch ASC`);

  if (result.length === 0) {
    return [];
  }

  const columns = result[0].columns;
  return result[0].values.map(values => {
    const row: any = {};
    columns.forEach((col, idx) => {
      row[col] = values[idx];
    });
    return row as RoundRow;
  });
}

export async function getAllSnapshots(): Promise<SnapshotRow[]> {
  const database = await getDb();
  const result = database.exec(`SELECT * FROM snapshots ORDER BY epoch ASC`);

  if (result.length === 0) {
    return [];
  }

  const columns = result[0].columns;
  return result[0].values.map(values => {
    const row: any = {};
    columns.forEach((col, idx) => {
      row[col] = values[idx];
    });
    return row as SnapshotRow;
  });
}

export async function getStats(): Promise<{
  totalRounds: number;
  totalSnapshots: number;
  upWins: number;
  downWins: number;
  draws: number;
  unknown: number;
}> {
  const database = await getDb();

  const totalRounds = database.exec(`SELECT COUNT(*) as count FROM rounds`)[0]?.values[0]?.[0] as number || 0;
  const totalSnapshots = database.exec(`SELECT COUNT(*) as count FROM snapshots`)[0]?.values[0]?.[0] as number || 0;

  const upWins = database.exec(`SELECT COUNT(*) as count FROM rounds WHERE winner = 'UP'`)[0]?.values[0]?.[0] as number || 0;
  const downWins = database.exec(`SELECT COUNT(*) as count FROM rounds WHERE winner = 'DOWN'`)[0]?.values[0]?.[0] as number || 0;
  const draws = database.exec(`SELECT COUNT(*) as count FROM rounds WHERE winner = 'DRAW'`)[0]?.values[0]?.[0] as number || 0;
  const unknown = database.exec(`SELECT COUNT(*) as count FROM rounds WHERE winner = 'UNKNOWN'`)[0]?.values[0]?.[0] as number || 0;

  return {
    totalRounds,
    totalSnapshots,
    upWins,
    downWins,
    draws,
    unknown,
  };
}
