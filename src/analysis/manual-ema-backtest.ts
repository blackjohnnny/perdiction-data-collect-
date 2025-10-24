import { getDb } from '../store/sqlite.js';

interface Round {
  epoch: number;
  start_ts: number;
  lock_ts: number;
  close_ts: number;
  winner: string;
  bull_payout: number | null;
  bear_payout: number | null;
}

interface ManualTrade {
  startTime: string; // ISO timestamp or epoch number
  endTime: string;   // ISO timestamp or epoch number
  direction: 'UP' | 'DOWN';
}

interface TradeResult {
  trade: ManualTrade;
  roundsTraded: number;
  wins: number;
  losses: number;
  winRate: number;
  totalWagered: number;
  totalReturned: number;
  netProfit: number;
  roi: number;
  rounds: Array<{
    epoch: number;
    startTime: string;
    direction: 'UP' | 'DOWN';
    winner: string;
    won: boolean;
    payout: number | null;
    profit: number;
  }>;
}

/**
 * Parse time input (unix timestamp or epoch number)
 */
function parseTimeInput(input: string): number {
  // If it's a number, treat as unix timestamp
  const num = parseInt(input, 10);
  if (!isNaN(num)) {
    // If it's a large number (>100000000), it's likely a unix timestamp in seconds
    // If small number (<500000), it's likely an epoch
    if (num > 100000000) {
      return num;
    } else {
      // Convert epoch to timestamp (need to query the database)
      return num; // Will handle in query
    }
  }

  // Try parsing as ISO date
  const date = new Date(input);
  if (!isNaN(date.getTime())) {
    return Math.floor(date.getTime() / 1000);
  }

  throw new Error(`Invalid time input: ${input}`);
}

/**
 * Backtest manual EMA trades
 */
export async function backTestManualTrades(trades: ManualTrade[]): Promise<TradeResult[]> {
  const db = await getDb();
  const results: TradeResult[] = [];
  const betAmount = 1; // 1 BNB per bet

  for (const trade of trades) {
    const startTime = parseTimeInput(trade.startTime);
    const endTime = parseTimeInput(trade.endTime);

    // Query rounds in this timeframe
    // If input is epoch number (small), use epoch directly
    // If input is timestamp (large), use lock_ts
    let query: string;
    if (startTime < 500000 && endTime < 500000) {
      // Epoch range
      query = `
        SELECT
          epoch,
          start_ts,
          lock_ts,
          close_ts,
          winner,
          (CASE
            WHEN winner = 'UP' THEN
              CAST(total_amount_wei AS REAL) / CAST(bull_amount_wei AS REAL)
            ELSE NULL
          END) as bull_payout,
          (CASE
            WHEN winner = 'DOWN' THEN
              CAST(total_amount_wei AS REAL) / CAST(bear_amount_wei AS REAL)
            ELSE NULL
          END) as bear_payout
        FROM rounds
        WHERE epoch >= ${startTime}
          AND epoch <= ${endTime}
          AND winner IN ('UP', 'DOWN')
        ORDER BY epoch ASC
      `;
    } else {
      // Timestamp range
      query = `
        SELECT
          epoch,
          start_ts,
          lock_ts,
          close_ts,
          winner,
          (CASE
            WHEN winner = 'UP' THEN
              CAST(total_amount_wei AS REAL) / CAST(bull_amount_wei AS REAL)
            ELSE NULL
          END) as bull_payout,
          (CASE
            WHEN winner = 'DOWN' THEN
              CAST(total_amount_wei AS REAL) / CAST(bear_amount_wei AS REAL)
            ELSE NULL
          END) as bear_payout
        FROM rounds
        WHERE lock_ts >= ${startTime}
          AND lock_ts <= ${endTime}
          AND winner IN ('UP', 'DOWN')
        ORDER BY epoch ASC
      `;
    }

    const rows = db.exec(query);

    if (rows.length === 0 || rows[0].values.length === 0) {
      results.push({
        trade,
        roundsTraded: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalWagered: 0,
        totalReturned: 0,
        netProfit: 0,
        roi: 0,
        rounds: [],
      });
      continue;
    }

    const rounds: Round[] = rows[0].values.map((row: any) => ({
      epoch: row[0] as number,
      start_ts: row[1] as number,
      lock_ts: row[2] as number,
      close_ts: row[3] as number,
      winner: row[4] as string,
      bull_payout: row[5] as number | null,
      bear_payout: row[6] as number | null,
    }));

    // Calculate results
    let wins = 0;
    let losses = 0;
    let totalWagered = 0;
    let totalReturned = 0;

    const roundResults = rounds.map((round) => {
      const won = round.winner === trade.direction;
      const payout = trade.direction === 'UP' ? round.bull_payout : round.bear_payout;
      const returned = won && payout ? betAmount * payout : 0;
      const profit = returned - betAmount;

      totalWagered += betAmount;
      totalReturned += returned;

      if (won) wins++;
      else losses++;

      return {
        epoch: round.epoch,
        startTime: new Date(round.start_ts * 1000).toISOString(),
        direction: trade.direction,
        winner: round.winner,
        won,
        payout,
        profit,
      };
    });

    const netProfit = totalReturned - totalWagered;
    const roi = totalWagered > 0 ? (netProfit / totalWagered) * 100 : 0;
    const winRate = rounds.length > 0 ? (wins / rounds.length) * 100 : 0;

    results.push({
      trade,
      roundsTraded: rounds.length,
      wins,
      losses,
      winRate,
      totalWagered,
      totalReturned,
      netProfit,
      roi,
      rounds: roundResults,
    });
  }

  return results;
}

/**
 * Format manual trade backtest results
 */
export function formatManualTradeResults(results: TradeResult[]): string {
  let output = '';

  output += '═══════════════════════════════════════════════════════════════\n';
  output += '         MANUAL EMA BACKTEST RESULTS\n';
  output += '═══════════════════════════════════════════════════════════════\n\n';

  let totalWagered = 0;
  let totalReturned = 0;
  let totalRounds = 0;

  results.forEach((result, index) => {
    const profitSymbol = result.netProfit >= 0 ? '+' : '';
    const status = result.roi > 0 ? '✅' : '❌';

    output += `${status} TRADE #${index + 1}\n`;
    output += '─────────────────────────────────────────────────────────────\n';
    output += `Direction:      ${result.trade.direction}\n`;
    output += `Timeframe:      ${result.trade.startTime} → ${result.trade.endTime}\n`;
    output += `Rounds Traded:  ${result.roundsTraded}\n`;
    output += `Win Rate:       ${result.wins} / ${result.roundsTraded} (${result.winRate.toFixed(1)}%)\n`;
    output += `Total Wagered:  ${result.totalWagered.toFixed(2)} BNB\n`;
    output += `Total Returned: ${result.totalReturned.toFixed(2)} BNB\n`;
    output += `Net Profit:     ${profitSymbol}${result.netProfit.toFixed(2)} BNB\n`;
    output += `ROI:            ${profitSymbol}${result.roi.toFixed(2)}%\n`;
    output += '\n';

    // Show first 5 and last 5 rounds if more than 10
    if (result.rounds.length > 0) {
      output += '📊 Sample Rounds:\n';
      const samplesToShow = result.rounds.length > 10 ? 5 : result.rounds.length;

      for (let i = 0; i < samplesToShow; i++) {
        const r = result.rounds[i];
        const icon = r.won ? '✓' : '✗';
        const profitStr = r.profit >= 0 ? '+' : '';
        output += `   ${icon} Epoch ${r.epoch}: ${r.direction} → ${r.winner} (${r.payout?.toFixed(2)}x) ${profitStr}${r.profit.toFixed(2)} BNB\n`;
      }

      if (result.rounds.length > 10) {
        output += '   ...\n';
        for (let i = result.rounds.length - 5; i < result.rounds.length; i++) {
          const r = result.rounds[i];
          const icon = r.won ? '✓' : '✗';
          const profitStr = r.profit >= 0 ? '+' : '';
          output += `   ${icon} Epoch ${r.epoch}: ${r.direction} → ${r.winner} (${r.payout?.toFixed(2)}x) ${profitStr}${r.profit.toFixed(2)} BNB\n`;
        }
      }
    }

    output += '\n';

    totalWagered += result.totalWagered;
    totalReturned += result.totalReturned;
    totalRounds += result.roundsTraded;
  });

  // Overall summary
  const overallProfit = totalReturned - totalWagered;
  const overallROI = totalWagered > 0 ? (overallProfit / totalWagered) * 100 : 0;
  const profitSymbol = overallProfit >= 0 ? '+' : '';
  const overallStatus = overallROI > 0 ? '✅' : '❌';

  output += '═══════════════════════════════════════════════════════════════\n';
  output += `${overallStatus} OVERALL SUMMARY\n`;
  output += '═══════════════════════════════════════════════════════════════\n';
  output += `Total Trades:   ${results.length}\n`;
  output += `Total Rounds:   ${totalRounds}\n`;
  output += `Total Wagered:  ${totalWagered.toFixed(2)} BNB\n`;
  output += `Total Returned: ${totalReturned.toFixed(2)} BNB\n`;
  output += `Net Profit:     ${profitSymbol}${overallProfit.toFixed(2)} BNB\n`;
  output += `Overall ROI:    ${profitSymbol}${overallROI.toFixed(2)}%\n`;
  output += '═══════════════════════════════════════════════════════════════\n';

  return output;
}
