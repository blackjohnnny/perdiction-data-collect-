import initSqlJs from 'sql.js';
import fs from 'fs';

console.log('=== PROFITABILITY BY TIME PERIOD ===\n');
console.log('Finding the most profitable hours to trade\n');

const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync('prediction-data.db'));

// Get all rounds with prices
const allRounds = db.exec(`
  SELECT epoch, lock_ts, close_ts, lock_price, close_price, winner
  FROM rounds
  WHERE lock_ts >= ${Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60)}
  AND winner IN ('UP', 'DOWN')
  ORDER BY lock_ts ASC
`);

const rounds = allRounds[0].values.map(row => {
  const lockTs = row[1];
  const date = new Date(lockTs * 1000);
  const hour = date.getUTCHours();
  const dayOfWeek = date.getUTCDay(); // 0=Sunday, 1=Monday, etc

  return {
    epoch: row[0],
    lockTs,
    hour,
    dayOfWeek,
    closeTs: row[2],
    lockPrice: Number(BigInt(row[3])) / 1e8,
    closePrice: Number(BigInt(row[4])) / 1e8,
    winner: row[5]
  };
});

// Get snapshot data with crowd
const snapshotData = db.exec(`
  SELECT s.epoch, s.taken_at, s.bull_amount_wei, s.bear_amount_wei, s.total_amount_wei
  FROM snapshots s
`);

const snapshotMap = new Map();
if (snapshotData[0]) {
  snapshotData[0].values.forEach(row => {
    const bull = BigInt(row[2]);
    const bear = BigInt(row[3]);
    const total = BigInt(row[4]);
    const bullPct = Number((bull * 10000n) / total) / 100;
    const bearPct = 100 - bullPct;

    const crowdBet = bull > bear ? 'UP' : 'DOWN';
    const meets55 = Math.max(bullPct, bearPct) >= 55;
    const meets70 = Math.max(bullPct, bearPct) >= 70;

    const takenAt = row[1];
    const date = new Date(takenAt * 1000);
    const hour = date.getUTCHours();

    snapshotMap.set(row[0], {
      crowdBet,
      meets55,
      meets70,
      poolSizeBNB: Number(total) / 1e18,
      hour
    });
  });
}

console.log(`Analyzing ${rounds.length} rounds\n`);
console.log('='.repeat(80));

// Helper: Calculate EMA
function calculateEMA(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }
  return ema;
}

// Analyze by hour (UTC)
const hourlyStats = {};
for (let h = 0; h < 24; h++) {
  hourlyStats[h] = {
    trades55: 0,
    wins55: 0,
    trades70: 0,
    wins70: 0,
    tradesCombined: 0,
    winsCombined: 0,
    totalRounds: 0,
    avgPoolSize: 0,
    poolSizeSum: 0
  };
}

const emaFast = 5;
const emaSlow = 13;
const requiredHistory = 30;

for (let i = requiredHistory; i < rounds.length; i++) {
  const round = rounds[i];
  const snapshot = snapshotMap.get(round.epoch);

  if (!snapshot) continue;

  const hour = round.hour;
  hourlyStats[hour].totalRounds++;
  hourlyStats[hour].poolSizeSum += snapshot.poolSizeBNB;

  // Get historical closes for EMA
  const closes = rounds.slice(i - requiredHistory, i).map(r => r.closePrice);
  if (closes.length < emaSlow) continue;

  const ema5 = calculateEMA(closes, emaFast);
  const ema13 = calculateEMA(closes, emaSlow);
  if (!ema5 || !ema13) continue;

  const emaSignal = ema5 > ema13 ? 'UP' : 'DOWN';

  // Test 55% threshold
  if (snapshot.meets55 && emaSignal === snapshot.crowdBet) {
    hourlyStats[hour].trades55++;
    if (emaSignal === round.winner) {
      hourlyStats[hour].wins55++;
    }
  }

  // Test 70% threshold
  if (snapshot.meets70 && emaSignal === snapshot.crowdBet) {
    hourlyStats[hour].trades70++;
    if (emaSignal === round.winner) {
      hourlyStats[hour].wins70++;
    }
  }

  // Combined strategy: Use 55% OR 70% (whichever triggers)
  if ((snapshot.meets55 || snapshot.meets70) && emaSignal === snapshot.crowdBet) {
    hourlyStats[hour].tradesCombined++;
    if (emaSignal === round.winner) {
      hourlyStats[hour].winsCombined++;
    }
  }
}

// Calculate win rates and avg pool sizes
for (let h = 0; h < 24; h++) {
  const stats = hourlyStats[h];
  if (stats.totalRounds > 0) {
    stats.avgPoolSize = stats.poolSizeSum / stats.totalRounds;
  }
  stats.winRate55 = stats.trades55 > 0 ? (stats.wins55 * 100 / stats.trades55) : 0;
  stats.winRate70 = stats.trades70 > 0 ? (stats.wins70 * 100 / stats.trades70) : 0;
  stats.winRateCombined = stats.tradesCombined > 0 ? (stats.winsCombined * 100 / stats.tradesCombined) : 0;
  stats.edge55 = stats.winRate55 - 51.5;
  stats.edge70 = stats.winRate70 - 51.5;
  stats.edgeCombined = stats.winRateCombined - 51.5;
}

console.log('\nSTRATEGY PERFORMANCE BY HOUR (UTC):\n');
console.log('COMBINED (55% OR 70%):\n');
console.log('Hour | Trades | Win Rate | Edge    | Avg Pool | Quality');
console.log('-----|--------|----------|---------|----------|--------');

for (let h = 0; h < 24; h++) {
  const stats = hourlyStats[h];
  if (stats.tradesCombined === 0) continue;

  const quality = stats.edgeCombined > 15 ? 'EXCELLENT' :
                  stats.edgeCombined > 10 ? 'GREAT' :
                  stats.edgeCombined > 5 ? 'GOOD' :
                  stats.edgeCombined > 0 ? 'OK' : 'POOR';

  console.log(`${h.toString().padStart(4)} | ${stats.tradesCombined.toString().padStart(6)} | ` +
              `${stats.winRateCombined.toFixed(1).padStart(7)}% | ` +
              `${(stats.edgeCombined > 0 ? '+' : '') + stats.edgeCombined.toFixed(1).padStart(6)}% | ` +
              `${stats.avgPoolSize.toFixed(2).padStart(8)} | ${quality}`);
}

console.log('\n' + '='.repeat(80));
console.log('\nBEST TIME PERIODS:\n');

// Find best hours for combined strategy (include all with at least 1 trade)
const hoursCombined = Object.entries(hourlyStats)
  .filter(([h, s]) => s.tradesCombined >= 1) // Include all hours with data
  .sort((a, b) => b[1].winRateCombined - a[1].winRateCombined);

console.log('COMBINED Strategy (55% OR 70%) - ALL Hours with Data:\n');
hoursCombined.forEach(([hour, stats], i) => {
  console.log(`${(i + 1).toString().padStart(2)}. ${hour.toString().padStart(2)}:00 UTC - ${stats.winRateCombined.toFixed(1)}% win rate ` +
              `(${stats.winsCombined}/${stats.tradesCombined}) - Edge: ${stats.edgeCombined > 0 ? '+' : ''}${stats.edgeCombined.toFixed(1)}% - ` +
              `Avg Pool: ${stats.avgPoolSize.toFixed(2)} BNB`);
});

console.log('\n' + '='.repeat(80));
console.log('\nKEY INSIGHTS:\n');

// Calculate overall stats
const allHoursStatsCombined = Object.values(hourlyStats).reduce((acc, s) => ({
  trades: acc.trades + s.tradesCombined,
  wins: acc.wins + s.winsCombined
}), { trades: 0, wins: 0 });

const overallWinRateCombined = (allHoursStatsCombined.wins * 100 / allHoursStatsCombined.trades);

console.log(`Overall performance (all hours):`);
console.log(`  Combined (55% OR 70%): ${overallWinRateCombined.toFixed(1)}% win rate\n`);

// Find hours significantly better than average
const betterHoursCombined = Object.entries(hourlyStats)
  .filter(([h, s]) => s.tradesCombined >= 3 && s.winRateCombined > overallWinRateCombined + 5);

if (betterHoursCombined.length > 0) {
  console.log(`Hours significantly better than average (Combined):`);
  betterHoursCombined.forEach(([hour, stats]) => {
    console.log(`  ${hour}:00 UTC - ${stats.winRateCombined.toFixed(1)}% ` +
                `(+${(stats.winRateCombined - overallWinRateCombined).toFixed(1)}% vs avg)`);
  });
  console.log('');
}

// Pool size correlation
console.log('Pool size vs win rate correlation:');
const poolSizeGroups = {
  small: { hours: [], avgWinRate: 0 },
  medium: { hours: [], avgWinRate: 0 },
  large: { hours: [], avgWinRate: 0 }
};

Object.entries(hourlyStats).forEach(([hour, stats]) => {
  if (stats.tradesCombined === 0) return;

  if (stats.avgPoolSize < 1.5) {
    poolSizeGroups.small.hours.push(stats);
  } else if (stats.avgPoolSize < 2.5) {
    poolSizeGroups.medium.hours.push(stats);
  } else {
    poolSizeGroups.large.hours.push(stats);
  }
});

['small', 'medium', 'large'].forEach(group => {
  const hours = poolSizeGroups[group].hours;
  if (hours.length > 0) {
    const avgWinRate = hours.reduce((sum, h) => sum + h.winRateCombined, 0) / hours.length;
    const avgPool = hours.reduce((sum, h) => sum + h.avgPoolSize, 0) / hours.length;
    console.log(`  ${group} pools (<${group === 'small' ? '1.5' : group === 'medium' ? '2.5' : '∞'} BNB avg): ` +
                `${avgWinRate.toFixed(1)}% win rate (avg pool: ${avgPool.toFixed(2)} BNB)`);
  }
});

console.log('\n' + '='.repeat(80));
console.log('\nRECOMMENDATIONS:\n');

if (betterHoursCombined.length > 0) {
  console.log(`✓ YES - Some hours are significantly more profitable!\n`);

  const bestHours = betterHoursCombined.map(([h]) => h).sort((a, b) => a - b).join(', ');
  console.log(`Best hours for COMBINED strategy: ${bestHours}:00 UTC`);

  console.log('\nPossible reasons:');
  console.log('  - Smaller pools = less manipulation');
  console.log('  - More informed traders active');
  console.log('  - Cleaner price action during these hours');
  console.log('  - Less bot activity disrupting patterns');
} else {
  console.log(`Strategy works consistently across all hours!`);
  console.log(`No need to restrict trading to specific times.`);
}

console.log('\nData limitation note:');
console.log(`  Only ${snapshotMap.size} snapshots analyzed`);
console.log(`  Total qualifying trades: ${allHoursStatsCombined.trades}`);
console.log(`  Some hours have very few samples`);
console.log(`  → Need MORE data to confirm time-based patterns!`);
console.log(`  → For now, trade all hours where signal appears`);

// Additional statistics
console.log('\n' + '='.repeat(80));
console.log('\nADDITIONAL STATISTICS:\n');

// Day of week analysis
const dayStats = {};
for (let d = 0; d < 7; d++) {
  dayStats[d] = {
    trades: 0,
    wins: 0,
    totalRounds: 0,
    avgPoolSize: 0,
    poolSizeSum: 0
  };
}

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

for (let i = requiredHistory; i < rounds.length; i++) {
  const round = rounds[i];
  const snapshot = snapshotMap.get(round.epoch);

  if (!snapshot) continue;

  const day = round.dayOfWeek;
  dayStats[day].totalRounds++;
  dayStats[day].poolSizeSum += snapshot.poolSizeBNB;

  const closes = rounds.slice(i - requiredHistory, i).map(r => r.closePrice);
  if (closes.length < emaSlow) continue;

  const ema5 = calculateEMA(closes, emaFast);
  const ema13 = calculateEMA(closes, emaSlow);
  if (!ema5 || !ema13) continue;

  const emaSignal = ema5 > ema13 ? 'UP' : 'DOWN';

  if ((snapshot.meets55 || snapshot.meets70) && emaSignal === snapshot.crowdBet) {
    dayStats[day].trades++;
    if (emaSignal === round.winner) {
      dayStats[day].wins++;
    }
  }
}

console.log('Performance by Day of Week:\n');
console.log('Day        | Trades | Win Rate | Edge    | Avg Pool');
console.log('-----------|--------|----------|---------|----------');

for (let d = 0; d < 7; d++) {
  const stats = dayStats[d];
  if (stats.trades === 0) continue;

  const avgPool = stats.totalRounds > 0 ? stats.poolSizeSum / stats.totalRounds : 0;
  const winRate = (stats.wins * 100 / stats.trades);
  const edge = winRate - 51.5;

  console.log(`${dayNames[d].padEnd(10)} | ${stats.trades.toString().padStart(6)} | ` +
              `${winRate.toFixed(1).padStart(7)}% | ` +
              `${(edge > 0 ? '+' : '') + edge.toFixed(1).padStart(6)}% | ` +
              `${avgPool.toFixed(2).padStart(8)}`);
}

db.close();
