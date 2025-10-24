import { getDb } from '../store/sqlite.js';

interface RoundRow {
  epoch: number;
  start_ts: number;
  total_amount_wei: string;
}

interface HourlyPoolData {
  hour: number;
  avgPoolBNB: number;
  totalRounds: number;
  totalVolumeBNB: number;
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

export async function analyzeOctoberHourly(): Promise<HourlyPoolData[]> {
  const db = await getDb();

  const allRounds = db.exec('SELECT epoch, start_ts, total_amount_wei FROM rounds ORDER BY start_ts ASC');
  if (allRounds.length === 0 || !allRounds[0].values.length) {
    throw new Error('No data found in database');
  }

  const columns = allRounds[0].columns;
  const allRows: RoundRow[] = allRounds[0].values.map((row) => {
    const obj: any = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj as RoundRow;
  });

  // Filter for October 2025
  const octoberRounds = allRows.filter(r => getMonthKey(r.start_ts) === '2025-10');

  // Group by hour
  const hourlyData = new Map<number, { totalVolume: number; rounds: number }>();
  for (let hour = 0; hour < 24; hour++) {
    hourlyData.set(hour, { totalVolume: 0, rounds: 0 });
  }

  for (const round of octoberRounds) {
    const hour = getHourOfDay(round.start_ts);
    const volume = weiToBNB(round.total_amount_wei || '0');

    const data = hourlyData.get(hour)!;
    data.totalVolume += volume;
    data.rounds += 1;
  }

  // Calculate averages
  const result: HourlyPoolData[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const data = hourlyData.get(hour)!;
    result.push({
      hour,
      avgPoolBNB: data.rounds > 0 ? data.totalVolume / data.rounds : 0,
      totalRounds: data.rounds,
      totalVolumeBNB: data.totalVolume,
    });
  }

  return result;
}

export function formatOctoberHourly(data: HourlyPoolData[]): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('      OCTOBER 2025 - AVERAGE POOL SIZE BY HOUR (UTC)');
  lines.push('═══════════════════════════════════════════════════════════════\n');

  lines.push('Hour (UTC) | Rounds | Avg Pool Size | Total Volume');
  lines.push('           |        | (BNB)         | (BNB)');
  lines.push('─────────────────────────────────────────────────────────────');

  for (const hourData of data) {
    const hourStr = `${String(hourData.hour).padStart(2, '0')}:00-${String((hourData.hour + 1) % 24).padStart(2, '0')}:00`;
    const rounds = String(hourData.totalRounds).padStart(6);
    const avgPool = hourData.avgPoolBNB.toFixed(2).padStart(13);
    const totalVol = hourData.totalVolumeBNB.toFixed(2).padStart(12);

    lines.push(`${hourStr.padEnd(11)}|${rounds} |${avgPool} |${totalVol}`);
  }

  lines.push('');

  // Find peak and low hours
  const sortedByAvg = [...data].sort((a, b) => b.avgPoolBNB - a.avgPoolBNB);
  const highest = sortedByAvg[0];
  const lowest = sortedByAvg.filter(h => h.totalRounds > 0).slice(-1)[0];

  lines.push('📊 KEY INSIGHTS');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Highest Avg Pool: ${String(highest.hour).padStart(2, '0')}:00 UTC (${highest.avgPoolBNB.toFixed(2)} BNB)`);
  lines.push(`Lowest Avg Pool:  ${String(lowest.hour).padStart(2, '0')}:00 UTC (${lowest.avgPoolBNB.toFixed(2)} BNB)`);
  lines.push(`Difference: ${(highest.avgPoolBNB - lowest.avgPoolBNB).toFixed(2)} BNB (${((highest.avgPoolBNB / lowest.avgPoolBNB - 1) * 100).toFixed(1)}% higher)`);

  lines.push('\n═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}
