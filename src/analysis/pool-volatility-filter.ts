import { getDb } from '../store/sqlite.js';

interface HourlyAverage {
  hour: number;
  avgPoolBNB: number;
}

interface SnapshotRow {
  epoch: number;
  snapshot_type: string;
  taken_at: number;
  total_amount_wei: string;
  bull_amount_wei: string;
  bear_amount_wei: string;
  implied_up_multiple: number | null;
  implied_down_multiple: number | null;
}

interface RoundRow {
  epoch: number;
  winner: string;
  winner_multiple: string | null;
}

interface VolatilityAnalysis {
  snapshot: SnapshotRow;
  snapshotPoolBNB: number;
  snapshotHour: number;
  hourlyAvgBNB: number;
  poolPercentOfAvg: number;
  shouldBet: boolean;
  reason: string;
  actualWinner?: string;
  actualPayout?: number;
}

function weiToBNB(wei: string): number {
  return parseFloat(wei) / 1e18;
}

function getHourOfDay(timestamp: number): number {
  const date = new Date(timestamp * 1000);
  return date.getUTCHours();
}

function getMonthKey(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// Calculate hourly averages from October data
async function getOctoberHourlyAverages(): Promise<Map<number, number>> {
  const db = await getDb();

  const allRounds = db.exec('SELECT start_ts, total_amount_wei FROM rounds');
  if (allRounds.length === 0 || !allRounds[0].values.length) {
    throw new Error('No data found');
  }

  const columns = allRounds[0].columns;
  const rows = allRounds[0].values.map((row) => {
    const obj: any = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj;
  });

  // Filter October
  const octoberRounds = rows.filter((r: any) => getMonthKey(r.start_ts) === '2025-10');

  // Calculate hourly averages
  const hourlyData = new Map<number, { total: number; count: number }>();
  for (let hour = 0; hour < 24; hour++) {
    hourlyData.set(hour, { total: 0, count: 0 });
  }

  for (const round of octoberRounds) {
    const hour = getHourOfDay(round.start_ts);
    const volume = weiToBNB(round.total_amount_wei || '0');
    const data = hourlyData.get(hour)!;
    data.total += volume;
    data.count += 1;
  }

  const averages = new Map<number, number>();
  for (let hour = 0; hour < 24; hour++) {
    const data = hourlyData.get(hour)!;
    averages.set(hour, data.count > 0 ? data.total / data.count : 0);
  }

  return averages;
}

export async function analyzePoolVolatility(
  minPoolPercent: number = 80,
  maxPoolPercent: number = 150
): Promise<{
  snapshots: VolatilityAnalysis[];
  summary: {
    total: number;
    shouldBet: number;
    shouldSkip: number;
    skippedLowPool: number;
    skippedHighPool: number;
  };
}> {
  const db = await getDb();
  const hourlyAvgs = await getOctoberHourlyAverages();

  // Get all snapshots
  const snapshotsResult = db.exec('SELECT * FROM snapshots ORDER BY epoch ASC');
  if (snapshotsResult.length === 0 || !snapshotsResult[0].values.length) {
    throw new Error('No snapshots found');
  }

  const snapshotColumns = snapshotsResult[0].columns;
  const snapshots: SnapshotRow[] = snapshotsResult[0].values.map((row) => {
    const obj: any = {};
    snapshotColumns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj as SnapshotRow;
  });

  // Get round results
  const roundsResult = db.exec('SELECT epoch, winner, winner_multiple FROM rounds');
  const roundColumns = roundsResult[0]?.columns || [];
  const rounds = new Map<number, RoundRow>();

  if (roundsResult.length > 0 && roundsResult[0].values.length > 0) {
    roundsResult[0].values.forEach((row) => {
      const obj: any = {};
      roundColumns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      rounds.set(obj.epoch, obj as RoundRow);
    });
  }

  // Analyze each snapshot
  const analyses: VolatilityAnalysis[] = [];
  let shouldBet = 0;
  let shouldSkip = 0;
  let skippedLow = 0;
  let skippedHigh = 0;

  for (const snapshot of snapshots) {
    const poolBNB = weiToBNB(snapshot.total_amount_wei);
    const hour = getHourOfDay(snapshot.taken_at);
    const avgBNB = hourlyAvgs.get(hour) || 0;
    const percentOfAvg = avgBNB > 0 ? (poolBNB / avgBNB) * 100 : 0;

    let shouldBetThisRound = false;
    let reason = '';

    if (percentOfAvg < minPoolPercent) {
      reason = `Pool too small (${percentOfAvg.toFixed(1)}% of avg) - High volatility risk`;
      shouldSkip++;
      skippedLow++;
    } else if (percentOfAvg > maxPoolPercent) {
      reason = `Pool too large (${percentOfAvg.toFixed(1)}% of avg) - Unusual activity`;
      shouldSkip++;
      skippedHigh++;
    } else {
      reason = `Pool size acceptable (${percentOfAvg.toFixed(1)}% of avg)`;
      shouldBetThisRound = true;
      shouldBet++;
    }

    const round = rounds.get(snapshot.epoch);

    analyses.push({
      snapshot,
      snapshotPoolBNB: poolBNB,
      snapshotHour: hour,
      hourlyAvgBNB: avgBNB,
      poolPercentOfAvg: percentOfAvg,
      shouldBet: shouldBetThisRound,
      reason,
      actualWinner: round?.winner,
      actualPayout: round?.winner_multiple ? parseFloat(round.winner_multiple) : undefined,
    });
  }

  return {
    snapshots: analyses,
    summary: {
      total: analyses.length,
      shouldBet,
      shouldSkip,
      skippedLowPool: skippedLow,
      skippedHighPool: skippedHigh,
    },
  };
}

export function formatVolatilityAnalysis(
  analysis: {
    snapshots: VolatilityAnalysis[];
    summary: any;
  },
  minPercent: number,
  maxPercent: number
): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('          POOL VOLATILITY FILTER ANALYSIS');
  lines.push('═══════════════════════════════════════════════════════════════\n');

  lines.push('📋 FILTER SETTINGS');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Minimum Pool Size: ${minPercent}% of hourly average`);
  lines.push(`Maximum Pool Size: ${maxPercent}% of hourly average`);
  lines.push('');

  lines.push('📊 SUMMARY');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Total Snapshots: ${analysis.summary.total}`);
  lines.push(`Would BET: ${analysis.summary.shouldBet} (${((analysis.summary.shouldBet / analysis.summary.total) * 100).toFixed(1)}%)`);
  lines.push(`Would SKIP: ${analysis.summary.shouldSkip} (${((analysis.summary.shouldSkip / analysis.summary.total) * 100).toFixed(1)}%)`);
  lines.push(`  - Too small: ${analysis.summary.skippedLowPool}`);
  lines.push(`  - Too large: ${analysis.summary.skippedHighPool}`);
  lines.push('');

  lines.push('📈 SNAPSHOT ANALYSIS');
  lines.push('─────────────────────────────────────────────────────────────');

  for (const snap of analysis.snapshots) {
    const status = snap.shouldBet ? '✅ BET' : '❌ SKIP';
    const bull = weiToBNB(snap.snapshot.bull_amount_wei);
    const bear = weiToBNB(snap.snapshot.bear_amount_wei);
    const bullPct = snap.snapshotPoolBNB > 0 ? (bull / snap.snapshotPoolBNB) * 100 : 0;
    const bearPct = snap.snapshotPoolBNB > 0 ? (bear / snap.snapshotPoolBNB) * 100 : 0;

    lines.push(`\nEpoch ${snap.snapshot.epoch} - ${status}`);
    lines.push(`  Hour: ${String(snap.snapshotHour).padStart(2, '0')}:00 UTC`);
    lines.push(`  Pool at T-12s: ${snap.snapshotPoolBNB.toFixed(2)} BNB`);
    lines.push(`  Hourly Avg: ${snap.hourlyAvgBNB.toFixed(2)} BNB`);
    lines.push(`  % of Average: ${snap.poolPercentOfAvg.toFixed(1)}%`);
    lines.push(`  Distribution: ${bullPct.toFixed(1)}% BULL / ${bearPct.toFixed(1)}% BEAR`);
    lines.push(`  Implied Odds: UP ${snap.snapshot.implied_up_multiple?.toFixed(2)}x | DOWN ${snap.snapshot.implied_down_multiple?.toFixed(2)}x`);
    lines.push(`  Decision: ${snap.reason}`);

    if (snap.actualWinner) {
      lines.push(`  Actual Result: ${snap.actualWinner}${snap.actualPayout ? ` (${snap.actualPayout.toFixed(2)}x)` : ''}`);
    } else {
      lines.push(`  Actual Result: Pending...`);
    }
  }

  lines.push('\n═══════════════════════════════════════════════════════════════');
  lines.push('💡 INTERPRETATION:');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('Pools below minimum % = High volatility (late bets can swing odds)');
  lines.push('Pools above maximum % = Unusual activity (potential manipulation)');
  lines.push('Pools within range = More stable, reliable for contrarian betting');
  lines.push('═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}
