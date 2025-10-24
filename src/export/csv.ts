import { writeFile } from 'fs/promises';
import { getAllRounds, getAllSnapshots, type RoundRow, type SnapshotRow } from '../store/sqlite.js';

export type ExportTable = 'rounds' | 'snapshots';

function escapeCSV(value: any): string {
  if (value === null || value === undefined) {
    return '';
  }

  const str = String(value);

  // If contains comma, quote, or newline, wrap in quotes and escape quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

function rowToCSV(row: Record<string, any>): string {
  return Object.values(row).map(escapeCSV).join(',');
}

function headersToCSV(headers: string[]): string {
  return headers.map(escapeCSV).join(',');
}

export async function exportToCSV(table: ExportTable, outputPath: string): Promise<void> {
  console.log(`Exporting ${table} to ${outputPath}...`);

  let headers: string[];
  let rows: any[];

  if (table === 'rounds') {
    const roundRows = await getAllRounds();
    if (roundRows.length === 0) {
      console.log('No rounds to export');
      return;
    }

    headers = [
      'epoch',
      'start_ts',
      'lock_ts',
      'close_ts',
      'lock_price',
      'close_price',
      'total_amount_wei',
      'bull_amount_wei',
      'bear_amount_wei',
      'oracle_called',
      'reward_base_cal_wei',
      'reward_amount_wei',
      'winner',
      'winner_multiple',
      'inserted_at',
      'updated_at',
    ];
    rows = roundRows;
  } else {
    const snapshotRows = await getAllSnapshots();
    if (snapshotRows.length === 0) {
      console.log('No snapshots to export');
      return;
    }

    headers = [
      'epoch',
      'snapshot_type',
      'taken_at',
      'total_amount_wei',
      'bull_amount_wei',
      'bear_amount_wei',
      'implied_up_multiple',
      'implied_down_multiple',
    ];
    rows = snapshotRows;
  }

  // Build CSV content
  const lines: string[] = [];
  lines.push(headersToCSV(headers));

  for (const row of rows) {
    lines.push(rowToCSV(row));
  }

  const csvContent = lines.join('\n') + '\n';

  await writeFile(outputPath, csvContent, 'utf-8');
  console.log(`Exported ${rows.length} rows to ${outputPath}`);
}

export async function exportRoundsWithHumanReadable(outputPath: string): Promise<void> {
  console.log(`Exporting rounds with human-readable BNB values to ${outputPath}...`);

  const roundRows = await getAllRounds();
  if (roundRows.length === 0) {
    console.log('No rounds to export');
    return;
  }

  const headers = [
    'epoch',
    'start_ts',
    'lock_ts',
    'close_ts',
    'lock_price',
    'close_price',
    'total_amount_bnb',
    'bull_amount_bnb',
    'bear_amount_bnb',
    'oracle_called',
    'reward_base_cal_bnb',
    'reward_amount_bnb',
    'winner',
    'winner_multiple',
    'inserted_at',
    'updated_at',
  ];

  const lines: string[] = [];
  lines.push(headersToCSV(headers));

  for (const row of roundRows) {
    const humanRow = {
      epoch: row.epoch,
      start_ts: row.start_ts,
      lock_ts: row.lock_ts,
      close_ts: row.close_ts,
      lock_price: row.lock_price,
      close_price: row.close_price,
      total_amount_bnb: (Number(row.total_amount_wei) / 1e18).toFixed(6),
      bull_amount_bnb: (Number(row.bull_amount_wei) / 1e18).toFixed(6),
      bear_amount_bnb: (Number(row.bear_amount_wei) / 1e18).toFixed(6),
      oracle_called: row.oracle_called,
      reward_base_cal_bnb: (Number(row.reward_base_cal_wei) / 1e18).toFixed(6),
      reward_amount_bnb: (Number(row.reward_amount_wei) / 1e18).toFixed(6),
      winner: row.winner,
      winner_multiple: row.winner_multiple,
      inserted_at: row.inserted_at,
      updated_at: row.updated_at,
    };

    lines.push(rowToCSV(humanRow));
  }

  const csvContent = lines.join('\n') + '\n';

  await writeFile(outputPath, csvContent, 'utf-8');
  console.log(`Exported ${roundRows.length} rows to ${outputPath}`);
}

export async function exportRoundsWithDates(outputPath: string): Promise<void> {
  console.log(`Exporting rounds with Excel-friendly dates to ${outputPath}...`);

  const roundRows = await getAllRounds();
  if (roundRows.length === 0) {
    console.log('No rounds to export');
    return;
  }

  const headers = [
    'epoch',
    'start_date',
    'lock_date',
    'close_date',
    'lock_price',
    'close_price',
    'total_amount_bnb',
    'bull_amount_bnb',
    'bear_amount_bnb',
    'oracle_called',
    'reward_base_cal_bnb',
    'reward_amount_bnb',
    'winner',
    'winner_multiple',
    'round_duration_seconds',
  ];

  const lines: string[] = [];
  lines.push(headersToCSV(headers));

  for (const row of roundRows) {
    // Convert Unix timestamp to Excel-friendly ISO 8601 format
    const startDate = new Date(row.start_ts * 1000).toISOString().replace('T', ' ').replace('Z', '');
    const lockDate = new Date(row.lock_ts * 1000).toISOString().replace('T', ' ').replace('Z', '');
    const closeDate = new Date(row.close_ts * 1000).toISOString().replace('T', ' ').replace('Z', '');
    const duration = row.close_ts - row.start_ts;

    const humanRow = {
      epoch: row.epoch,
      start_date: startDate,
      lock_date: lockDate,
      close_date: closeDate,
      lock_price: row.lock_price,
      close_price: row.close_price,
      total_amount_bnb: (Number(row.total_amount_wei) / 1e18).toFixed(6),
      bull_amount_bnb: (Number(row.bull_amount_wei) / 1e18).toFixed(6),
      bear_amount_bnb: (Number(row.bear_amount_wei) / 1e18).toFixed(6),
      oracle_called: row.oracle_called,
      reward_base_cal_bnb: (Number(row.reward_base_cal_wei) / 1e18).toFixed(6),
      reward_amount_bnb: (Number(row.reward_amount_wei) / 1e18).toFixed(6),
      winner: row.winner,
      winner_multiple: row.winner_multiple,
      round_duration_seconds: duration,
    };

    lines.push(rowToCSV(humanRow));
  }

  const csvContent = lines.join('\n') + '\n';

  await writeFile(outputPath, csvContent, 'utf-8');
  console.log(`Exported ${roundRows.length} rows to ${outputPath}`);
}
