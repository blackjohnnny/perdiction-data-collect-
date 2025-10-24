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

interface Statistics {
  general: {
    totalRounds: number;
    dateRange: { earliest: string; latest: string };
    averageRoundDuration: number;
  };
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
    mostBalancedRound: { epoch: number; bullPercent: number; bearPercent: number };
    mostImbalancedRound: { epoch: number; bullPercent: number; bearPercent: number };
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
    averagePriceChange: number;
    averagePriceChangePercent: number;
    largestUpMove: { epoch: number; change: number; changePercent: number };
    largestDownMove: { epoch: number; change: number; changePercent: number };
  };
  trends: {
    consecutiveUps: { max: number; epochs: string };
    consecutiveDowns: { max: number; epochs: string };
    winStreakDistribution: { [length: number]: number };
  };
}

function weiToBNB(wei: string): number {
  return parseFloat(wei) / 1e18;
}

export async function analyzeData(): Promise<Statistics> {
  const db = await getDb();

  const allRounds = db.exec('SELECT * FROM rounds ORDER BY epoch ASC');
  if (allRounds.length === 0 || !allRounds[0].values.length) {
    throw new Error('No data found in database');
  }

  const columns = allRounds[0].columns;
  const rows: RoundRow[] = allRounds[0].values.map((row) => {
    const obj: any = {};
    columns.forEach((col, idx) => {
      const value = row[idx];
      // Convert string values back to proper types
      if (typeof value === 'string' && !isNaN(Number(value)) && value !== '') {
        obj[col] = value; // Keep as string for wei amounts
      } else {
        obj[col] = value;
      }
    });
    return obj as RoundRow;
  });

  // General statistics
  const totalRounds = rows.length;
  const earliest = new Date(rows[0].start_ts * 1000).toISOString();
  const latest = new Date(rows[rows.length - 1].close_ts * 1000).toISOString();
  const avgDuration = rows.reduce((sum, r) => sum + (r.close_ts - r.start_ts), 0) / totalRounds;

  // Outcome statistics
  const upWins = rows.filter(r => r.winner === 'UP').length;
  const downWins = rows.filter(r => r.winner === 'DOWN').length;
  const draws = rows.filter(r => r.winner === 'DRAW').length;
  const unknown = rows.filter(r => r.winner === 'UNKNOWN').length;

  // Betting volume statistics
  const totalVolume = rows.reduce((sum, r) => {
    const amount = r.total_amount_wei || '0';
    return sum + weiToBNB(amount);
  }, 0);
  const avgPoolSize = totalVolume / totalRounds;

  const poolSizes = rows.map(r => ({
    epoch: r.epoch,
    amount: weiToBNB(r.total_amount_wei || '0')
  }));
  const largestPool = poolSizes.reduce((max, p) => p.amount > max.amount ? p : max, poolSizes[0]);
  const smallestPool = poolSizes.reduce((min, p) => p.amount < min.amount ? p : min, poolSizes[0]);

  const avgBullPool = rows.reduce((sum, r) => sum + weiToBNB(r.bull_amount_wei || '0'), 0) / totalRounds;
  const avgBearPool = rows.reduce((sum, r) => sum + weiToBNB(r.bear_amount_wei || '0'), 0) / totalRounds;

  // Pool balance statistics
  const poolBalances = rows.map(r => {
    const total = weiToBNB(r.total_amount_wei || '0');
    const bull = weiToBNB(r.bull_amount_wei || '0');
    const bear = weiToBNB(r.bear_amount_wei || '0');
    return {
      epoch: r.epoch,
      bullPercent: total > 0 ? (bull / total) * 100 : 0,
      bearPercent: total > 0 ? (bear / total) * 100 : 0,
      imbalance: total > 0 ? Math.abs(bull - bear) / total : 0,
    };
  });

  const avgBullPercent = poolBalances.reduce((sum, p) => sum + p.bullPercent, 0) / totalRounds;
  const avgBearPercent = poolBalances.reduce((sum, p) => sum + p.bearPercent, 0) / totalRounds;

  const mostBalanced = poolBalances.reduce((min, p) => p.imbalance < min.imbalance ? p : min, poolBalances[0]);
  const mostImbalanced = poolBalances.reduce((max, p) => p.imbalance > max.imbalance ? p : max, poolBalances[0]);

  // Payout statistics
  const payouts = rows
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

  const highestPayout = payouts.reduce((max, p) => p.multiple > max.multiple ? p : max, payouts[0]);
  const lowestPayout = payouts.reduce((min, p) => p.multiple < min.multiple ? p : min, payouts[0]);

  const payoutsOver2x = payouts.filter(p => p.multiple >= 2).length;
  const payoutsOver5x = payouts.filter(p => p.multiple >= 5).length;
  const payoutsOver10x = payouts.filter(p => p.multiple >= 10).length;

  // Price movement statistics
  const priceChanges = rows.map(r => {
    const lockPrice = weiToBNB(r.lock_price || '0');
    const closePrice = weiToBNB(r.close_price || '0');
    const change = closePrice - lockPrice;
    const changePercent = lockPrice > 0 ? (change / lockPrice) * 100 : 0;
    return { epoch: r.epoch, change, changePercent };
  });

  const avgPriceChange = priceChanges.reduce((sum, p) => sum + p.change, 0) / totalRounds;
  const avgPriceChangePercent = priceChanges.reduce((sum, p) => sum + p.changePercent, 0) / totalRounds;

  const largestUpMove = priceChanges.reduce((max, p) => p.change > max.change ? p : max, priceChanges[0]);
  const largestDownMove = priceChanges.reduce((min, p) => p.change < min.change ? p : min, priceChanges[0]);

  // Trend analysis - consecutive wins
  let currentStreak = 0;
  let currentWinner = '';
  let maxUpStreak = 0;
  let maxDownStreak = 0;
  let upStreakEpochs = '';
  let downStreakEpochs = '';
  const streakDistribution: { [length: number]: number } = {};

  for (let i = 0; i < rows.length; i++) {
    const winner = rows[i].winner;

    if (winner === currentWinner && (winner === 'UP' || winner === 'DOWN')) {
      currentStreak++;
    } else {
      // Record previous streak
      if (currentStreak > 0) {
        streakDistribution[currentStreak] = (streakDistribution[currentStreak] || 0) + 1;

        if (currentWinner === 'UP' && currentStreak > maxUpStreak) {
          maxUpStreak = currentStreak;
          upStreakEpochs = `${rows[i - currentStreak].epoch}-${rows[i - 1].epoch}`;
        } else if (currentWinner === 'DOWN' && currentStreak > maxDownStreak) {
          maxDownStreak = currentStreak;
          downStreakEpochs = `${rows[i - currentStreak].epoch}-${rows[i - 1].epoch}`;
        }
      }

      currentWinner = winner;
      currentStreak = 1;
    }
  }

  // Don't forget the last streak
  if (currentStreak > 0) {
    streakDistribution[currentStreak] = (streakDistribution[currentStreak] || 0) + 1;

    if (currentWinner === 'UP' && currentStreak > maxUpStreak) {
      maxUpStreak = currentStreak;
      upStreakEpochs = `${rows[rows.length - currentStreak].epoch}-${rows[rows.length - 1].epoch}`;
    } else if (currentWinner === 'DOWN' && currentStreak > maxDownStreak) {
      maxDownStreak = currentStreak;
      downStreakEpochs = `${rows[rows.length - currentStreak].epoch}-${rows[rows.length - 1].epoch}`;
    }
  }

  return {
    general: {
      totalRounds,
      dateRange: { earliest, latest },
      averageRoundDuration: avgDuration,
    },
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
      mostBalancedRound: {
        epoch: mostBalanced.epoch,
        bullPercent: mostBalanced.bullPercent,
        bearPercent: mostBalanced.bearPercent,
      },
      mostImbalancedRound: {
        epoch: mostImbalanced.epoch,
        bullPercent: mostImbalanced.bullPercent,
        bearPercent: mostImbalanced.bearPercent,
      },
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
      averagePriceChange: avgPriceChange,
      averagePriceChangePercent: avgPriceChangePercent,
      largestUpMove,
      largestDownMove,
    },
    trends: {
      consecutiveUps: { max: maxUpStreak, epochs: upStreakEpochs },
      consecutiveDowns: { max: maxDownStreak, epochs: downStreakEpochs },
      winStreakDistribution: streakDistribution,
    },
  };
}

export function formatStatistics(stats: Statistics): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('           PANCAKESWAP PREDICTION V2 DATA ANALYSIS');
  lines.push('═══════════════════════════════════════════════════════════════\n');

  // General
  lines.push('📊 GENERAL STATISTICS');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Total Rounds Analyzed: ${stats.general.totalRounds.toLocaleString()}`);
  lines.push(`Date Range: ${stats.general.dateRange.earliest.split('T')[0]} to ${stats.general.dateRange.latest.split('T')[0]}`);
  lines.push(`Average Round Duration: ${Math.round(stats.general.averageRoundDuration)} seconds (~${(stats.general.averageRoundDuration / 60).toFixed(1)} minutes)\n`);

  // Outcomes
  lines.push('🎯 OUTCOME DISTRIBUTION');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`UP Wins: ${stats.outcomes.upWins.toLocaleString()} (${stats.outcomes.upWinRate.toFixed(2)}%)`);
  lines.push(`DOWN Wins: ${stats.outcomes.downWins.toLocaleString()} (${stats.outcomes.downWinRate.toFixed(2)}%)`);
  lines.push(`Draws: ${stats.outcomes.draws.toLocaleString()}`);
  lines.push(`Unknown: ${stats.outcomes.unknown.toLocaleString()}\n`);

  // Betting Volume
  lines.push('💰 BETTING VOLUME');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Total Volume: ${stats.betting.totalVolumeBNB.toLocaleString(undefined, { maximumFractionDigits: 2 })} BNB`);
  lines.push(`Average Pool Size: ${stats.betting.averagePoolSizeBNB.toFixed(2)} BNB`);
  lines.push(`Largest Pool: ${stats.betting.largestPoolBNB.amount.toFixed(2)} BNB (epoch ${stats.betting.largestPoolBNB.epoch})`);
  lines.push(`Smallest Pool: ${stats.betting.smallestPoolBNB.amount.toFixed(2)} BNB (epoch ${stats.betting.smallestPoolBNB.epoch})`);
  lines.push(`Average BULL Pool: ${stats.betting.averageBullPoolBNB.toFixed(2)} BNB`);
  lines.push(`Average BEAR Pool: ${stats.betting.averageBearPoolBNB.toFixed(2)} BNB\n`);

  // Pool Balance
  lines.push('⚖️  POOL BALANCE');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Average BULL: ${stats.poolBalance.averageBullPercentage.toFixed(2)}%`);
  lines.push(`Average BEAR: ${stats.poolBalance.averageBearPercentage.toFixed(2)}%`);
  lines.push(`Most Balanced: ${stats.poolBalance.mostBalancedRound.bullPercent.toFixed(2)}% / ${stats.poolBalance.mostBalancedRound.bearPercent.toFixed(2)}% (epoch ${stats.poolBalance.mostBalancedRound.epoch})`);
  lines.push(`Most Imbalanced: ${stats.poolBalance.mostImbalancedRound.bullPercent.toFixed(2)}% / ${stats.poolBalance.mostImbalancedRound.bearPercent.toFixed(2)}% (epoch ${stats.poolBalance.mostImbalancedRound.epoch})\n`);

  // Payouts
  lines.push('💸 PAYOUT ANALYSIS');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Average UP Payout: ${stats.payouts.averageUpPayout.toFixed(3)}x`);
  lines.push(`Average DOWN Payout: ${stats.payouts.averageDownPayout.toFixed(3)}x`);
  lines.push(`Highest Payout: ${stats.payouts.highestPayout.multiple.toFixed(3)}x (${stats.payouts.highestPayout.winner}, epoch ${stats.payouts.highestPayout.epoch})`);
  lines.push(`Lowest Payout: ${stats.payouts.lowestPayout.multiple.toFixed(3)}x (${stats.payouts.lowestPayout.winner}, epoch ${stats.payouts.lowestPayout.epoch})`);
  lines.push(`Payouts ≥2x: ${stats.payouts.payoutsOver2x.toLocaleString()}`);
  lines.push(`Payouts ≥5x: ${stats.payouts.payoutsOver5x.toLocaleString()}`);
  lines.push(`Payouts ≥10x: ${stats.payouts.payoutsOver10x.toLocaleString()}\n`);

  // Price Movement
  lines.push('📈 PRICE MOVEMENT');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Average Price Change: ${stats.priceMovement.averagePriceChange >= 0 ? '+' : ''}${stats.priceMovement.averagePriceChange.toFixed(2)} BNB (${stats.priceMovement.averagePriceChangePercent >= 0 ? '+' : ''}${stats.priceMovement.averagePriceChangePercent.toFixed(4)}%)`);
  lines.push(`Largest UP Move: +${stats.priceMovement.largestUpMove.change.toFixed(2)} BNB (+${stats.priceMovement.largestUpMove.changePercent.toFixed(4)}%) epoch ${stats.priceMovement.largestUpMove.epoch}`);
  lines.push(`Largest DOWN Move: ${stats.priceMovement.largestDownMove.change.toFixed(2)} BNB (${stats.priceMovement.largestDownMove.changePercent.toFixed(4)}%) epoch ${stats.priceMovement.largestDownMove.epoch}\n`);

  // Trends
  lines.push('📊 STREAK ANALYSIS');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Longest UP Streak: ${stats.trends.consecutiveUps.max} rounds (epochs ${stats.trends.consecutiveUps.epochs})`);
  lines.push(`Longest DOWN Streak: ${stats.trends.consecutiveDowns.max} rounds (epochs ${stats.trends.consecutiveDowns.epochs})`);
  lines.push('\nStreak Distribution (consecutive same-outcome rounds):');

  const sortedStreaks = Object.entries(stats.trends.winStreakDistribution)
    .map(([length, count]) => ({ length: parseInt(length), count }))
    .sort((a, b) => a.length - b.length);

  for (const { length, count } of sortedStreaks.slice(0, 10)) {
    lines.push(`  ${length} rounds: ${count} times`);
  }

  lines.push('\n═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}
