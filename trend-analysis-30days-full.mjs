import initSqlJs from 'sql.js';
import fs from 'fs';

const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync('prediction-data.db'));

console.log('=== TREND ANALYSIS: Last 30 Days - PERIODS WITH ≥8% BIAS (≥58% win rate) ===\n');

// Get date range
const now = Math.floor(Date.now() / 1000);
const thirtyDaysAgo = now - (30 * 24 * 60 * 60);

// Get all rounds in last 30 days
const allRounds = db.exec(`
  SELECT epoch, lock_ts, winner
  FROM rounds
  WHERE lock_ts >= ${thirtyDaysAgo}
  AND winner IN ('UP', 'DOWN')
  ORDER BY lock_ts ASC
`);

if (!allRounds[0] || allRounds[0].values.length === 0) {
  console.log('No rounds found in last 30 days');
  db.close();
  process.exit(0);
}

const rounds = allRounds[0].values.map(row => ({
  epoch: row[0],
  lockTs: row[1],
  winner: row[2]
}));

// Get snapshot epochs
const snapshotEpochs = new Set(
  db.exec('SELECT DISTINCT epoch FROM snapshots')[0].values.map(row => row[0])
);

console.log(`Total rounds in last 30 days: ${rounds.length}`);
console.log(`Snapshot rounds: ${snapshotEpochs.size}\n`);

// Time windows to analyze (in hours)
const windowSizes = [2, 3, 6, 12];

for (const windowHours of windowSizes) {
  console.log(`\n${'='.repeat(100)}`);
  console.log(`WINDOW SIZE: ${windowHours} HOUR${windowHours > 1 ? 'S' : ''}`);
  console.log('='.repeat(100));

  const windowSeconds = windowHours * 60 * 60;
  const allPeriods = [];

  // Slide through time windows
  let windowStart = rounds[0].lockTs;
  const lastTs = rounds[rounds.length - 1].lockTs;

  while (windowStart + windowSeconds <= lastTs) {
    const windowEnd = windowStart + windowSeconds;

    const windowRounds = rounds.filter(r => r.lockTs >= windowStart && r.lockTs < windowEnd);
    const snapshotRounds = windowRounds.filter(r => snapshotEpochs.has(r.epoch));

    if (windowRounds.length < 10) {
      windowStart += windowSeconds;
      continue;
    }

    const allUpWins = windowRounds.filter(r => r.winner === 'UP').length;
    const allDownWins = windowRounds.filter(r => r.winner === 'DOWN').length;
    const allTotal = windowRounds.length;
    const allUpRate = (allUpWins / allTotal) * 100;
    const allBias = allUpRate - 50;

    const snapUpWins = snapshotRounds.filter(r => r.winner === 'UP').length;
    const snapDownWins = snapshotRounds.filter(r => r.winner === 'DOWN').length;
    const snapTotal = snapshotRounds.length;
    const snapUpRate = snapTotal > 0 ? (snapUpWins / snapTotal) * 100 : 0;
    const snapBias = snapTotal > 0 ? snapUpRate - 50 : 0;

    // Only show periods with significant bias (≥8% from 50/50 = ≥58% win rate)
    if (Math.abs(allBias) >= 8) {
      const startDate = new Date(windowStart * 1000);
      const endDate = new Date(windowEnd * 1000);

      allPeriods.push({
        start: startDate,
        end: endDate,
        allTotal,
        allUpWins,
        allDownWins,
        allUpRate,
        allBias,
        snapTotal,
        snapUpWins,
        snapDownWins,
        snapUpRate,
        snapBias
      });
    }

    windowStart += windowSeconds;
  }

  if (allPeriods.length === 0) {
    console.log('No significant bias periods found (≥8% deviation from 50/50)');
    continue;
  }

  console.log(`\nFound ${allPeriods.length} periods with ≥8% bias (≥58% win rate)\n`);

  // Sort by start time (chronological)
  allPeriods.sort((a, b) => a.start.getTime() - b.start.getTime());

  console.log('┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐');
  console.log('│ Period                          │ All Rounds               │ Snapshot Rounds          │ Bias        │');
  console.log('├──────────────────────────────────────────────────────────────────────────────────────────────────────┤');

  for (const p of allPeriods) {
    const startStr = p.start.toISOString().substring(5, 16).replace('T', ' ');
    const endStr = p.end.toISOString().substring(5, 16).replace('T', ' ');
    const periodStr = `${startStr} to ${endStr}`.padEnd(31);

    const direction = p.allBias > 0 ? 'UP' : 'DOWN';
    const allStats = `${p.allUpWins}↑ ${p.allDownWins}↓ (${p.allUpRate.toFixed(1)}%)`.padEnd(24);

    let snapStats;
    if (p.snapTotal > 0) {
      snapStats = `${p.snapUpWins}↑ ${p.snapDownWins}↓ (${p.snapUpRate.toFixed(1)}%)`.padEnd(24);
    } else {
      snapStats = 'No snapshots'.padEnd(24);
    }

    const biasStr = `${direction} +${Math.abs(p.allBias).toFixed(1)}%`.padEnd(11);

    console.log(`│ ${periodStr} │ ${allStats} │ ${snapStats} │ ${biasStr} │`);
  }

  console.log('└──────────────────────────────────────────────────────────────────────────────────────────────────────┘');
}

console.log('\n\n=== SUMMARY ===\n');

// Overall stats
const totalUp = rounds.filter(r => r.winner === 'UP').length;
const totalDown = rounds.filter(r => r.winner === 'DOWN').length;
console.log(`Overall 30 days: ${totalUp}↑ (${(totalUp*100/rounds.length).toFixed(1)}%) vs ${totalDown}↓ (${(totalDown*100/rounds.length).toFixed(1)}%)`);

const snapRounds = rounds.filter(r => snapshotEpochs.has(r.epoch));
const snapUp = snapRounds.filter(r => r.winner === 'UP').length;
const snapDown = snapRounds.filter(r => r.winner === 'DOWN').length;
console.log(`Snapshot rounds: ${snapUp}↑ (${(snapUp*100/snapRounds.length).toFixed(1)}%) vs ${snapDown}↓ (${(snapDown*100/snapRounds.length).toFixed(1)}%)`);

db.close();
