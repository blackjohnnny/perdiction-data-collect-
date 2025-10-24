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

interface MonthlyStats {
  month: string; // YYYY-MM
  totalRounds: number;
  outcomes: {
    upWins: number;
    downWins: number;
    draws: number;
    unknown: number;
    upWinRate: number;
    downWinRate: number;
  };
  betting: {
    totalVolumeBNB: number;
    averagePoolSizeBNB: number;
    largestPoolBNB: { epoch: number; amount: number };
    smallestPoolBNB: { epoch: number; amount: number };
    averageBullPoolBNB: number;
    averageBearPoolBNB: number;
  };
  poolBalance: {
    averageBullPercentage: number;
    averageBearPercentage: number;
  };
  payouts: {
    averageUpPayout: number;
    averageDownPayout: number;
    highestPayout: { epoch: number; winner: string; multiple: number };
    lowestPayout: { epoch: number; winner: string; multiple: number };
    payoutsOver2x: number;
    payoutsOver5x: number;
    payoutsOver10x: number;
  };
  priceMovement: {
    averagePriceChangePercent: number;
    largestUpMovePercent: number;
    largestDownMovePercent: number;
  };
  streaks: {
    longestUpStreak: number;
    longestDownStreak: number;
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

function getMonthName(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  const date = new Date(parseInt(year), parseInt(month) - 1);
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function analyzeMonth(rounds: RoundRow[]): Omit<MonthlyStats, 'month'> {
  const totalRounds = rounds.length;

  // Outcomes
  const upWins = rounds.filter(r => r.winner === 'UP').length;
  const downWins = rounds.filter(r => r.winner === 'DOWN').length;
  const draws = rounds.filter(r => r.winner === 'DRAW').length;
  const unknown = rounds.filter(r => r.winner === 'UNKNOWN').length;

  // Betting volume
  const totalVolume = rounds.reduce((sum, r) => sum + weiToBNB(r.total_amount_wei || '0'), 0);
  const avgPoolSize = totalVolume / totalRounds;

  const poolSizes = rounds.map(r => ({
    epoch: r.epoch,
    amount: weiToBNB(r.total_amount_wei || '0')
  }));
  const largestPool = poolSizes.reduce((max, p) => p.amount > max.amount ? p : max, poolSizes[0]);
  const smallestPool = poolSizes.reduce((min, p) => p.amount < min.amount ? p : min, poolSizes[0]);

  const avgBullPool = rounds.reduce((sum, r) => sum + weiToBNB(r.bull_amount_wei || '0'), 0) / totalRounds;
  const avgBearPool = rounds.reduce((sum, r) => sum + weiToBNB(r.bear_amount_wei || '0'), 0) / totalRounds;

  // Pool balance
  const poolBalances = rounds.map(r => {
    const total = weiToBNB(r.total_amount_wei || '0');
    const bull = weiToBNB(r.bull_amount_wei || '0');
    const bear = weiToBNB(r.bear_amount_wei || '0');
    return {
      bullPercent: total > 0 ? (bull / total) * 100 : 0,
      bearPercent: total > 0 ? (bear / total) * 100 : 0,
    };
  });

  const avgBullPercent = poolBalances.reduce((sum, p) => sum + p.bullPercent, 0) / totalRounds;
  const avgBearPercent = poolBalances.reduce((sum, p) => sum + p.bearPercent, 0) / totalRounds;

  // Payouts
  const payouts = rounds
    .filter(r => r.winner_multiple !== null && r.winner_multiple !== '')
    .map(r => ({
      epoch: r.epoch,
      winner: r.winner,
      multiple: parseFloat(r.winner_multiple!),
    }));

  const upPayouts = payouts.filter(p => p.winner === 'UP');
  const downPayouts = payouts.filter(p => p.winner === 'DOWN');

  const avgUpPayout = upPayouts.length > 0
    ? upPayouts.reduce((sum, p) => sum + p.multiple, 0) / upPayouts.length
    : 0;
  const avgDownPayout = downPayouts.length > 0
    ? downPayouts.reduce((sum, p) => sum + p.multiple, 0) / downPayouts.length
    : 0;

  const highestPayout = payouts.length > 0
    ? payouts.reduce((max, p) => p.multiple > max.multiple ? p : max, payouts[0])
    : { epoch: 0, winner: 'N/A', multiple: 0 };
  const lowestPayout = payouts.length > 0
    ? payouts.reduce((min, p) => p.multiple < min.multiple ? p : min, payouts[0])
    : { epoch: 0, winner: 'N/A', multiple: 0 };

  const payoutsOver2x = payouts.filter(p => p.multiple >= 2).length;
  const payoutsOver5x = payouts.filter(p => p.multiple >= 5).length;
  const payoutsOver10x = payouts.filter(p => p.multiple >= 10).length;

  // Price movement
  const priceChanges = rounds.map(r => {
    const lockPrice = weiToBNB(r.lock_price || '0');
    const closePrice = weiToBNB(r.close_price || '0');
    const change = closePrice - lockPrice;
    const changePercent = lockPrice > 0 ? (change / lockPrice) * 100 : 0;
    return changePercent;
  });

  const avgPriceChangePercent = priceChanges.reduce((sum, p) => sum + p, 0) / totalRounds;
  const largestUpMovePercent = Math.max(...priceChanges);
  const largestDownMovePercent = Math.min(...priceChanges);

  // Streaks
  let currentStreak = 0;
  let currentWinner = '';
  let maxUpStreak = 0;
  let maxDownStreak = 0;

  for (let i = 0; i < rounds.length; i++) {
    const winner = rounds[i].winner;

    if (winner === currentWinner && (winner === 'UP' || winner === 'DOWN')) {
      currentStreak++;
    } else {
      if (currentStreak > 0) {
        if (currentWinner === 'UP' && currentStreak > maxUpStreak) {
          maxUpStreak = currentStreak;
        } else if (currentWinner === 'DOWN' && currentStreak > maxDownStreak) {
          maxDownStreak = currentStreak;
        }
      }
      currentWinner = winner;
      currentStreak = 1;
    }
  }

  // Don't forget the last streak
  if (currentStreak > 0) {
    if (currentWinner === 'UP' && currentStreak > maxUpStreak) {
      maxUpStreak = currentStreak;
    } else if (currentWinner === 'DOWN' && currentStreak > maxDownStreak) {
      maxDownStreak = currentStreak;
    }
  }

  return {
    totalRounds,
    outcomes: {
      upWins,
      downWins,
      draws,
      unknown,
      upWinRate: (upWins / totalRounds) * 100,
      downWinRate: (downWins / totalRounds) * 100,
    },
    betting: {
      totalVolumeBNB: totalVolume,
      averagePoolSizeBNB: avgPoolSize,
      largestPoolBNB: largestPool,
      smallestPoolBNB: smallestPool,
      averageBullPoolBNB: avgBullPool,
      averageBearPoolBNB: avgBearPool,
    },
    poolBalance: {
      averageBullPercentage: avgBullPercent,
      averageBearPercentage: avgBearPercent,
    },
    payouts: {
      averageUpPayout: avgUpPayout,
      averageDownPayout: avgDownPayout,
      highestPayout,
      lowestPayout,
      payoutsOver2x,
      payoutsOver5x,
      payoutsOver10x,
    },
    priceMovement: {
      averagePriceChangePercent: avgPriceChangePercent,
      largestUpMovePercent,
      largestDownMovePercent,
    },
    streaks: {
      longestUpStreak: maxUpStreak,
      longestDownStreak: maxDownStreak,
    },
  };
}

export async function analyzeMonthlyData(): Promise<MonthlyStats[]> {
  const db = await getDb();

  const allRounds = db.exec('SELECT * FROM rounds ORDER BY start_ts ASC');
  if (allRounds.length === 0 || !allRounds[0].values.length) {
    throw new Error('No data found in database');
  }

  const columns = allRounds[0].columns;
  const rows: RoundRow[] = allRounds[0].values.map((row) => {
    const obj: any = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj as RoundRow;
  });

  // Group by month
  const monthGroups = new Map<string, RoundRow[]>();

  for (const round of rows) {
    const monthKey = getMonthKey(round.start_ts);
    if (!monthGroups.has(monthKey)) {
      monthGroups.set(monthKey, []);
    }
    monthGroups.get(monthKey)!.push(round);
  }

  // Analyze each month
  const monthlyStats: MonthlyStats[] = [];

  for (const [monthKey, rounds] of Array.from(monthGroups.entries()).sort()) {
    const stats = analyzeMonth(rounds);
    monthlyStats.push({
      month: monthKey,
      ...stats,
    });
  }

  return monthlyStats;
}

export function formatMonthlyStatistics(monthlyStats: MonthlyStats[]): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('      PANCAKESWAP PREDICTION V2 - MONTHLY ANALYSIS');
  lines.push('═══════════════════════════════════════════════════════════════\n');

  for (const stats of monthlyStats) {
    const monthName = getMonthName(stats.month);

    lines.push(`\n${'▀'.repeat(63)}`);
    lines.push(`📅 ${monthName.toUpperCase()}`);
    lines.push('─'.repeat(63));

    lines.push(`Total Rounds: ${stats.totalRounds.toLocaleString()}`);
    lines.push('');

    // Outcomes
    lines.push('🎯 Outcomes:');
    lines.push(`  UP: ${stats.outcomes.upWins.toLocaleString()} (${stats.outcomes.upWinRate.toFixed(2)}%)  |  DOWN: ${stats.outcomes.downWins.toLocaleString()} (${stats.outcomes.downWinRate.toFixed(2)}%)  |  Draws: ${stats.outcomes.draws}`);
    lines.push('');

    // Betting
    lines.push('💰 Betting Volume:');
    lines.push(`  Total: ${stats.betting.totalVolumeBNB.toLocaleString(undefined, { maximumFractionDigits: 2 })} BNB  |  Avg Pool: ${stats.betting.averagePoolSizeBNB.toFixed(2)} BNB`);
    lines.push(`  Largest Pool: ${stats.betting.largestPoolBNB.amount.toFixed(2)} BNB (epoch ${stats.betting.largestPoolBNB.epoch})`);
    lines.push(`  Avg BULL: ${stats.betting.averageBullPoolBNB.toFixed(2)} BNB  |  Avg BEAR: ${stats.betting.averageBearPoolBNB.toFixed(2)} BNB`);
    lines.push('');

    // Pool Balance
    lines.push('⚖️  Pool Balance:');
    lines.push(`  BULL: ${stats.poolBalance.averageBullPercentage.toFixed(2)}%  |  BEAR: ${stats.poolBalance.averageBearPercentage.toFixed(2)}%`);
    lines.push('');

    // Payouts
    lines.push('💸 Payouts:');
    lines.push(`  Avg UP: ${stats.payouts.averageUpPayout.toFixed(3)}x  |  Avg DOWN: ${stats.payouts.averageDownPayout.toFixed(3)}x`);
    lines.push(`  Highest: ${stats.payouts.highestPayout.multiple.toFixed(3)}x (${stats.payouts.highestPayout.winner}, epoch ${stats.payouts.highestPayout.epoch})`);
    lines.push(`  Payouts ≥2x: ${stats.payouts.payoutsOver2x}  |  ≥5x: ${stats.payouts.payoutsOver5x}  |  ≥10x: ${stats.payouts.payoutsOver10x}`);
    lines.push('');

    // Price Movement
    lines.push('📈 Price Movement:');
    lines.push(`  Avg Change: ${stats.priceMovement.averagePriceChangePercent >= 0 ? '+' : ''}${stats.priceMovement.averagePriceChangePercent.toFixed(4)}%`);
    lines.push(`  Largest UP: +${stats.priceMovement.largestUpMovePercent.toFixed(4)}%  |  Largest DOWN: ${stats.priceMovement.largestDownMovePercent.toFixed(4)}%`);
    lines.push('');

    // Streaks
    lines.push('📊 Streaks:');
    lines.push(`  Longest UP: ${stats.streaks.longestUpStreak} rounds  |  Longest DOWN: ${stats.streaks.longestDownStreak} rounds`);
  }

  lines.push(`\n${'═'.repeat(63)}`);
  lines.push(`Total Months Analyzed: ${monthlyStats.length}`);
  lines.push('═'.repeat(63));

  return lines.join('\n');
}
