import { getDb } from '../store/sqlite.js';

interface ContrianStrategyResult {
  daysAnalyzed: number;
  totalRounds: number;
  strategyResults: {
    imbalance60: StrategyStats;
    imbalance65: StrategyStats;
    imbalance70: StrategyStats;
    imbalance60AndVolume: StrategyStats;
  };
  snapshotAnalysis?: {
    t8sRounds: number;
    t25sRounds: number;
    imbalance60AtT8s: StrategyStats;
    imbalance70AtT8s: StrategyStats;
  };
}

interface StrategyStats {
  name: string;
  description: string;
  totalBets: number;
  betsSkipped: number;
  wins: number;
  losses: number;
  winRate: number;
  totalWagered: number;
  totalReturned: number;
  netProfit: number;
  roi: number;
  avgPayout: number;
}

function calculateImbalance(bullAmount: bigint, bearAmount: bigint): { percent: number; favoredSide: 'UP' | 'DOWN' } {
  const total = bullAmount + bearAmount;
  if (total === 0n) return { percent: 50, favoredSide: 'UP' };

  const bullPercent = (Number(bullAmount) / Number(total)) * 100;
  const bearPercent = 100 - bullPercent;

  if (bullPercent > bearPercent) {
    return { percent: bullPercent, favoredSide: 'UP' };
  } else {
    return { percent: bearPercent, favoredSide: 'DOWN' };
  }
}

function calculatePayout(totalAmount: bigint, bullAmount: bigint, bearAmount: bigint, winner: 'UP' | 'DOWN'): number {
  if (winner === 'UP' && bullAmount > 0n) {
    return Number(totalAmount) / Number(bullAmount);
  } else if (winner === 'DOWN' && bearAmount > 0n) {
    return Number(totalAmount) / Number(bearAmount);
  }
  return 0;
}

export async function analyzeContrarianStrategy(daysBack: number = 30): Promise<ContrianStrategyResult> {
  const db = await getDb();

  const nowTs = Math.floor(Date.now() / 1000);
  const startTs = nowTs - (daysBack * 24 * 60 * 60);

  // Get completed rounds with final pool distribution
  const rounds = db.exec(`
    SELECT
      epoch,
      total_amount_wei,
      bull_amount_wei,
      bear_amount_wei,
      winner,
      lock_ts
    FROM rounds
    WHERE winner IN ('UP', 'DOWN')
      AND lock_ts >= ${startTs}
    ORDER BY epoch ASC
  `);

  if (rounds.length === 0 || rounds[0].values.length === 0) {
    throw new Error('No rounds found');
  }

  const roundData = rounds[0].values.map((row: any) => ({
    epoch: row[0] as number,
    totalAmount: BigInt(row[1]),
    bullAmount: BigInt(row[2]),
    bearAmount: BigInt(row[3]),
    winner: row[4] as string,
    lockTs: row[5] as number,
  }));

  // Calculate hourly average pool sizes
  const hourlyPoolSizes = new Map<number, { total: number; count: number }>();
  roundData.forEach(r => {
    const hour = new Date(r.lockTs * 1000).getUTCHours();
    const poolSize = Number(r.totalAmount) / 1e18;

    if (!hourlyPoolSizes.has(hour)) {
      hourlyPoolSizes.set(hour, { total: 0, count: 0 });
    }
    const stats = hourlyPoolSizes.get(hour)!;
    stats.total += poolSize;
    stats.count++;
  });

  const hourlyAvg = new Map<number, number>();
  hourlyPoolSizes.forEach((stats, hour) => {
    hourlyAvg.set(hour, stats.total / stats.count);
  });

  // Test contrarian strategies
  const strategies = {
    imbalance60: testStrategy(roundData, (r) => {
      const { percent, favoredSide } = calculateImbalance(r.bullAmount, r.bearAmount);
      if (percent >= 60) {
        // Bet against the crowd (bet underdog)
        return favoredSide === 'UP' ? 'DOWN' : 'UP';
      }
      return null;
    }, 'Contrarian >60% imbalance', 'Bet underdog when pool is >60% imbalanced'),

    imbalance65: testStrategy(roundData, (r) => {
      const { percent, favoredSide } = calculateImbalance(r.bullAmount, r.bearAmount);
      if (percent >= 65) {
        return favoredSide === 'UP' ? 'DOWN' : 'UP';
      }
      return null;
    }, 'Contrarian >65% imbalance', 'Bet underdog when pool is >65% imbalanced'),

    imbalance70: testStrategy(roundData, (r) => {
      const { percent, favoredSide } = calculateImbalance(r.bullAmount, r.bearAmount);
      if (percent >= 70) {
        return favoredSide === 'UP' ? 'DOWN' : 'UP';
      }
      return null;
    }, 'Contrarian >70% imbalance', 'Bet underdog when pool is >70% imbalanced'),

    imbalance60AndVolume: testStrategy(roundData, (r) => {
      const { percent, favoredSide } = calculateImbalance(r.bullAmount, r.bearAmount);
      const hour = new Date(r.lockTs * 1000).getUTCHours();
      const avgPoolSize = hourlyAvg.get(hour) || 0;
      const currentPoolSize = Number(r.totalAmount) / 1e18;

      // Only bet if pool is >80% of hourly average AND >60% imbalanced
      if (percent >= 60 && currentPoolSize >= avgPoolSize * 0.8) {
        return favoredSide === 'UP' ? 'DOWN' : 'UP';
      }
      return null;
    }, 'Contrarian >60% + Volume Filter', 'Bet underdog when >60% imbalanced AND pool >80% of hourly avg'),
  };

  // Analyze snapshots if available
  let snapshotAnalysis: ContrianStrategyResult['snapshotAnalysis'];

  const snapshots = db.exec(`
    SELECT
      s.epoch,
      s.snapshot_type,
      s.total_amount_wei,
      s.bull_amount_wei,
      s.bear_amount_wei,
      s.implied_up_multiple,
      s.implied_down_multiple,
      r.winner
    FROM snapshots s
    JOIN rounds r ON s.epoch = r.epoch
    WHERE r.winner IN ('UP', 'DOWN')
    ORDER BY s.epoch ASC
  `);

  if (snapshots.length > 0 && snapshots[0].values.length > 0) {
    const snapshotData = snapshots[0].values.map((row: any) => ({
      epoch: row[0] as number,
      snapshotType: row[1] as string,
      totalAmount: BigInt(row[2]),
      bullAmount: BigInt(row[3]),
      bearAmount: BigInt(row[4]),
      impliedUp: row[5] as number | null,
      impliedDown: row[6] as number | null,
      winner: row[7] as string,
    }));

    const t8sData = snapshotData.filter(s => s.snapshotType === 'T_MINUS_8S');
    const t25sData = snapshotData.filter(s => s.snapshotType === 'T_MINUS_25S');

    snapshotAnalysis = {
      t8sRounds: t8sData.length,
      t25sRounds: t25sData.length,
      imbalance60AtT8s: testStrategy(t8sData, (s) => {
        const { percent, favoredSide } = calculateImbalance(s.bullAmount, s.bearAmount);
        if (percent >= 60) {
          return favoredSide === 'UP' ? 'DOWN' : 'UP';
        }
        return null;
      }, 'T-8s Contrarian >60%', 'Bet underdog at T-8s when >60% imbalanced'),

      imbalance70AtT8s: testStrategy(t8sData, (s) => {
        const { percent, favoredSide } = calculateImbalance(s.bullAmount, s.bearAmount);
        if (percent >= 70) {
          return favoredSide === 'UP' ? 'DOWN' : 'UP';
        }
        return null;
      }, 'T-8s Contrarian >70%', 'Bet underdog at T-8s when >70% imbalanced'),
    };
  }

  return {
    daysAnalyzed: daysBack,
    totalRounds: roundData.length,
    strategyResults: strategies,
    snapshotAnalysis,
  };
}

function testStrategy(
  data: Array<{ totalAmount: bigint; bullAmount: bigint; bearAmount: bigint; winner: string; lockTs?: number }>,
  getBetSide: (round: any) => 'UP' | 'DOWN' | null,
  name: string,
  description: string
): StrategyStats {
  const betAmount = 1; // 1 BNB per bet
  let totalBets = 0;
  let betsSkipped = 0;
  let wins = 0;
  let losses = 0;
  let totalWagered = 0;
  let totalReturned = 0;

  data.forEach(round => {
    const betSide = getBetSide(round);

    if (!betSide) {
      betsSkipped++;
      return;
    }

    totalBets++;
    totalWagered += betAmount;

    const won = round.winner === betSide;
    if (won) {
      wins++;
      const payout = calculatePayout(round.totalAmount, round.bullAmount, round.bearAmount, betSide as 'UP' | 'DOWN');
      totalReturned += betAmount * payout;
    } else {
      losses++;
    }
  });

  const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;
  const netProfit = totalReturned - totalWagered;
  const roi = totalWagered > 0 ? (netProfit / totalWagered) * 100 : 0;
  const avgPayout = totalWagered > 0 ? totalReturned / totalWagered : 0;

  return {
    name,
    description,
    totalBets,
    betsSkipped,
    wins,
    losses,
    winRate,
    totalWagered,
    totalReturned,
    netProfit,
    roi,
    avgPayout,
  };
}

export function formatContrarianStrategy(result: ContrianStrategyResult): string {
  let output = '';

  output += '═══════════════════════════════════════════════════════════════\n';
  output += `      CONTRARIAN STRATEGY ANALYSIS (LAST ${result.daysAnalyzed} DAYS)\n`;
  output += '═══════════════════════════════════════════════════════════════\n\n';

  output += `📊 Analyzed ${result.totalRounds.toLocaleString()} completed rounds\n`;
  output += `💡 Strategy: Bet AGAINST the crowd when pool is heavily imbalanced\n\n`;

  output += '═══════════════════════════════════════════════════════════════\n';
  output += '🎯 CONTRARIAN STRATEGIES (Using Final Pool Distribution)\n';
  output += '═══════════════════════════════════════════════════════════════\n\n';

  const strategies = [
    result.strategyResults.imbalance60,
    result.strategyResults.imbalance65,
    result.strategyResults.imbalance70,
    result.strategyResults.imbalance60AndVolume,
  ];

  strategies.forEach((s, idx) => {
    const profitable = s.roi > 0;
    const icon = profitable ? '✅' : '❌';
    const profitSymbol = s.netProfit >= 0 ? '+' : '';

    output += `${idx + 1}. ${icon} ${s.name}\n`;
    output += `   ${s.description}\n`;
    output += `   ────────────────────────────────────────────────────────\n`;
    output += `   Bets Placed:    ${s.totalBets} / ${result.totalRounds} rounds (${((s.totalBets / result.totalRounds) * 100).toFixed(1)}%)\n`;
    output += `   Bets Skipped:   ${s.betsSkipped}\n`;
    output += `   Win Rate:       ${s.wins} / ${s.totalBets} (${s.winRate.toFixed(2)}%)\n`;
    output += `   Total Wagered:  ${s.totalWagered.toFixed(2)} BNB\n`;
    output += `   Total Returned: ${s.totalReturned.toFixed(2)} BNB\n`;
    output += `   Net Profit:     ${profitSymbol}${s.netProfit.toFixed(2)} BNB\n`;
    output += `   ROI:            ${profitSymbol}${s.roi.toFixed(2)}%\n`;
    output += `   Avg Return:     ${s.avgPayout.toFixed(4)}x per BNB\n`;
    output += '\n';
  });

  if (result.snapshotAnalysis) {
    output += '═══════════════════════════════════════════════════════════════\n';
    output += '📸 SNAPSHOT ANALYSIS (T-8s and T-25s Data)\n';
    output += '═══════════════════════════════════════════════════════════════\n\n';

    output += `T-8s snapshots available: ${result.snapshotAnalysis.t8sRounds}\n`;
    output += `T-25s snapshots available: ${result.snapshotAnalysis.t25sRounds}\n\n`;

    const snapshotStrats = [
      result.snapshotAnalysis.imbalance60AtT8s,
      result.snapshotAnalysis.imbalance70AtT8s,
    ];

    snapshotStrats.forEach((s, idx) => {
      const profitable = s.roi > 0;
      const icon = profitable ? '✅' : '❌';
      const profitSymbol = s.netProfit >= 0 ? '+' : '';

      output += `${idx + 1}. ${icon} ${s.name}\n`;
      output += `   ${s.description}\n`;
      output += `   ────────────────────────────────────────────────────────\n`;
      output += `   Bets Placed:    ${s.totalBets} / ${result.snapshotAnalysis!.t8sRounds} rounds (${((s.totalBets / result.snapshotAnalysis!.t8sRounds) * 100).toFixed(1)}%)\n`;
      output += `   Win Rate:       ${s.wins} / ${s.totalBets} (${s.winRate.toFixed(2)}%)\n`;
      output += `   Total Wagered:  ${s.totalWagered.toFixed(2)} BNB\n`;
      output += `   Net Profit:     ${profitSymbol}${s.netProfit.toFixed(2)} BNB\n`;
      output += `   ROI:            ${profitSymbol}${s.roi.toFixed(2)}%\n`;
      output += '\n';
    });

    output += '⚠️  Note: Snapshot sample size is small. Keep collecting data!\n\n';
  }

  output += '═══════════════════════════════════════════════════════════════\n';
  output += '💡 CONCLUSION\n';
  output += '═══════════════════════════════════════════════════════════════\n';

  const bestStrategy = strategies.sort((a, b) => b.roi - a.roi)[0];
  if (bestStrategy.roi > 0) {
    output += `✅ Best contrarian strategy: "${bestStrategy.name}"\n`;
    output += `   ROI: +${bestStrategy.roi.toFixed(2)}% with ${bestStrategy.winRate.toFixed(1)}% win rate\n`;
    output += `   Profit: +${bestStrategy.netProfit.toFixed(2)} BNB on ${bestStrategy.totalWagered.toFixed(2)} BNB wagered\n`;
  } else {
    output += '❌ No profitable contrarian strategies found using final pool data.\n';
    output += '   This suggests the crowd is not systematically wrong.\n';
  }

  output += '═══════════════════════════════════════════════════════════════\n';

  return output;
}
