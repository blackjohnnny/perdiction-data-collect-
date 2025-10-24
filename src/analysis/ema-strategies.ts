import { getDb } from '../store/sqlite.js';

interface Round {
  epoch: number;
  close_price: string;
  lock_price: string;
  winner: string;
  bull_payout: number;
  bear_payout: number;
}

interface EMAStrategyResult {
  name: string;
  description: string;
  totalRounds: number;
  betsPlaced: number;
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

interface EMAAnalysisResult {
  totalRounds: number;
  strategies: EMAStrategyResult[];
}

/**
 * Calculate EMA (Exponential Moving Average)
 * EMA = Price(t) * k + EMA(y) * (1 - k)
 * where k = 2 / (N + 1)
 */
function calculateEMA(prices: number[], period: number): number[] {
  if (prices.length < period) return [];

  const ema: number[] = [];
  const k = 2 / (period + 1);

  // First EMA is SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i];
  }
  ema.push(sum / period);

  // Calculate rest using EMA formula
  for (let i = period; i < prices.length; i++) {
    const newEma = prices[i] * k + ema[ema.length - 1] * (1 - k);
    ema.push(newEma);
  }

  return ema;
}

/**
 * Calculate strategy results
 */
function calculateEMAStrategy(
  rounds: Round[],
  getBetSide: (round: Round, index: number, ema20: number[], ema50: number[]) => 'UP' | 'DOWN' | null,
  name: string,
  description: string
): EMAStrategyResult {
  // Calculate close prices for EMA
  const closePrices = rounds.map(r => parseFloat(r.close_price) / 1e8);

  // Calculate EMAs
  const ema20 = calculateEMA(closePrices, 20);
  const ema50 = calculateEMA(closePrices, 50);

  let betsPlaced = 0;
  let betsSkipped = 0;
  let wins = 0;
  let losses = 0;
  let totalWagered = 0;
  let totalReturned = 0;
  const betAmount = 1; // 1 BNB per bet

  // Start after we have enough data for both EMAs
  const startIndex = 50;

  for (let i = startIndex; i < rounds.length; i++) {
    const round = rounds[i];

    // Get bet decision
    const betSide = getBetSide(round, i, ema20, ema50);

    if (!betSide) {
      betsSkipped++;
      continue;
    }

    betsPlaced++;
    totalWagered += betAmount;

    // Check if we won
    const won = round.winner === betSide;
    if (won) {
      wins++;
      const payout = betSide === 'UP' ? round.bull_payout : round.bear_payout;
      totalReturned += betAmount * payout;
    } else {
      losses++;
    }
  }

  const winRate = betsPlaced > 0 ? (wins / betsPlaced) * 100 : 0;
  const netProfit = totalReturned - totalWagered;
  const roi = totalWagered > 0 ? (netProfit / totalWagered) * 100 : 0;
  const avgPayout = betsPlaced > 0 ? totalReturned / totalWagered : 0;

  return {
    name,
    description,
    totalRounds: rounds.length - startIndex,
    betsPlaced,
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

/**
 * Analyze EMA-based strategies
 */
export async function analyzeEMAStrategies(): Promise<EMAAnalysisResult> {
  const db = await getDb();

  // Get all completed rounds with prices, ordered chronologically
  const rows = db.exec(`
    SELECT
      epoch,
      close_price,
      lock_price,
      winner,
      bull_payout,
      bear_payout
    FROM rounds
    WHERE winner IN ('UP', 'DOWN')
      AND close_price IS NOT NULL
      AND lock_price IS NOT NULL
    ORDER BY epoch ASC
  `);

  if (rows.length === 0 || rows[0].values.length === 0) {
    throw new Error('No completed rounds found');
  }

  const rounds: Round[] = rows[0].values.map((row: any) => ({
    epoch: row[0] as number,
    close_price: row[1] as string,
    lock_price: row[2] as string,
    winner: row[3] as string,
    bull_payout: row[4] as number,
    bear_payout: row[5] as number,
  }));

  const strategies: EMAStrategyResult[] = [];

  // Strategy 1: Bet UP when EMA20 > EMA50 (bullish crossover)
  strategies.push(
    calculateEMAStrategy(
      rounds,
      (round, i, ema20, ema50) => {
        const ema20Index = i - 50 + 20; // Adjust index for EMA20 array
        const ema50Index = i - 50; // Adjust index for EMA50 array
        if (ema20Index < 0 || ema50Index < 0) return null;
        return ema20[ema20Index] > ema50[ema50Index] ? 'UP' : null;
      },
      'EMA Bullish Only',
      'Bet UP when 20-EMA is above 50-EMA (bullish trend)'
    )
  );

  // Strategy 2: Bet DOWN when EMA20 < EMA50 (bearish crossover)
  strategies.push(
    calculateEMAStrategy(
      rounds,
      (round, i, ema20, ema50) => {
        const ema20Index = i - 50 + 20;
        const ema50Index = i - 50;
        if (ema20Index < 0 || ema50Index < 0) return null;
        return ema20[ema20Index] < ema50[ema50Index] ? 'DOWN' : null;
      },
      'EMA Bearish Only',
      'Bet DOWN when 20-EMA is below 50-EMA (bearish trend)'
    )
  );

  // Strategy 3: Follow EMA trend (UP if 20>50, DOWN if 20<50)
  strategies.push(
    calculateEMAStrategy(
      rounds,
      (round, i, ema20, ema50) => {
        const ema20Index = i - 50 + 20;
        const ema50Index = i - 50;
        if (ema20Index < 0 || ema50Index < 0) return null;
        return ema20[ema20Index] > ema50[ema50Index] ? 'UP' : 'DOWN';
      },
      'Follow EMA Trend',
      'Bet UP when 20-EMA > 50-EMA, DOWN when 20-EMA < 50-EMA'
    )
  );

  // Strategy 4: Bet with EMA trend + price above both EMAs for UP
  strategies.push(
    calculateEMAStrategy(
      rounds,
      (round, i, ema20, ema50) => {
        const ema20Index = i - 50 + 20;
        const ema50Index = i - 50;
        if (ema20Index < 0 || ema50Index < 0) return null;

        const closePrice = parseFloat(round.close_price) / 1e8;
        const ema20Val = ema20[ema20Index];
        const ema50Val = ema50[ema50Index];

        // Strong bullish: price > EMA20 > EMA50
        if (closePrice > ema20Val && ema20Val > ema50Val) return 'UP';
        return null;
      },
      'Strong Bullish',
      'Bet UP only when price > 20-EMA > 50-EMA (strong uptrend)'
    )
  );

  // Strategy 5: Bet with EMA trend + price below both EMAs for DOWN
  strategies.push(
    calculateEMAStrategy(
      rounds,
      (round, i, ema20, ema50) => {
        const ema20Index = i - 50 + 20;
        const ema50Index = i - 50;
        if (ema20Index < 0 || ema50Index < 0) return null;

        const closePrice = parseFloat(round.close_price) / 1e8;
        const ema20Val = ema20[ema20Index];
        const ema50Val = ema50[ema50Index];

        // Strong bearish: price < EMA20 < EMA50
        if (closePrice < ema20Val && ema20Val < ema50Val) return 'DOWN';
        return null;
      },
      'Strong Bearish',
      'Bet DOWN only when price < 20-EMA < 50-EMA (strong downtrend)'
    )
  );

  // Strategy 6: Combined strong signals
  strategies.push(
    calculateEMAStrategy(
      rounds,
      (round, i, ema20, ema50) => {
        const ema20Index = i - 50 + 20;
        const ema50Index = i - 50;
        if (ema20Index < 0 || ema50Index < 0) return null;

        const closePrice = parseFloat(round.close_price) / 1e8;
        const ema20Val = ema20[ema20Index];
        const ema50Val = ema50[ema50Index];

        // Strong bullish: price > EMA20 > EMA50
        if (closePrice > ema20Val && ema20Val > ema50Val) return 'UP';

        // Strong bearish: price < EMA20 < EMA50
        if (closePrice < ema20Val && ema20Val < ema50Val) return 'DOWN';

        return null;
      },
      'Strong Signals Only',
      'Bet UP when price > 20-EMA > 50-EMA, DOWN when price < 20-EMA < 50-EMA'
    )
  );

  // Strategy 7: Recent crossover (within last 5 rounds)
  strategies.push(
    calculateEMAStrategy(
      rounds,
      (round, i, ema20, ema50) => {
        const ema20Index = i - 50 + 20;
        const ema50Index = i - 50;
        if (ema20Index < 5 || ema50Index < 0) return null;

        // Check for bullish crossover in last 5 periods
        let bullishCrossover = false;
        let bearishCrossover = false;

        for (let lookback = 1; lookback <= 5; lookback++) {
          const prevIdx = ema20Index - lookback;
          const currIdx = ema20Index - lookback + 1;

          if (prevIdx < 0) continue;

          // Bullish: EMA20 crossed above EMA50
          if (ema20[prevIdx] <= ema50[ema50Index - lookback] &&
              ema20[currIdx] > ema50[ema50Index - lookback + 1]) {
            bullishCrossover = true;
          }

          // Bearish: EMA20 crossed below EMA50
          if (ema20[prevIdx] >= ema50[ema50Index - lookback] &&
              ema20[currIdx] < ema50[ema50Index - lookback + 1]) {
            bearishCrossover = true;
          }
        }

        if (bullishCrossover) return 'UP';
        if (bearishCrossover) return 'DOWN';
        return null;
      },
      'Recent Crossover',
      'Bet on direction of recent EMA crossover (within last 5 rounds)'
    )
  );

  return {
    totalRounds: rounds.length,
    strategies,
  };
}

/**
 * Format EMA analysis results
 */
export function formatEMAAnalysis(result: EMAAnalysisResult): string {
  let output = '';

  output += '═══════════════════════════════════════════════════════════════\n';
  output += '         EMA (20/50) TRADING STRATEGIES ANALYSIS\n';
  output += '═══════════════════════════════════════════════════════════════\n\n';

  output += `📊 ANALYZED ${result.totalRounds.toLocaleString()} completed rounds\n\n`;

  output += '📈 WHAT ARE EMAs?\n';
  output += '─────────────────────────────────────────────────────────────\n';
  output += 'EMA = Exponential Moving Average (gives more weight to recent prices)\n';
  output += '• 20-EMA: Fast moving average (reacts quickly to price changes)\n';
  output += '• 50-EMA: Slow moving average (shows longer-term trend)\n';
  output += '• When 20-EMA > 50-EMA → Bullish trend (bet UP)\n';
  output += '• When 20-EMA < 50-EMA → Bearish trend (bet DOWN)\n\n';

  // Sort strategies by ROI
  const sortedStrategies = [...result.strategies].sort((a, b) => b.roi - a.roi);

  output += '🎯 STRATEGY RESULTS (sorted by ROI)\n';
  output += '═══════════════════════════════════════════════════════════════\n\n';

  sortedStrategies.forEach((strategy, index) => {
    const profitable = strategy.roi > 0;
    const roiSymbol = profitable ? '✅' : '❌';
    const profitSymbol = strategy.netProfit >= 0 ? '+' : '';

    output += `${index + 1}. ${roiSymbol} ${strategy.name}\n`;
    output += `   ${strategy.description}\n`;
    output += '   ─────────────────────────────────────────────────────────\n';
    output += `   Bets Placed:    ${strategy.betsPlaced.toLocaleString()} / ${strategy.totalRounds.toLocaleString()} rounds (${((strategy.betsPlaced / strategy.totalRounds) * 100).toFixed(1)}%)\n`;
    output += `   Bets Skipped:   ${strategy.betsSkipped.toLocaleString()}\n`;
    output += `   Win Rate:       ${strategy.wins.toLocaleString()} / ${strategy.betsPlaced.toLocaleString()} (${strategy.winRate.toFixed(2)}%)\n`;
    output += `   Total Wagered:  ${strategy.totalWagered.toFixed(2)} BNB\n`;
    output += `   Total Returned: ${strategy.totalReturned.toFixed(2)} BNB\n`;
    output += `   Net Profit:     ${profitSymbol}${strategy.netProfit.toFixed(2)} BNB\n`;
    output += `   ROI:            ${profitSymbol}${strategy.roi.toFixed(2)}%\n`;
    output += `   Avg Return:     ${strategy.avgPayout.toFixed(4)}x per BNB\n`;
    output += '\n';
  });

  output += '═══════════════════════════════════════════════════════════════\n';
  output += '💡 ANALYSIS\n';
  output += '═══════════════════════════════════════════════════════════════\n';

  const bestStrategy = sortedStrategies[0];
  if (bestStrategy.roi > 0) {
    output += `✅ Best strategy: "${bestStrategy.name}"\n`;
    output += `   ROI: +${bestStrategy.roi.toFixed(2)}% (${bestStrategy.winRate.toFixed(1)}% win rate)\n`;
    output += `   Profit: +${bestStrategy.netProfit.toFixed(2)} BNB on ${bestStrategy.totalWagered.toFixed(2)} BNB wagered\n`;
  } else {
    output += '❌ No profitable EMA strategies found\n\n';
    output += 'Why EMA strategies fail:\n';
    output += '• BNB price movements in 5-minute intervals are too random\n';
    output += '• EMAs work better on longer timeframes (hours/days, not minutes)\n';
    output += '• House edge (3%) still applies to every bet\n';
    output += '• Technical indicators cannot predict short-term price chaos\n';
  }

  output += '═══════════════════════════════════════════════════════════════\n';

  return output;
}
