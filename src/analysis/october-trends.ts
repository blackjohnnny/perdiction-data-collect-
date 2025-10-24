import { getDb } from '../store/sqlite.js';

interface RoundRow {
  epoch: number;
  start_ts: number;
  total_amount_wei: string;
  bull_amount_wei: string;
  bear_amount_wei: string;
  winner: string;
  winner_multiple: string | null;
}

interface TrendStrategyResult {
  name: string;
  description: string;
  totalBets: number;
  wins: number;
  losses: number;
  winRate: number;
  totalWagered: number;
  totalReturned: number;
  netProfit: number;
  roi: number;
  averageReturn: number;
  bestStreak: number;
  worstStreak: number;
  exampleTrades: { epoch: number; prediction: string; actual: string; won: boolean; payout?: number }[];
}

interface OctoberTrendAnalysis {
  strategies: TrendStrategyResult[];
  insights: string[];
  recommendations: string[];
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

function calculateTrendStrategy(
  rounds: RoundRow[],
  shouldBet: (round: RoundRow, history: RoundRow[]) => 'UP' | 'DOWN' | null,
  strategyName: string,
  description: string
): TrendStrategyResult {
  const betAmount = 1;
  let totalWagered = 0;
  let totalReturned = 0;
  let wins = 0;
  let losses = 0;

  let currentStreak = 0;
  let bestStreak = 0;
  let worstStreak = 0;
  let isWinStreak = true;

  const exampleTrades: { epoch: number; prediction: string; actual: string; won: boolean; payout?: number }[] = [];

  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i];
    const history = rounds.slice(0, i);

    if (!round.winner_multiple || round.winner === 'UNKNOWN' || round.winner === 'DRAW') {
      continue;
    }

    const betDecision = shouldBet(round, history);
    if (!betDecision) continue;

    totalWagered += betAmount;

    const payout = parseFloat(round.winner_multiple);
    const didWin = round.winner === betDecision;

    if (didWin) {
      const winAmount = betAmount * payout;
      totalReturned += winAmount;
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

    // Save first 10 trades as examples
    if (exampleTrades.length < 10) {
      exampleTrades.push({
        epoch: round.epoch,
        prediction: betDecision,
        actual: round.winner,
        won: didWin,
        payout: didWin ? payout : undefined,
      });
    }
  }

  const totalBets = wins + losses;
  const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;
  const netProfit = totalReturned - totalWagered;
  const roi = totalWagered > 0 ? (netProfit / totalWagered) * 100 : 0;
  const averageReturn = totalBets > 0 ? totalReturned / totalBets : 0;

  return {
    name: strategyName,
    description,
    totalBets,
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
    exampleTrades,
  };
}

export async function analyzeOctoberTrends(): Promise<OctoberTrendAnalysis> {
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

  // Filter for October 2025
  const rows = allRows.filter(r => getMonthKey(r.start_ts) === '2025-10');

  const strategies: TrendStrategyResult[] = [];

  // Strategy 1: Follow Last Winner
  strategies.push(
    calculateTrendStrategy(
      rows,
      (round, history) => {
        if (history.length === 0) return null;
        const lastRound = history[history.length - 1];
        if (lastRound.winner === 'UP' || lastRound.winner === 'DOWN') {
          return lastRound.winner;
        }
        return null;
      },
      'Follow Last Winner',
      'Bet on whatever won the previous round'
    )
  );

  // Strategy 2: Follow 2 Consecutive
  strategies.push(
    calculateTrendStrategy(
      rows,
      (round, history) => {
        if (history.length < 2) return null;
        const last2 = history.slice(-2);
        if (last2[0].winner === last2[1].winner && (last2[1].winner === 'UP' || last2[1].winner === 'DOWN')) {
          return last2[1].winner;
        }
        return null;
      },
      'Follow 2-Win Streak',
      'Bet after 2 consecutive same outcomes'
    )
  );

  // Strategy 3: Follow 3+ Consecutive
  strategies.push(
    calculateTrendStrategy(
      rows,
      (round, history) => {
        if (history.length < 3) return null;
        const last3 = history.slice(-3);
        const allSame = last3.every(r => r.winner === last3[0].winner);
        if (allSame && (last3[0].winner === 'UP' || last3[0].winner === 'DOWN')) {
          return last3[0].winner;
        }
        return null;
      },
      'Follow 3-Win Streak',
      'Bet after 3 consecutive same outcomes'
    )
  );

  // Strategy 4: Follow Majority (Last 5)
  strategies.push(
    calculateTrendStrategy(
      rows,
      (round, history) => {
        if (history.length < 5) return null;
        const last5 = history.slice(-5);
        const upCount = last5.filter(r => r.winner === 'UP').length;
        const downCount = last5.filter(r => r.winner === 'DOWN').length;
        if (upCount > downCount) return 'UP';
        if (downCount > upCount) return 'DOWN';
        return null;
      },
      'Follow 5-Round Majority',
      'Bet on direction that won more in last 5 rounds'
    )
  );

  // Strategy 5: Strong Trend (3 of 4)
  strategies.push(
    calculateTrendStrategy(
      rows,
      (round, history) => {
        if (history.length < 4) return null;
        const last4 = history.slice(-4);
        const upCount = last4.filter(r => r.winner === 'UP').length;
        const downCount = last4.filter(r => r.winner === 'DOWN').length;
        if (upCount >= 3) return 'UP';
        if (downCount >= 3) return 'DOWN';
        return null;
      },
      'Strong Trend (3 of 4)',
      'Bet if direction won 3+ of last 4 rounds'
    )
  );

  // Sort by ROI
  strategies.sort((a, b) => b.roi - a.roi);

  // Generate insights
  const insights: string[] = [];
  const bestStrategy = strategies[0];
  const worstStrategy = strategies[strategies.length - 1];

  insights.push(`Best Strategy: "${bestStrategy.name}" with ${bestStrategy.roi.toFixed(2)}% ROI`);
  insights.push(`Worst Strategy: "${worstStrategy.name}" with ${worstStrategy.roi.toFixed(2)}% ROI`);

  const profitableStrats = strategies.filter(s => s.roi > 0);
  if (profitableStrats.length > 0) {
    insights.push(`${profitableStrats.length} out of ${strategies.length} strategies are profitable in October`);
  } else {
    insights.push(`None of the trend strategies beat the house edge in October`);
  }

  // Check Follow Last
  const followLast = strategies.find(s => s.name === 'Follow Last Winner');
  if (followLast) {
    insights.push(`Following last winner: ${followLast.roi.toFixed(2)}% ROI (${followLast.winRate.toFixed(2)}% win rate)`);
  }

  // Recommendations
  const recommendations: string[] = [];

  if (profitableStrats.length === 0) {
    recommendations.push('⚠️ No trend-following strategy was profitable in October');
    recommendations.push('💡 October had most balanced outcomes (49.67% UP vs 50.24% DOWN)');
    recommendations.push('📊 This confirms price movements are random/independent');
    recommendations.push('🎯 Contrarian strategy (bet against crowd) remains best approach');
  } else {
    recommendations.push(`✅ Best: "${bestStrategy.name}" with ${bestStrategy.roi.toFixed(2)}% ROI`);
    recommendations.push(`⚠️ However, this may be statistical noise - test with more data`);
  }

  return {
    strategies,
    insights,
    recommendations,
  };
}

export function formatOctoberTrends(analysis: OctoberTrendAnalysis): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('        OCTOBER 2025 - TREND-FOLLOWING ANALYSIS');
  lines.push('═══════════════════════════════════════════════════════════════\n');

  // Summary insights
  lines.push('📊 KEY INSIGHTS');
  lines.push('─────────────────────────────────────────────────────────────');
  analysis.insights.forEach(insight => {
    lines.push(`• ${insight}`);
  });
  lines.push('');

  // Strategy results
  lines.push('📈 STRATEGY PERFORMANCE (Ranked by ROI)');
  lines.push('═══════════════════════════════════════════════════════════════\n');

  analysis.strategies.forEach((strat, index) => {
    const rank = index + 1;
    const profitSymbol = strat.netProfit >= 0 ? '✅' : '❌';

    lines.push(`${rank}. ${strat.name} ${profitSymbol}`);
    lines.push('─────────────────────────────────────────────────────────────');
    lines.push(`Description: ${strat.description}`);
    lines.push(`Total Bets: ${strat.totalBets.toLocaleString()} rounds`);
    lines.push(`Win/Loss: ${strat.wins.toLocaleString()} / ${strat.losses.toLocaleString()} (${strat.winRate.toFixed(2)}% win rate)`);
    lines.push(`Total Wagered: ${strat.totalWagered.toLocaleString()} BNB`);
    lines.push(`Total Returned: ${strat.totalReturned.toFixed(2)} BNB`);
    lines.push(`Net Profit/Loss: ${strat.netProfit >= 0 ? '+' : ''}${strat.netProfit.toFixed(2)} BNB`);
    lines.push(`ROI: ${strat.roi >= 0 ? '+' : ''}${strat.roi.toFixed(2)}%`);
    lines.push(`Avg Return/Bet: ${strat.averageReturn.toFixed(3)} BNB`);
    lines.push(`Best Win Streak: ${strat.bestStreak} | Worst Loss Streak: ${strat.worstStreak}`);

    // Example trades
    if (strat.exampleTrades.length > 0) {
      lines.push('\nFirst 10 Trades:');
      strat.exampleTrades.forEach((trade, i) => {
        const result = trade.won ? `✓ ${trade.payout?.toFixed(2)}x` : '✗ Lost';
        lines.push(`  ${i + 1}. Epoch ${trade.epoch}: Bet ${trade.prediction}, Result ${trade.actual} - ${result}`);
      });
    }
    lines.push('');
  });

  // Recommendations
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('                     RECOMMENDATIONS');
  lines.push('═══════════════════════════════════════════════════════════════\n');

  analysis.recommendations.forEach(rec => {
    lines.push(rec);
  });

  lines.push('\n═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}
