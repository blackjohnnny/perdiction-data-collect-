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

interface StrategyResult {
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
  sharpeRatio: number;
  maxDrawdown: number;
}

interface StrategyAnalysis {
  strategies: StrategyResult[];
  insights: string[];
  recommendations: string[];
  edgeOpportunities: {
    poolImbalance: {
      description: string;
      profitability: number;
      viability: string;
    };
    streakBetting: {
      description: string;
      profitability: number;
      viability: string;
    };
    highPayoutChasing: {
      description: string;
      profitability: number;
      viability: string;
    };
  };
}

function weiToBNB(wei: string): number {
  return parseFloat(wei) / 1e18;
}

function calculateStrategy(
  rounds: RoundRow[],
  shouldBet: (round: RoundRow, history: RoundRow[]) => 'UP' | 'DOWN' | null,
  strategyName: string,
  description: string
): StrategyResult {
  const betAmount = 1;
  let totalWagered = 0;
  let totalReturned = 0;
  let wins = 0;
  let losses = 0;
  const returns: number[] = [];

  let balance = 0;
  let peakBalance = 0;
  let maxDrawdown = 0;

  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i];
    const history = rounds.slice(0, i);

    if (!round.winner_multiple || round.winner === 'UNKNOWN' || round.winner === 'DRAW') {
      continue;
    }

    const betDecision = shouldBet(round, history);
    if (!betDecision) continue;

    totalWagered += betAmount;
    balance -= betAmount;

    const payout = parseFloat(round.winner_multiple);
    const didWin = round.winner === betDecision;

    if (didWin) {
      const winAmount = betAmount * payout;
      totalReturned += winAmount;
      balance += winAmount;
      wins++;
      returns.push(payout - 1);
    } else {
      losses++;
      returns.push(-1);
    }

    // Track drawdown
    if (balance > peakBalance) {
      peakBalance = balance;
    }
    const currentDrawdown = peakBalance - balance;
    if (currentDrawdown > maxDrawdown) {
      maxDrawdown = currentDrawdown;
    }
  }

  const totalBets = wins + losses;
  const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;
  const netProfit = totalReturned - totalWagered;
  const roi = totalWagered > 0 ? (netProfit / totalWagered) * 100 : 0;
  const averageReturn = totalBets > 0 ? totalReturned / totalBets : 0;

  // Calculate Sharpe Ratio (risk-adjusted return)
  const avgReturn = returns.length > 0 ? returns.reduce((sum, r) => sum + r, 0) / returns.length : 0;
  const variance = returns.length > 0
    ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

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
    sharpeRatio,
    maxDrawdown,
  };
}

export async function analyzeStrategies(): Promise<StrategyAnalysis> {
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

  const strategies: StrategyResult[] = [];

  // Strategy 1: Bet on the underdog (less popular side based on pool)
  strategies.push(
    calculateStrategy(
      rows,
      (round) => {
        const bull = weiToBNB(round.bull_amount_wei || '0');
        const bear = weiToBNB(round.bear_amount_wei || '0');
        if (bull === 0 && bear === 0) return null;
        return bull < bear ? 'UP' : 'DOWN';
      },
      'Bet Underdog',
      'Always bet on the side with less money in the pool'
    )
  );

  // Strategy 2: Bet on favorite (more popular side)
  strategies.push(
    calculateStrategy(
      rows,
      (round) => {
        const bull = weiToBNB(round.bull_amount_wei || '0');
        const bear = weiToBNB(round.bear_amount_wei || '0');
        if (bull === 0 && bear === 0) return null;
        return bull > bear ? 'UP' : 'DOWN';
      },
      'Bet Favorite',
      'Always bet on the side with more money in the pool'
    )
  );

  // Strategy 3: Bet on high imbalance underdog only (>20% difference)
  strategies.push(
    calculateStrategy(
      rows,
      (round) => {
        const total = weiToBNB(round.total_amount_wei || '0');
        const bull = weiToBNB(round.bull_amount_wei || '0');
        const bear = weiToBNB(round.bear_amount_wei || '0');

        if (total === 0) return null;

        const bullPct = (bull / total) * 100;
        const bearPct = (bear / total) * 100;
        const imbalance = Math.abs(bullPct - bearPct);

        if (imbalance < 20) return null; // Only bet on highly imbalanced rounds

        return bull < bear ? 'UP' : 'DOWN';
      },
      'High Imbalance Underdog',
      'Bet underdog only when pool imbalance >20%'
    )
  );

  // Strategy 4: Anti-streak (bet against 3+ consecutive outcomes)
  strategies.push(
    calculateStrategy(
      rows,
      (round, history) => {
        if (history.length < 3) return null;

        const last3 = history.slice(-3);
        const allUp = last3.every(r => r.winner === 'UP');
        const allDown = last3.every(r => r.winner === 'DOWN');

        if (allUp) return 'DOWN';
        if (allDown) return 'UP';
        return null;
      },
      'Anti-Streak (3+)',
      'Bet against the direction after 3 consecutive same outcomes'
    )
  );

  // Strategy 5: Momentum (bet with 3+ consecutive outcomes)
  strategies.push(
    calculateStrategy(
      rows,
      (round, history) => {
        if (history.length < 3) return null;

        const last3 = history.slice(-3);
        const allUp = last3.every(r => r.winner === 'UP');
        const allDown = last3.every(r => r.winner === 'DOWN');

        if (allUp) return 'UP';
        if (allDown) return 'DOWN';
        return null;
      },
      'Momentum (3+)',
      'Bet with the direction after 3 consecutive same outcomes'
    )
  );

  // Strategy 6: Only bet when potential payout >2.5x (high imbalance)
  strategies.push(
    calculateStrategy(
      rows,
      (round) => {
        const total = weiToBNB(round.total_amount_wei || '0');
        const bull = weiToBNB(round.bull_amount_wei || '0');
        const bear = weiToBNB(round.bear_amount_wei || '0');

        if (total === 0 || bull === 0 || bear === 0) return null;

        // Calculate implied payout for each side
        const upPayout = total / bull;
        const downPayout = total / bear;

        if (upPayout > 2.5) return 'UP';
        if (downPayout > 2.5) return 'DOWN';
        return null;
      },
      'High Payout Only (>2.5x)',
      'Only bet when potential payout exceeds 2.5x'
    )
  );

  // Strategy 7: Selective underdog (>15% imbalance, underdog only)
  strategies.push(
    calculateStrategy(
      rows,
      (round) => {
        const total = weiToBNB(round.total_amount_wei || '0');
        const bull = weiToBNB(round.bull_amount_wei || '0');
        const bear = weiToBNB(round.bear_amount_wei || '0');

        if (total === 0) return null;

        const bullPct = (bull / total) * 100;
        const bearPct = (bear / total) * 100;
        const imbalance = Math.abs(bullPct - bearPct);

        // Must have >15% imbalance
        if (imbalance < 15) return null;

        return bull < bear ? 'UP' : 'DOWN';
      },
      'Selective Underdog (>15%)',
      'Bet underdog only when imbalance >15%'
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
    insights.push(`${profitableStrats.length} out of ${strategies.length} strategies are profitable`);
  } else {
    insights.push(`None of the tested strategies beat the house edge`);
  }

  // Check if underdog beats favorite
  const underdog = strategies.find(s => s.name === 'Bet Underdog');
  const favorite = strategies.find(s => s.name === 'Bet Favorite');
  if (underdog && favorite) {
    if (underdog.roi > favorite.roi) {
      insights.push(`Betting on underdog outperforms favorite by ${(underdog.roi - favorite.roi).toFixed(2)}%`);
    } else {
      insights.push(`Betting on favorite outperforms underdog by ${(favorite.roi - underdog.roi).toFixed(2)}%`);
    }
  }

  // Recommendations
  const recommendations: string[] = [];

  if (profitableStrats.length === 0) {
    recommendations.push('⚠️ No simple strategy beats the house edge with historical data alone');
    recommendations.push('💡 Consider implementing LIVE monitoring with T-20s snapshot data');
    recommendations.push('📊 Real-time pool imbalance at T-20s could provide edge for contrarian bets');
    recommendations.push('🎯 Focus on rounds with high imbalance (>20%) for better risk/reward');
    recommendations.push('⏰ Avoid betting on every round - selectivity is key');
  } else {
    recommendations.push(`✅ Use "${bestStrategy.name}" strategy for best historical performance`);
    recommendations.push(`📈 Expected ROI: ${bestStrategy.roi.toFixed(2)}% with ${bestStrategy.winRate.toFixed(2)}% win rate`);
    recommendations.push(`💰 Average return per bet: ${bestStrategy.averageReturn.toFixed(3)} BNB`);
  }

  // Edge opportunities analysis
  const poolImbalanceStrat = strategies.find(s => s.name === 'High Imbalance Underdog');
  const streakStrat = strategies.find(s => s.name === 'Anti-Streak (3+)');
  const highPayoutStrat = strategies.find(s => s.name === 'High Payout Only (>2.5x)');

  return {
    strategies,
    insights,
    recommendations,
    edgeOpportunities: {
      poolImbalance: {
        description: 'Bet on underdog when pool heavily favors one side',
        profitability: poolImbalanceStrat?.roi || 0,
        viability: poolImbalanceStrat && poolImbalanceStrat.roi > -1
          ? 'VIABLE - Low loss rate, needs live T-20s data for edge'
          : 'NOT VIABLE - Historical data insufficient',
      },
      streakBetting: {
        description: 'Bet against or with consecutive outcome patterns',
        profitability: streakStrat?.roi || 0,
        viability: streakStrat && streakStrat.roi > -2
          ? 'MARGINAL - Near break-even, high variance'
          : 'NOT VIABLE - Outcomes appear independent',
      },
      highPayoutChasing: {
        description: 'Only bet when potential payout exceeds 2.5x',
        profitability: highPayoutStrat?.roi || 0,
        viability: highPayoutStrat && highPayoutStrat.totalBets > 0
          ? `SELECTIVE - Only ${highPayoutStrat.totalBets} opportunities, but ${highPayoutStrat.roi > 0 ? 'profitable' : 'unprofitable'}`
          : 'NOT VIABLE - Too few opportunities',
      },
    },
  };
}

export function formatStrategyAnalysis(analysis: StrategyAnalysis): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('            ADVANCED BETTING STRATEGY ANALYSIS');
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
    lines.push(`Sharpe Ratio: ${strat.sharpeRatio.toFixed(3)} (risk-adjusted return)`);
    lines.push(`Max Drawdown: ${strat.maxDrawdown.toFixed(2)} BNB`);
    lines.push('');
  });

  // Edge opportunities
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('                  EDGE OPPORTUNITY ANALYSIS');
  lines.push('═══════════════════════════════════════════════════════════════\n');

  lines.push('1️⃣ POOL IMBALANCE STRATEGY');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(analysis.edgeOpportunities.poolImbalance.description);
  lines.push(`ROI: ${analysis.edgeOpportunities.poolImbalance.profitability >= 0 ? '+' : ''}${analysis.edgeOpportunities.poolImbalance.profitability.toFixed(2)}%`);
  lines.push(`Viability: ${analysis.edgeOpportunities.poolImbalance.viability}`);
  lines.push('');

  lines.push('2️⃣ STREAK BETTING');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(analysis.edgeOpportunities.streakBetting.description);
  lines.push(`ROI: ${analysis.edgeOpportunities.streakBetting.profitability >= 0 ? '+' : ''}${analysis.edgeOpportunities.streakBetting.profitability.toFixed(2)}%`);
  lines.push(`Viability: ${analysis.edgeOpportunities.streakBetting.viability}`);
  lines.push('');

  lines.push('3️⃣ HIGH PAYOUT OPPORTUNITIES');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(analysis.edgeOpportunities.highPayoutChasing.description);
  lines.push(`ROI: ${analysis.edgeOpportunities.highPayoutChasing.profitability >= 0 ? '+' : ''}${analysis.edgeOpportunities.highPayoutChasing.profitability.toFixed(2)}%`);
  lines.push(`Viability: ${analysis.edgeOpportunities.highPayoutChasing.viability}`);
  lines.push('');

  // Recommendations
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('                     RECOMMENDATIONS');
  lines.push('═══════════════════════════════════════════════════════════════\n');

  analysis.recommendations.forEach(rec => {
    lines.push(rec);
  });

  lines.push('\n═══════════════════════════════════════════════════════════════');
  lines.push('🎯 NEXT STEPS FOR PROFITABILITY:');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('1. Implement LIVE monitoring with T-20s snapshots');
  lines.push('2. Calculate real-time implied odds vs. actual odds');
  lines.push('3. Look for market inefficiency (crowd wrong on imbalanced pools)');
  lines.push('4. Only bet when edge detected (not every round)');
  lines.push('5. Use Kelly Criterion for position sizing');
  lines.push('6. Track live performance and adjust');
  lines.push('═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}
