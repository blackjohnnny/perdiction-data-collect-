import { getDb } from '../store/sqlite.js';

interface RoundRow {
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
  winner: string;
  winner_multiple: string | null;
}

interface DetailedMonthStats {
  month: string;
  dateRange: { start: string; end: string };
  totalRounds: number;

  outcomes: {
    upWins: number;
    downWins: number;
    draws: number;
    unknown: number;
    upWinRate: number;
    downWinRate: number;
    winDistribution: { [day: number]: { up: number; down: number } };
  };

  betting: {
    totalVolumeBNB: number;
    averagePoolSizeBNB: number;
    medianPoolSizeBNB: number;
    largestPoolBNB: { epoch: number; amount: number; date: string };
    smallestPoolBNB: { epoch: number; amount: number; date: string };
    averageBullPoolBNB: number;
    averageBearPoolBNB: number;
    dailyVolume: { [day: number]: number };
  };

  poolBalance: {
    averageBullPercentage: number;
    averageBearPercentage: number;
    mostBalancedRound: { epoch: number; bullPercent: number; bearPercent: number; date: string };
    mostImbalancedRound: { epoch: number; bullPercent: number; bearPercent: number; date: string };
    imbalanceDistribution: {
      balanced: number; // <5% difference
      moderate: number; // 5-15% difference
      high: number;     // >15% difference
    };
  };

  payouts: {
    averageUpPayout: number;
    averageDownPayout: number;
    medianUpPayout: number;
    medianDownPayout: number;
    highestPayout: { epoch: number; winner: string; multiple: number; date: string };
    lowestPayout: { epoch: number; winner: string; multiple: number; date: string };
    payoutsOver2x: number;
    payoutsOver5x: number;
    payoutsOver10x: number;
    payoutDistribution: {
      under1_5x: number;
      from1_5to2x: number;
      from2to3x: number;
      from3to5x: number;
      over5x: number;
    };
  };

  priceMovement: {
    averagePriceChangePercent: number;
    medianPriceChangePercent: number;
    largestUpMove: { epoch: number; changePercent: number; date: string };
    largestDownMove: { epoch: number; changePercent: number; date: string };
    volatilityScore: number; // standard deviation
    priceChangeDistribution: {
      under0_1: number;
      from0_1to0_3: number;
      from0_3to0_5: number;
      over0_5: number;
    };
  };

  streaks: {
    longestUpStreak: { length: number; startEpoch: number; endEpoch: number };
    longestDownStreak: { length: number; startEpoch: number; endEpoch: number };
    streakDistribution: { [length: number]: number };
    totalStreaks: number;
  };

  temporal: {
    roundsPerDay: { [day: number]: number };
    avgRoundsPerDay: number;
    busiestDay: { date: string; rounds: number };
    quietestDay: { date: string; rounds: number };
  };
}

function weiToBNB(wei: string): number {
  return parseFloat(wei) / 1e18;
}

function getMonthKey(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function getDayOfMonth(timestamp: number): number {
  const date = new Date(timestamp * 1000);
  return date.getUTCDate();
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toISOString().split('T')[0];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}

export async function analyzeDetailedMonth(year: number, month: number): Promise<DetailedMonthStats> {
  const db = await getDb();

  const allRounds = db.exec('SELECT * FROM rounds ORDER BY start_ts ASC');
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

  // Filter for the specific month
  const targetMonthKey = `${year}-${String(month).padStart(2, '0')}`;
  const rows = allRows.filter(r => getMonthKey(r.start_ts) === targetMonthKey);

  if (rows.length === 0) {
    throw new Error(`No data found for ${year}-${month}`);
  }

  const totalRounds = rows.length;
  const monthName = new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

  // Date range
  const startDate = formatDate(rows[0].start_ts);
  const endDate = formatDate(rows[rows.length - 1].close_ts);

  // Outcomes
  const upWins = rows.filter(r => r.winner === 'UP').length;
  const downWins = rows.filter(r => r.winner === 'DOWN').length;
  const draws = rows.filter(r => r.winner === 'DRAW').length;
  const unknown = rows.filter(r => r.winner === 'UNKNOWN').length;

  const winDistribution: { [day: number]: { up: number; down: number } } = {};
  rows.forEach(r => {
    const day = getDayOfMonth(r.start_ts);
    if (!winDistribution[day]) {
      winDistribution[day] = { up: 0, down: 0 };
    }
    if (r.winner === 'UP') winDistribution[day].up++;
    if (r.winner === 'DOWN') winDistribution[day].down++;
  });

  // Betting volume
  const poolSizes = rows.map(r => weiToBNB(r.total_amount_wei || '0'));
  const totalVolume = poolSizes.reduce((sum, v) => sum + v, 0);
  const avgPoolSize = totalVolume / totalRounds;
  const medianPoolSize = median(poolSizes);

  const poolSizesWithEpoch = rows.map(r => ({
    epoch: r.epoch,
    amount: weiToBNB(r.total_amount_wei || '0'),
    date: formatDate(r.start_ts)
  }));
  const largestPool = poolSizesWithEpoch.reduce((max, p) => p.amount > max.amount ? p : max, poolSizesWithEpoch[0]);
  const smallestPool = poolSizesWithEpoch.reduce((min, p) => p.amount < min.amount ? p : min, poolSizesWithEpoch[0]);

  const avgBullPool = rows.reduce((sum, r) => sum + weiToBNB(r.bull_amount_wei || '0'), 0) / totalRounds;
  const avgBearPool = rows.reduce((sum, r) => sum + weiToBNB(r.bear_amount_wei || '0'), 0) / totalRounds;

  const dailyVolume: { [day: number]: number } = {};
  rows.forEach(r => {
    const day = getDayOfMonth(r.start_ts);
    const volume = weiToBNB(r.total_amount_wei || '0');
    dailyVolume[day] = (dailyVolume[day] || 0) + volume;
  });

  // Pool balance
  const poolBalances = rows.map(r => {
    const total = weiToBNB(r.total_amount_wei || '0');
    const bull = weiToBNB(r.bull_amount_wei || '0');
    const bear = weiToBNB(r.bear_amount_wei || '0');
    return {
      epoch: r.epoch,
      bullPercent: total > 0 ? (bull / total) * 100 : 0,
      bearPercent: total > 0 ? (bear / total) * 100 : 0,
      imbalance: total > 0 ? Math.abs(bull - bear) / total : 0,
      date: formatDate(r.start_ts)
    };
  });

  const avgBullPercent = poolBalances.reduce((sum, p) => sum + p.bullPercent, 0) / totalRounds;
  const avgBearPercent = poolBalances.reduce((sum, p) => sum + p.bearPercent, 0) / totalRounds;

  const mostBalanced = poolBalances.reduce((min, p) => p.imbalance < min.imbalance ? p : min, poolBalances[0]);
  const mostImbalanced = poolBalances.reduce((max, p) => p.imbalance > max.imbalance ? p : max, poolBalances[0]);

  const imbalanceDistribution = {
    balanced: poolBalances.filter(p => p.imbalance < 0.05).length,
    moderate: poolBalances.filter(p => p.imbalance >= 0.05 && p.imbalance < 0.15).length,
    high: poolBalances.filter(p => p.imbalance >= 0.15).length,
  };

  // Payouts
  const payouts = rows
    .filter(r => r.winner_multiple !== null && r.winner_multiple !== '')
    .map(r => ({
      epoch: r.epoch,
      winner: r.winner,
      multiple: parseFloat(r.winner_multiple!),
      date: formatDate(r.start_ts)
    }));

  const upPayouts = payouts.filter(p => p.winner === 'UP').map(p => p.multiple);
  const downPayouts = payouts.filter(p => p.winner === 'DOWN').map(p => p.multiple);

  const avgUpPayout = upPayouts.length > 0 ? upPayouts.reduce((sum, p) => sum + p, 0) / upPayouts.length : 0;
  const avgDownPayout = downPayouts.length > 0 ? downPayouts.reduce((sum, p) => sum + p, 0) / downPayouts.length : 0;
  const medianUpPayout = median(upPayouts);
  const medianDownPayout = median(downPayouts);

  const highestPayout = payouts.length > 0
    ? payouts.reduce((max, p) => p.multiple > max.multiple ? p : max, payouts[0])
    : { epoch: 0, winner: 'N/A', multiple: 0, date: '' };
  const lowestPayout = payouts.length > 0
    ? payouts.reduce((min, p) => p.multiple < min.multiple ? p : min, payouts[0])
    : { epoch: 0, winner: 'N/A', multiple: 0, date: '' };

  const payoutsOver2x = payouts.filter(p => p.multiple >= 2).length;
  const payoutsOver5x = payouts.filter(p => p.multiple >= 5).length;
  const payoutsOver10x = payouts.filter(p => p.multiple >= 10).length;

  const payoutDistribution = {
    under1_5x: payouts.filter(p => p.multiple < 1.5).length,
    from1_5to2x: payouts.filter(p => p.multiple >= 1.5 && p.multiple < 2).length,
    from2to3x: payouts.filter(p => p.multiple >= 2 && p.multiple < 3).length,
    from3to5x: payouts.filter(p => p.multiple >= 3 && p.multiple < 5).length,
    over5x: payouts.filter(p => p.multiple >= 5).length,
  };

  // Price movement
  const priceChanges = rows.map(r => {
    const lockPrice = weiToBNB(r.lock_price || '0');
    const closePrice = weiToBNB(r.close_price || '0');
    const change = closePrice - lockPrice;
    const changePercent = lockPrice > 0 ? Math.abs(change / lockPrice) * 100 : 0;
    return {
      epoch: r.epoch,
      changePercent,
      rawChangePercent: lockPrice > 0 ? (change / lockPrice) * 100 : 0,
      date: formatDate(r.start_ts)
    };
  });

  const avgPriceChangePercent = priceChanges.reduce((sum, p) => sum + p.rawChangePercent, 0) / totalRounds;
  const medianPriceChangePercent = median(priceChanges.map(p => p.rawChangePercent));
  const volatilityScore = standardDeviation(priceChanges.map(p => p.rawChangePercent));

  const largestUpMove = priceChanges.reduce((max, p) => p.rawChangePercent > max.rawChangePercent ? p : max, priceChanges[0]);
  const largestDownMove = priceChanges.reduce((min, p) => p.rawChangePercent < min.rawChangePercent ? p : min, priceChanges[0]);

  const priceChangeDistribution = {
    under0_1: priceChanges.filter(p => p.changePercent < 0.1).length,
    from0_1to0_3: priceChanges.filter(p => p.changePercent >= 0.1 && p.changePercent < 0.3).length,
    from0_3to0_5: priceChanges.filter(p => p.changePercent >= 0.3 && p.changePercent < 0.5).length,
    over0_5: priceChanges.filter(p => p.changePercent >= 0.5).length,
  };

  // Streaks
  let currentStreak = 0;
  let currentWinner = '';
  let maxUpStreak = { length: 0, startEpoch: 0, endEpoch: 0 };
  let maxDownStreak = { length: 0, startEpoch: 0, endEpoch: 0 };
  const streakDistribution: { [length: number]: number } = {};
  let totalStreaks = 0;

  for (let i = 0; i < rows.length; i++) {
    const winner = rows[i].winner;

    if (winner === currentWinner && (winner === 'UP' || winner === 'DOWN')) {
      currentStreak++;
    } else {
      if (currentStreak > 0) {
        streakDistribution[currentStreak] = (streakDistribution[currentStreak] || 0) + 1;
        totalStreaks++;

        if (currentWinner === 'UP' && currentStreak > maxUpStreak.length) {
          maxUpStreak = {
            length: currentStreak,
            startEpoch: rows[i - currentStreak].epoch,
            endEpoch: rows[i - 1].epoch
          };
        } else if (currentWinner === 'DOWN' && currentStreak > maxDownStreak.length) {
          maxDownStreak = {
            length: currentStreak,
            startEpoch: rows[i - currentStreak].epoch,
            endEpoch: rows[i - 1].epoch
          };
        }
      }
      currentWinner = winner;
      currentStreak = 1;
    }
  }

  // Don't forget the last streak
  if (currentStreak > 0) {
    streakDistribution[currentStreak] = (streakDistribution[currentStreak] || 0) + 1;
    totalStreaks++;

    if (currentWinner === 'UP' && currentStreak > maxUpStreak.length) {
      maxUpStreak = {
        length: currentStreak,
        startEpoch: rows[rows.length - currentStreak].epoch,
        endEpoch: rows[rows.length - 1].epoch
      };
    } else if (currentWinner === 'DOWN' && currentStreak > maxDownStreak.length) {
      maxDownStreak = {
        length: currentStreak,
        startEpoch: rows[rows.length - currentStreak].epoch,
        endEpoch: rows[rows.length - 1].epoch
      };
    }
  }

  // Temporal
  const roundsPerDay: { [day: number]: number } = {};
  rows.forEach(r => {
    const day = getDayOfMonth(r.start_ts);
    roundsPerDay[day] = (roundsPerDay[day] || 0) + 1;
  });

  const daysWithData = Object.keys(roundsPerDay).length;
  const avgRoundsPerDay = totalRounds / daysWithData;

  const dailyEntries = Object.entries(roundsPerDay).map(([day, rounds]) => ({
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    rounds
  }));

  const busiestDay = dailyEntries.reduce((max, d) => d.rounds > max.rounds ? d : max, dailyEntries[0]);
  const quietestDay = dailyEntries.reduce((min, d) => d.rounds < min.rounds ? d : min, dailyEntries[0]);

  return {
    month: monthName,
    dateRange: { start: startDate, end: endDate },
    totalRounds,
    outcomes: {
      upWins,
      downWins,
      draws,
      unknown,
      upWinRate: (upWins / totalRounds) * 100,
      downWinRate: (downWins / totalRounds) * 100,
      winDistribution,
    },
    betting: {
      totalVolumeBNB: totalVolume,
      averagePoolSizeBNB: avgPoolSize,
      medianPoolSizeBNB: medianPoolSize,
      largestPoolBNB: largestPool,
      smallestPoolBNB: smallestPool,
      averageBullPoolBNB: avgBullPool,
      averageBearPoolBNB: avgBearPool,
      dailyVolume,
    },
    poolBalance: {
      averageBullPercentage: avgBullPercent,
      averageBearPercentage: avgBearPercent,
      mostBalancedRound: {
        epoch: mostBalanced.epoch,
        bullPercent: mostBalanced.bullPercent,
        bearPercent: mostBalanced.bearPercent,
        date: mostBalanced.date
      },
      mostImbalancedRound: {
        epoch: mostImbalanced.epoch,
        bullPercent: mostImbalanced.bullPercent,
        bearPercent: mostImbalanced.bearPercent,
        date: mostImbalanced.date
      },
      imbalanceDistribution,
    },
    payouts: {
      averageUpPayout: avgUpPayout,
      averageDownPayout: avgDownPayout,
      medianUpPayout: medianUpPayout,
      medianDownPayout: medianDownPayout,
      highestPayout,
      lowestPayout,
      payoutsOver2x,
      payoutsOver5x,
      payoutsOver10x,
      payoutDistribution,
    },
    priceMovement: {
      averagePriceChangePercent: avgPriceChangePercent,
      medianPriceChangePercent: medianPriceChangePercent,
      largestUpMove: {
        epoch: largestUpMove.epoch,
        changePercent: largestUpMove.rawChangePercent,
        date: largestUpMove.date
      },
      largestDownMove: {
        epoch: largestDownMove.epoch,
        changePercent: largestDownMove.rawChangePercent,
        date: largestDownMove.date
      },
      volatilityScore,
      priceChangeDistribution,
    },
    streaks: {
      longestUpStreak: maxUpStreak,
      longestDownStreak: maxDownStreak,
      streakDistribution,
      totalStreaks,
    },
    temporal: {
      roundsPerDay,
      avgRoundsPerDay,
      busiestDay,
      quietestDay,
    },
  };
}

export function formatDetailedMonthStatistics(stats: DetailedMonthStats): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push(`        ${stats.month.toUpperCase()} - DETAILED ANALYSIS`);
  lines.push('═══════════════════════════════════════════════════════════════\n');

  // Overview
  lines.push('📋 OVERVIEW');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Total Rounds: ${stats.totalRounds.toLocaleString()}`);
  lines.push(`Date Range: ${stats.dateRange.start} to ${stats.dateRange.end}`);
  lines.push(`Average Rounds/Day: ${stats.temporal.avgRoundsPerDay.toFixed(1)}`);
  lines.push(`Busiest Day: ${stats.temporal.busiestDay.date} (${stats.temporal.busiestDay.rounds} rounds)`);
  lines.push(`Quietest Day: ${stats.temporal.quietestDay.date} (${stats.temporal.quietestDay.rounds} rounds)\n`);

  // Outcomes
  lines.push('🎯 OUTCOME ANALYSIS');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`UP Wins: ${stats.outcomes.upWins.toLocaleString()} (${stats.outcomes.upWinRate.toFixed(2)}%)`);
  lines.push(`DOWN Wins: ${stats.outcomes.downWins.toLocaleString()} (${stats.outcomes.downWinRate.toFixed(2)}%)`);
  lines.push(`Draws: ${stats.outcomes.draws} | Unknown: ${stats.outcomes.unknown}`);
  lines.push('');

  // Daily win distribution (sample)
  const winDistKeys = Object.keys(stats.outcomes.winDistribution).map(Number).sort((a, b) => a - b);
  if (winDistKeys.length > 0) {
    lines.push('Daily Win Distribution (first 7 days):');
    winDistKeys.slice(0, 7).forEach(day => {
      const dist = stats.outcomes.winDistribution[day];
      const total = dist.up + dist.down;
      const upPct = total > 0 ? ((dist.up / total) * 100).toFixed(1) : '0';
      lines.push(`  Day ${day}: UP ${dist.up} (${upPct}%) | DOWN ${dist.down}`);
    });
    lines.push('');
  }

  // Betting Volume
  lines.push('💰 BETTING VOLUME');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Total Volume: ${stats.betting.totalVolumeBNB.toLocaleString(undefined, { maximumFractionDigits: 2 })} BNB`);
  lines.push(`Average Pool: ${stats.betting.averagePoolSizeBNB.toFixed(2)} BNB`);
  lines.push(`Median Pool: ${stats.betting.medianPoolSizeBNB.toFixed(2)} BNB`);
  lines.push(`Largest Pool: ${stats.betting.largestPoolBNB.amount.toFixed(2)} BNB (epoch ${stats.betting.largestPoolBNB.epoch}, ${stats.betting.largestPoolBNB.date})`);
  lines.push(`Smallest Pool: ${stats.betting.smallestPoolBNB.amount.toFixed(2)} BNB (epoch ${stats.betting.smallestPoolBNB.epoch}, ${stats.betting.smallestPoolBNB.date})`);
  lines.push(`Average BULL Pool: ${stats.betting.averageBullPoolBNB.toFixed(2)} BNB`);
  lines.push(`Average BEAR Pool: ${stats.betting.averageBearPoolBNB.toFixed(2)} BNB\n`);

  // Pool Balance
  lines.push('⚖️  POOL BALANCE');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Average: BULL ${stats.poolBalance.averageBullPercentage.toFixed(2)}% | BEAR ${stats.poolBalance.averageBearPercentage.toFixed(2)}%`);
  lines.push(`Most Balanced: ${stats.poolBalance.mostBalancedRound.bullPercent.toFixed(2)}% / ${stats.poolBalance.mostBalancedRound.bearPercent.toFixed(2)}%`);
  lines.push(`  (epoch ${stats.poolBalance.mostBalancedRound.epoch}, ${stats.poolBalance.mostBalancedRound.date})`);
  lines.push(`Most Imbalanced: ${stats.poolBalance.mostImbalancedRound.bullPercent.toFixed(2)}% / ${stats.poolBalance.mostImbalancedRound.bearPercent.toFixed(2)}%`);
  lines.push(`  (epoch ${stats.poolBalance.mostImbalancedRound.epoch}, ${stats.poolBalance.mostImbalancedRound.date})`);
  lines.push('');
  lines.push('Imbalance Distribution:');
  lines.push(`  Balanced (<5% diff): ${stats.poolBalance.imbalanceDistribution.balanced} rounds (${((stats.poolBalance.imbalanceDistribution.balanced / stats.totalRounds) * 100).toFixed(1)}%)`);
  lines.push(`  Moderate (5-15%): ${stats.poolBalance.imbalanceDistribution.moderate} rounds (${((stats.poolBalance.imbalanceDistribution.moderate / stats.totalRounds) * 100).toFixed(1)}%)`);
  lines.push(`  High (>15%): ${stats.poolBalance.imbalanceDistribution.high} rounds (${((stats.poolBalance.imbalanceDistribution.high / stats.totalRounds) * 100).toFixed(1)}%)\n`);

  // Payouts
  lines.push('💸 PAYOUT ANALYSIS');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Average UP: ${stats.payouts.averageUpPayout.toFixed(3)}x (median: ${stats.payouts.medianUpPayout.toFixed(3)}x)`);
  lines.push(`Average DOWN: ${stats.payouts.averageDownPayout.toFixed(3)}x (median: ${stats.payouts.medianDownPayout.toFixed(3)}x)`);
  lines.push(`Highest: ${stats.payouts.highestPayout.multiple.toFixed(3)}x (${stats.payouts.highestPayout.winner}, epoch ${stats.payouts.highestPayout.epoch}, ${stats.payouts.highestPayout.date})`);
  lines.push(`Lowest: ${stats.payouts.lowestPayout.multiple.toFixed(3)}x (${stats.payouts.lowestPayout.winner}, epoch ${stats.payouts.lowestPayout.epoch}, ${stats.payouts.lowestPayout.date})`);
  lines.push('');
  lines.push('Payout Ranges:');
  lines.push(`  ≥2x: ${stats.payouts.payoutsOver2x} | ≥5x: ${stats.payouts.payoutsOver5x} | ≥10x: ${stats.payouts.payoutsOver10x}`);
  lines.push('');
  lines.push('Payout Distribution:');
  lines.push(`  <1.5x: ${stats.payouts.payoutDistribution.under1_5x} rounds`);
  lines.push(`  1.5-2x: ${stats.payouts.payoutDistribution.from1_5to2x} rounds`);
  lines.push(`  2-3x: ${stats.payouts.payoutDistribution.from2to3x} rounds`);
  lines.push(`  3-5x: ${stats.payouts.payoutDistribution.from3to5x} rounds`);
  lines.push(`  >5x: ${stats.payouts.payoutDistribution.over5x} rounds\n`);

  // Price Movement
  lines.push('📈 PRICE MOVEMENT');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Average Change: ${stats.priceMovement.averagePriceChangePercent >= 0 ? '+' : ''}${stats.priceMovement.averagePriceChangePercent.toFixed(4)}%`);
  lines.push(`Median Change: ${stats.priceMovement.medianPriceChangePercent >= 0 ? '+' : ''}${stats.priceMovement.medianPriceChangePercent.toFixed(4)}%`);
  lines.push(`Volatility Score: ${stats.priceMovement.volatilityScore.toFixed(4)}% (standard deviation)`);
  lines.push(`Largest UP: +${stats.priceMovement.largestUpMove.changePercent.toFixed(4)}% (epoch ${stats.priceMovement.largestUpMove.epoch}, ${stats.priceMovement.largestUpMove.date})`);
  lines.push(`Largest DOWN: ${stats.priceMovement.largestDownMove.changePercent.toFixed(4)}% (epoch ${stats.priceMovement.largestDownMove.epoch}, ${stats.priceMovement.largestDownMove.date})`);
  lines.push('');
  lines.push('Price Change Distribution:');
  lines.push(`  <0.1%: ${stats.priceMovement.priceChangeDistribution.under0_1} rounds (${((stats.priceMovement.priceChangeDistribution.under0_1 / stats.totalRounds) * 100).toFixed(1)}%)`);
  lines.push(`  0.1-0.3%: ${stats.priceMovement.priceChangeDistribution.from0_1to0_3} rounds (${((stats.priceMovement.priceChangeDistribution.from0_1to0_3 / stats.totalRounds) * 100).toFixed(1)}%)`);
  lines.push(`  0.3-0.5%: ${stats.priceMovement.priceChangeDistribution.from0_3to0_5} rounds (${((stats.priceMovement.priceChangeDistribution.from0_3to0_5 / stats.totalRounds) * 100).toFixed(1)}%)`);
  lines.push(`  >0.5%: ${stats.priceMovement.priceChangeDistribution.over0_5} rounds (${((stats.priceMovement.priceChangeDistribution.over0_5 / stats.totalRounds) * 100).toFixed(1)}%)\n`);

  // Streaks
  lines.push('📊 STREAK ANALYSIS');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Longest UP Streak: ${stats.streaks.longestUpStreak.length} rounds (epochs ${stats.streaks.longestUpStreak.startEpoch}-${stats.streaks.longestUpStreak.endEpoch})`);
  lines.push(`Longest DOWN Streak: ${stats.streaks.longestDownStreak.length} rounds (epochs ${stats.streaks.longestDownStreak.startEpoch}-${stats.streaks.longestDownStreak.endEpoch})`);
  lines.push(`Total Streaks: ${stats.streaks.totalStreaks}`);
  lines.push('');
  lines.push('Streak Length Distribution (top 10):');

  const sortedStreaks = Object.entries(stats.streaks.streakDistribution)
    .map(([length, count]) => ({ length: parseInt(length), count }))
    .sort((a, b) => a.length - b.length)
    .slice(0, 10);

  for (const { length, count } of sortedStreaks) {
    lines.push(`  ${length} rounds: ${count} times`);
  }

  lines.push('\n═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}
