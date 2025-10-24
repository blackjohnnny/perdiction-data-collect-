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

interface HourlyStats {
  hour: number;
  totalRounds: number;
  averagePoolBNB: number;
  totalVolumeBNB: number;
  upWins: number;
  downWins: number;
  upWinRate: number;
  averageUpPayout: number;
  averageDownPayout: number;
}

interface ProfitabilityStrategy {
  strategy: string;
  totalRounds: number;
  wins: number;
  losses: number;
  winRate: number;
  totalWagered: number; // in BNB (assuming 1 BNB per bet)
  totalReturned: number; // in BNB
  netProfit: number; // in BNB
  roi: number; // return on investment %
  averageReturn: number; // average return per bet
  bestStreak: number;
  worstStreak: number;
}

interface TimeAndProfitabilityStats {
  hourly: HourlyStats[];
  bestHours: {
    highestVolume: { hour: number; volumeBNB: number };
    lowestVolume: { hour: number; volumeBNB: number };
    bestUpWinRate: { hour: number; winRate: number };
    bestDownWinRate: { hour: number; winRate: number };
  };
  strategies: {
    alwaysUp: ProfitabilityStrategy;
    alwaysDown: ProfitabilityStrategy;
    comparison: {
      betterStrategy: string;
      profitDifference: number;
    };
  };
  timeBasedRecommendations: string[];
}

function weiToBNB(wei: string): number {
  return parseFloat(wei) / 1e18;
}

function getHourOfDay(timestamp: number): number {
  const date = new Date(timestamp * 1000);
  return date.getUTCHours();
}

function calculateProfitability(rounds: RoundRow[], betOn: 'UP' | 'DOWN'): ProfitabilityStrategy {
  const betAmount = 1; // 1 BNB per bet
  let totalWagered = 0;
  let totalReturned = 0;
  let wins = 0;
  let losses = 0;

  let currentStreak = 0;
  let bestStreak = 0;
  let worstStreak = 0;
  let isWinStreak = true;

  for (const round of rounds) {
    // Skip rounds without payouts
    if (!round.winner_multiple || round.winner === 'UNKNOWN' || round.winner === 'DRAW') {
      continue;
    }

    totalWagered += betAmount;

    const didWin = round.winner === betOn;
    const payout = parseFloat(round.winner_multiple);

    if (didWin) {
      totalReturned += betAmount * payout;
      wins++;

      if (isWinStreak) {
        currentStreak++;
      } else {
        isWinStreak = true;
        currentStreak = 1;
      }

      if (currentStreak > bestStreak) {
        bestStreak = currentStreak;
      }
    } else {
      losses++;

      if (!isWinStreak) {
        currentStreak++;
      } else {
        isWinStreak = false;
        currentStreak = 1;
      }

      if (currentStreak > worstStreak) {
        worstStreak = currentStreak;
      }
    }
  }

  const totalRounds = wins + losses;
  const netProfit = totalReturned - totalWagered;
  const winRate = totalRounds > 0 ? (wins / totalRounds) * 100 : 0;
  const roi = totalWagered > 0 ? (netProfit / totalWagered) * 100 : 0;
  const averageReturn = totalRounds > 0 ? totalReturned / totalRounds : 0;

  return {
    strategy: `Always Bet ${betOn}`,
    totalRounds,
    wins,
    losses,
    winRate,
    totalWagered,
    totalReturned,
    netProfit,
    roi,
    averageReturn,
    bestStreak,
    worstStreak,
  };
}

export async function analyzeTimeAndProfitability(): Promise<TimeAndProfitabilityStats> {
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

  // Group by hour
  const hourlyData = new Map<number, RoundRow[]>();
  for (let hour = 0; hour < 24; hour++) {
    hourlyData.set(hour, []);
  }

  for (const round of rows) {
    const hour = getHourOfDay(round.start_ts);
    hourlyData.get(hour)!.push(round);
  }

  // Calculate hourly stats
  const hourlyStats: HourlyStats[] = [];

  for (let hour = 0; hour < 24; hour++) {
    const roundsInHour = hourlyData.get(hour)!;

    if (roundsInHour.length === 0) {
      hourlyStats.push({
        hour,
        totalRounds: 0,
        averagePoolBNB: 0,
        totalVolumeBNB: 0,
        upWins: 0,
        downWins: 0,
        upWinRate: 0,
        averageUpPayout: 0,
        averageDownPayout: 0,
      });
      continue;
    }

    const totalRounds = roundsInHour.length;
    const totalVolume = roundsInHour.reduce((sum, r) => sum + weiToBNB(r.total_amount_wei || '0'), 0);
    const averagePool = totalVolume / totalRounds;

    const upWins = roundsInHour.filter(r => r.winner === 'UP').length;
    const downWins = roundsInHour.filter(r => r.winner === 'DOWN').length;
    const upWinRate = totalRounds > 0 ? (upWins / totalRounds) * 100 : 0;

    const upPayouts = roundsInHour
      .filter(r => r.winner === 'UP' && r.winner_multiple)
      .map(r => parseFloat(r.winner_multiple!));
    const downPayouts = roundsInHour
      .filter(r => r.winner === 'DOWN' && r.winner_multiple)
      .map(r => parseFloat(r.winner_multiple!));

    const avgUpPayout = upPayouts.length > 0
      ? upPayouts.reduce((sum, p) => sum + p, 0) / upPayouts.length
      : 0;
    const avgDownPayout = downPayouts.length > 0
      ? downPayouts.reduce((sum, p) => sum + p, 0) / downPayouts.length
      : 0;

    hourlyStats.push({
      hour,
      totalRounds,
      averagePoolBNB: averagePool,
      totalVolumeBNB: totalVolume,
      upWins,
      downWins,
      upWinRate,
      averageUpPayout: avgUpPayout,
      averageDownPayout: avgDownPayout,
    });
  }

  // Find best/worst hours
  const hoursWithData = hourlyStats.filter(h => h.totalRounds > 0);

  const highestVolume = hoursWithData.reduce((max, h) =>
    h.totalVolumeBNB > max.totalVolumeBNB ? h : max, hoursWithData[0]);
  const lowestVolume = hoursWithData.reduce((min, h) =>
    h.totalVolumeBNB < min.totalVolumeBNB ? h : min, hoursWithData[0]);
  const bestUpWinRate = hoursWithData.reduce((max, h) =>
    h.upWinRate > max.upWinRate ? h : max, hoursWithData[0]);
  const bestDownWinRate = hoursWithData.reduce((max, h) =>
    (100 - h.upWinRate) > (100 - max.upWinRate) ? h : max, hoursWithData[0]);

  // Calculate profitability strategies
  const alwaysUpStrategy = calculateProfitability(rows, 'UP');
  const alwaysDownStrategy = calculateProfitability(rows, 'DOWN');

  const betterStrategy = alwaysUpStrategy.netProfit > alwaysDownStrategy.netProfit
    ? 'Always UP'
    : 'Always DOWN';
  const profitDifference = Math.abs(alwaysUpStrategy.netProfit - alwaysDownStrategy.netProfit);

  // Generate recommendations
  const recommendations: string[] = [];

  if (highestVolume.totalVolumeBNB > lowestVolume.totalVolumeBNB * 1.5) {
    recommendations.push(
      `Peak trading hours: ${highestVolume.hour}:00-${(highestVolume.hour + 1) % 24}:00 UTC (${highestVolume.totalVolumeBNB.toFixed(2)} BNB avg)`
    );
    recommendations.push(
      `Quietest hours: ${lowestVolume.hour}:00-${(lowestVolume.hour + 1) % 24}:00 UTC (${lowestVolume.totalVolumeBNB.toFixed(2)} BNB avg)`
    );
  }

  if (bestUpWinRate.upWinRate > 52) {
    recommendations.push(
      `Best UP hours: ${bestUpWinRate.hour}:00-${(bestUpWinRate.hour + 1) % 24}:00 UTC (${bestUpWinRate.upWinRate.toFixed(1)}% win rate)`
    );
  }

  if ((100 - bestDownWinRate.upWinRate) > 52) {
    recommendations.push(
      `Best DOWN hours: ${bestDownWinRate.hour}:00-${(bestDownWinRate.hour + 1) % 24}:00 UTC (${(100 - bestDownWinRate.upWinRate).toFixed(1)}% win rate)`
    );
  }

  if (alwaysUpStrategy.roi < 0 && alwaysDownStrategy.roi < 0) {
    recommendations.push(
      'WARNING: Both strategies are unprofitable over the analyzed period due to house edge'
    );
  }

  return {
    hourly: hourlyStats,
    bestHours: {
      highestVolume: { hour: highestVolume.hour, volumeBNB: highestVolume.totalVolumeBNB },
      lowestVolume: { hour: lowestVolume.hour, volumeBNB: lowestVolume.totalVolumeBNB },
      bestUpWinRate: { hour: bestUpWinRate.hour, winRate: bestUpWinRate.upWinRate },
      bestDownWinRate: { hour: bestDownWinRate.hour, winRate: 100 - bestDownWinRate.upWinRate },
    },
    strategies: {
      alwaysUp: alwaysUpStrategy,
      alwaysDown: alwaysDownStrategy,
      comparison: {
        betterStrategy,
        profitDifference,
      },
    },
    timeBasedRecommendations: recommendations,
  };
}

export function formatTimeAndProfitability(stats: TimeAndProfitabilityStats): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('    TIME-OF-DAY ANALYSIS & BETTING PROFITABILITY');
  lines.push('═══════════════════════════════════════════════════════════════\n');

  // Hourly breakdown
  lines.push('⏰ HOURLY ANALYSIS (UTC)');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push('Hour | Rounds | Avg Pool | Total Vol | UP%  | DOWN% | Avg UP  | Avg DOWN');
  lines.push('     |        | (BNB)    | (BNB)     |      |       | Payout  | Payout');
  lines.push('─────────────────────────────────────────────────────────────');

  for (const hour of stats.hourly) {
    if (hour.totalRounds === 0) continue;

    const hourStr = String(hour.hour).padStart(2, '0') + ':00';
    const rounds = String(hour.totalRounds).padStart(6);
    const avgPool = hour.averagePoolBNB.toFixed(2).padStart(8);
    const totalVol = hour.totalVolumeBNB.toFixed(0).padStart(9);
    const upPct = hour.upWinRate.toFixed(1).padStart(5);
    const downPct = (100 - hour.upWinRate).toFixed(1).padStart(6);
    const upPayout = hour.averageUpPayout > 0 ? hour.averageUpPayout.toFixed(3) : 'N/A';
    const downPayout = hour.averageDownPayout > 0 ? hour.averageDownPayout.toFixed(3) : 'N/A';

    lines.push(`${hourStr} |${rounds} |${avgPool} |${totalVol} | ${upPct} | ${downPct} | ${upPayout.padStart(7)} | ${downPayout.padStart(8)}`);
  }

  lines.push('');

  // Best hours
  lines.push('🏆 PEAK INSIGHTS');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Highest Volume Hour: ${String(stats.bestHours.highestVolume.hour).padStart(2, '0')}:00 UTC (${stats.bestHours.highestVolume.volumeBNB.toFixed(2)} BNB)`);
  lines.push(`Lowest Volume Hour:  ${String(stats.bestHours.lowestVolume.hour).padStart(2, '0')}:00 UTC (${stats.bestHours.lowestVolume.volumeBNB.toFixed(2)} BNB)`);
  lines.push(`Best UP Win Rate:    ${String(stats.bestHours.bestUpWinRate.hour).padStart(2, '0')}:00 UTC (${stats.bestHours.bestUpWinRate.winRate.toFixed(2)}%)`);
  lines.push(`Best DOWN Win Rate:  ${String(stats.bestHours.bestDownWinRate.hour).padStart(2, '0')}:00 UTC (${stats.bestHours.bestDownWinRate.winRate.toFixed(2)}%)\n`);

  // Profitability analysis
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('              BETTING STRATEGY PROFITABILITY');
  lines.push('═══════════════════════════════════════════════════════════════\n');

  // Always UP
  const upStrat = stats.strategies.alwaysUp;
  lines.push('📈 STRATEGY: ALWAYS BET UP');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Total Rounds Bet:    ${upStrat.totalRounds.toLocaleString()}`);
  lines.push(`Wins / Losses:       ${upStrat.wins.toLocaleString()} / ${upStrat.losses.toLocaleString()}`);
  lines.push(`Win Rate:            ${upStrat.winRate.toFixed(2)}%`);
  lines.push(`Total Wagered:       ${upStrat.totalWagered.toLocaleString()} BNB (1 BNB per bet)`);
  lines.push(`Total Returned:      ${upStrat.totalReturned.toFixed(2)} BNB`);
  lines.push(`Net Profit/Loss:     ${upStrat.netProfit >= 0 ? '+' : ''}${upStrat.netProfit.toFixed(2)} BNB`);
  lines.push(`ROI:                 ${upStrat.roi >= 0 ? '+' : ''}${upStrat.roi.toFixed(2)}%`);
  lines.push(`Average Return:      ${upStrat.averageReturn.toFixed(3)} BNB per bet`);
  lines.push(`Best Win Streak:     ${upStrat.bestStreak} rounds`);
  lines.push(`Worst Loss Streak:   ${upStrat.worstStreak} rounds\n`);

  // Always DOWN
  const downStrat = stats.strategies.alwaysDown;
  lines.push('📉 STRATEGY: ALWAYS BET DOWN');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Total Rounds Bet:    ${downStrat.totalRounds.toLocaleString()}`);
  lines.push(`Wins / Losses:       ${downStrat.wins.toLocaleString()} / ${downStrat.losses.toLocaleString()}`);
  lines.push(`Win Rate:            ${downStrat.winRate.toFixed(2)}%`);
  lines.push(`Total Wagered:       ${downStrat.totalWagered.toLocaleString()} BNB (1 BNB per bet)`);
  lines.push(`Total Returned:      ${downStrat.totalReturned.toFixed(2)} BNB`);
  lines.push(`Net Profit/Loss:     ${downStrat.netProfit >= 0 ? '+' : ''}${downStrat.netProfit.toFixed(2)} BNB`);
  lines.push(`ROI:                 ${downStrat.roi >= 0 ? '+' : ''}${downStrat.roi.toFixed(2)}%`);
  lines.push(`Average Return:      ${downStrat.averageReturn.toFixed(3)} BNB per bet`);
  lines.push(`Best Win Streak:     ${downStrat.bestStreak} rounds`);
  lines.push(`Worst Loss Streak:   ${downStrat.worstStreak} rounds\n`);

  // Comparison
  lines.push('🔍 COMPARISON');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Better Strategy:     ${stats.strategies.comparison.betterStrategy}`);
  lines.push(`Profit Difference:   ${stats.strategies.comparison.profitDifference.toFixed(2)} BNB\n`);

  // Recommendations
  if (stats.timeBasedRecommendations.length > 0) {
    lines.push('💡 RECOMMENDATIONS');
    lines.push('─────────────────────────────────────────────────────────────');
    stats.timeBasedRecommendations.forEach(rec => {
      lines.push(`• ${rec}`);
    });
    lines.push('');
  }

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('NOTE: This assumes 1 BNB bet per round. Results assume perfect');
  lines.push('execution with no fees beyond the built-in contract fee.');
  lines.push('Past performance does not guarantee future results.');
  lines.push('═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}
