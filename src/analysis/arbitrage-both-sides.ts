import { getDb } from '../store/sqlite.js';

interface RoundRow {
  epoch: number;
  winner: string;
  winner_multiple: string | null;
  total_amount_wei: string;
  bull_amount_wei: string;
  bear_amount_wei: string;
}

interface BothSidesResult {
  strategy: string;
  totalRounds: number;
  totalWagered: number;
  totalReturned: number;
  netProfit: number;
  roi: number;
  averageReturn: number;
  bestRound: { epoch: number; profit: number; upPayout: number; downPayout: number };
  worstRound: { epoch: number; loss: number; upPayout: number; downPayout: number };
  exampleRounds: Array<{
    epoch: number;
    betUp: number;
    betDown: number;
    upPayout: number;
    downPayout: number;
    winner: string;
    returned: number;
    netResult: number;
  }>;
}

function weiToBNB(wei: string): number {
  return parseFloat(wei) / 1e18;
}

export async function analyzeBothSides(): Promise<BothSidesResult> {
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

  // Filter completed rounds
  const completedRounds = rows.filter(
    r => r.winner_multiple && r.winner !== 'UNKNOWN' && r.winner !== 'DRAW'
  );

  const betAmount = 1; // 1 BNB on each side = 2 BNB total per round
  let totalWagered = 0;
  let totalReturned = 0;

  const exampleRounds: Array<any> = [];
  let bestRound = { epoch: 0, profit: -999, upPayout: 0, downPayout: 0 };
  let worstRound = { epoch: 0, loss: 0, upPayout: 0, downPayout: 0 };

  for (const round of completedRounds) {
    const payout = parseFloat(round.winner_multiple!);

    // Bet 1 BNB on each side
    const betUp = betAmount;
    const betDown = betAmount;
    const totalBet = betUp + betDown; // 2 BNB total

    totalWagered += totalBet;

    // Only the winning side pays out
    let returned = 0;
    if (round.winner === 'UP') {
      returned = betUp * payout;
    } else if (round.winner === 'DOWN') {
      returned = betDown * payout;
    }

    totalReturned += returned;
    const netResult = returned - totalBet;

    // Track best/worst
    if (netResult > bestRound.profit) {
      bestRound = { epoch: round.epoch, profit: netResult, upPayout: payout, downPayout: payout };
    }
    if (netResult < worstRound.loss) {
      worstRound = { epoch: round.epoch, loss: netResult, upPayout: payout, downPayout: payout };
    }

    // Save first 10 as examples
    if (exampleRounds.length < 10) {
      exampleRounds.push({
        epoch: round.epoch,
        betUp,
        betDown,
        upPayout: payout,
        downPayout: payout, // We don't know loser payout
        winner: round.winner,
        returned,
        netResult,
      });
    }
  }

  const totalRounds = completedRounds.length;
  const netProfit = totalReturned - totalWagered;
  const roi = totalWagered > 0 ? (netProfit / totalWagered) * 100 : 0;
  const averageReturn = totalRounds > 0 ? totalReturned / totalWagered : 0;

  return {
    strategy: 'Bet Both Sides (1 BNB each)',
    totalRounds,
    totalWagered,
    totalReturned,
    netProfit,
    roi,
    averageReturn,
    bestRound,
    worstRound,
    exampleRounds,
  };
}

export function formatBothSidesAnalysis(result: BothSidesResult): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('           "BET BOTH SIDES" ARBITRAGE ANALYSIS');
  lines.push('═══════════════════════════════════════════════════════════════\n');

  lines.push('🎲 STRATEGY');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push('Bet 1 BNB on UP + 1 BNB on DOWN every round');
  lines.push('Total wagered per round: 2 BNB');
  lines.push('Payout: Only winning side pays out\n');

  lines.push('📊 RESULTS');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Total Rounds: ${result.totalRounds.toLocaleString()}`);
  lines.push(`Total Wagered: ${result.totalWagered.toLocaleString()} BNB (2 BNB per round)`);
  lines.push(`Total Returned: ${result.totalReturned.toFixed(2)} BNB`);
  lines.push(`Net Profit/Loss: ${result.netProfit >= 0 ? '+' : ''}${result.netProfit.toFixed(2)} BNB`);
  lines.push(`ROI: ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(2)}%`);
  lines.push(`Average Return: ${result.averageReturn.toFixed(3)} BNB per 1 BNB wagered`);
  lines.push('');

  lines.push('🏆 BEST/WORST ROUNDS');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(`Best Round: Epoch ${result.bestRound.epoch}`);
  lines.push(`  Profit: ${result.bestRound.profit >= 0 ? '+' : ''}${result.bestRound.profit.toFixed(2)} BNB`);
  lines.push(`  (Wagered 2 BNB, got back ${(2 + result.bestRound.profit).toFixed(2)} BNB)`);
  lines.push('');
  lines.push(`Worst Round: Epoch ${result.worstRound.epoch}`);
  lines.push(`  Loss: ${result.worstRound.loss.toFixed(2)} BNB`);
  lines.push(`  (Wagered 2 BNB, got back ${(2 + result.worstRound.loss).toFixed(2)} BNB)`);
  lines.push('');

  lines.push('📋 EXAMPLE ROUNDS (First 10)');
  lines.push('─────────────────────────────────────────────────────────────');

  result.exampleRounds.forEach((round, i) => {
    const result = round.netResult >= 0 ? `✓ +${round.netResult.toFixed(2)}` : `✗ ${round.netResult.toFixed(2)}`;
    lines.push(`${i + 1}. Epoch ${round.epoch}:`);
    lines.push(`   Bet: ${round.betUp} UP + ${round.betDown} DOWN = 2 BNB total`);
    lines.push(`   Winner: ${round.winner} (${round.upPayout.toFixed(2)}x payout)`);
    lines.push(`   Returned: ${round.returned.toFixed(2)} BNB → ${result} BNB`);
  });

  lines.push('\n═══════════════════════════════════════════════════════════════');
  lines.push('💡 ANALYSIS');
  lines.push('═══════════════════════════════════════════════════════════════');

  if (result.roi < 0) {
    const avgLossPerRound = Math.abs(result.netProfit / result.totalRounds);
    const avgPayout = result.totalReturned / result.totalWagered;

    lines.push(`❌ This strategy LOSES ${Math.abs(result.roi).toFixed(2)}% overall`);
    lines.push(`\nWhy it fails:`);
    lines.push(`• You wager 2 BNB per round (1 UP + 1 DOWN)`);
    lines.push(`• You only get paid on the winning side`);
    lines.push(`• Average payout is ~${avgPayout.toFixed(3)}x per BNB wagered`);
    lines.push(`• House takes ~3% treasury fee on all bets`);
    lines.push(`• You lose ~${avgLossPerRound.toFixed(3)} BNB per round on average`);
    lines.push(`\nFor this to be profitable, you'd need:`);
    lines.push(`• Average winning payout to be >2x (to cover both bets)`);
    lines.push(`• But average payout is only ~1.95x`);
    lines.push(`• The house edge makes it impossible`);
  } else {
    lines.push(`✅ This strategy is PROFITABLE: +${result.roi.toFixed(2)}%`);
    lines.push(`This would be arbitrage - but shouldn't be possible!`);
  }

  lines.push('═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}
