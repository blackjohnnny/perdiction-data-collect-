import { getDb } from '../store/sqlite.js';

interface Round {
  epoch: number;
  lock_price: string;
  close_price: string;
  winner: string;
}

interface PriceMovement {
  epoch: number;
  priceChange: number;
  priceChangePercent: number;
  winner: string;
}

interface CorrelationResult {
  totalRounds: number;
  movements: {
    tiny: MovementCategory;      // 0-0.1%
    small: MovementCategory;      // 0.1-0.3%
    medium: MovementCategory;     // 0.3-0.6%
    large: MovementCategory;      // 0.6-1.0%
    huge: MovementCategory;       // >1.0%
  };
  consecutiveMoves: {
    twoUpInRow: ConsecutiveStats;
    twoDownInRow: ConsecutiveStats;
    twoLargeUpInRow: ConsecutiveStats;
    twoLargeDownInRow: ConsecutiveStats;
  };
}

interface MovementCategory {
  name: string;
  range: string;
  count: number;
  nextUp: number;
  nextDown: number;
  nextUpPercent: number;
  nextDownPercent: number;
  avgNextMovement: number; // Average next price change %
}

interface ConsecutiveStats {
  name: string;
  description: string;
  count: number;
  nextUp: number;
  nextDown: number;
  nextUpPercent: number;
  nextDownPercent: number;
  nextReversal: number; // Times the trend reversed
  nextContinuation: number; // Times the trend continued
}

function calculatePriceChange(lockPrice: bigint, closePrice: bigint): { change: number; percent: number } {
  const lockNum = Number(lockPrice) / 1e8;
  const closeNum = Number(closePrice) / 1e8;
  const change = closeNum - lockNum;
  const percent = (change / lockNum) * 100;
  return { change, percent };
}

export async function analyzePriceMovementCorrelation(daysBack: number = 30): Promise<CorrelationResult> {
  const db = await getDb();

  const nowTs = Math.floor(Date.now() / 1000);
  const startTs = nowTs - (daysBack * 24 * 60 * 60);

  const rows = db.exec(`
    SELECT
      epoch,
      lock_price,
      close_price,
      winner
    FROM rounds
    WHERE winner IN ('UP', 'DOWN')
      AND lock_ts >= ${startTs}
      AND close_price != '0'
      AND lock_price != '0'
    ORDER BY epoch ASC
  `);

  if (rows.length === 0 || rows[0].values.length === 0) {
    throw new Error('No rounds found');
  }

  const rounds: Round[] = rows[0].values.map((row: any) => ({
    epoch: row[0] as number,
    lock_price: row[1] as string,
    close_price: row[2] as string,
    winner: row[3] as string,
  }));

  const movements: PriceMovement[] = rounds.map(r => {
    const lockPrice = BigInt(r.lock_price);
    const closePrice = BigInt(r.close_price);
    const { change, percent } = calculatePriceChange(lockPrice, closePrice);
    return {
      epoch: r.epoch,
      priceChange: change,
      priceChangePercent: Math.abs(percent),
      winner: r.winner,
    };
  });

  // Categorize by movement size
  const categories = {
    tiny: { min: 0, max: 0.1, nextUp: 0, nextDown: 0, count: 0, nextMovements: [] as number[] },
    small: { min: 0.1, max: 0.3, nextUp: 0, nextDown: 0, count: 0, nextMovements: [] as number[] },
    medium: { min: 0.3, max: 0.6, nextUp: 0, nextDown: 0, count: 0, nextMovements: [] as number[] },
    large: { min: 0.6, max: 1.0, nextUp: 0, nextDown: 0, count: 0, nextMovements: [] as number[] },
    huge: { min: 1.0, max: Infinity, nextUp: 0, nextDown: 0, count: 0, nextMovements: [] as number[] },
  };

  for (let i = 0; i < movements.length - 1; i++) {
    const current = movements[i];
    const next = movements[i + 1];

    // Find category
    let category: keyof typeof categories = 'tiny';
    for (const [key, cat] of Object.entries(categories)) {
      if (current.priceChangePercent >= cat.min && current.priceChangePercent < cat.max) {
        category = key as keyof typeof categories;
        break;
      }
    }

    categories[category].count++;
    if (next.winner === 'UP') {
      categories[category].nextUp++;
    } else {
      categories[category].nextDown++;
    }
    categories[category].nextMovements.push(next.priceChangePercent);
  }

  // Analyze consecutive movements
  const consecutiveStats = {
    twoUpInRow: { count: 0, nextUp: 0, nextDown: 0, nextReversal: 0, nextContinuation: 0 },
    twoDownInRow: { count: 0, nextUp: 0, nextDown: 0, nextReversal: 0, nextContinuation: 0 },
    twoLargeUpInRow: { count: 0, nextUp: 0, nextDown: 0, nextReversal: 0, nextContinuation: 0 },
    twoLargeDownInRow: { count: 0, nextUp: 0, nextDown: 0, nextReversal: 0, nextContinuation: 0 },
  };

  for (let i = 0; i < movements.length - 2; i++) {
    const first = movements[i];
    const second = movements[i + 1];
    const third = movements[i + 2];

    // Two UP in a row
    if (first.winner === 'UP' && second.winner === 'UP') {
      consecutiveStats.twoUpInRow.count++;
      if (third.winner === 'UP') {
        consecutiveStats.twoUpInRow.nextUp++;
        consecutiveStats.twoUpInRow.nextContinuation++;
      } else {
        consecutiveStats.twoUpInRow.nextDown++;
        consecutiveStats.twoUpInRow.nextReversal++;
      }
    }

    // Two DOWN in a row
    if (first.winner === 'DOWN' && second.winner === 'DOWN') {
      consecutiveStats.twoDownInRow.count++;
      if (third.winner === 'UP') {
        consecutiveStats.twoDownInRow.nextUp++;
        consecutiveStats.twoDownInRow.nextReversal++;
      } else {
        consecutiveStats.twoDownInRow.nextDown++;
        consecutiveStats.twoDownInRow.nextContinuation++;
      }
    }

    // Two LARGE UP in a row (>0.6% each)
    if (first.winner === 'UP' && second.winner === 'UP' &&
        first.priceChangePercent >= 0.6 && second.priceChangePercent >= 0.6) {
      consecutiveStats.twoLargeUpInRow.count++;
      if (third.winner === 'UP') {
        consecutiveStats.twoLargeUpInRow.nextUp++;
        consecutiveStats.twoLargeUpInRow.nextContinuation++;
      } else {
        consecutiveStats.twoLargeUpInRow.nextDown++;
        consecutiveStats.twoLargeUpInRow.nextReversal++;
      }
    }

    // Two LARGE DOWN in a row (>0.6% each)
    if (first.winner === 'DOWN' && second.winner === 'DOWN' &&
        first.priceChangePercent >= 0.6 && second.priceChangePercent >= 0.6) {
      consecutiveStats.twoLargeDownInRow.count++;
      if (third.winner === 'UP') {
        consecutiveStats.twoLargeDownInRow.nextUp++;
        consecutiveStats.twoLargeDownInRow.nextReversal++;
      } else {
        consecutiveStats.twoLargeDownInRow.nextDown++;
        consecutiveStats.twoLargeDownInRow.nextContinuation++;
      }
    }
  }

  return {
    totalRounds: movements.length,
    movements: {
      tiny: {
        name: 'Tiny Movement',
        range: '0-0.1%',
        count: categories.tiny.count,
        nextUp: categories.tiny.nextUp,
        nextDown: categories.tiny.nextDown,
        nextUpPercent: (categories.tiny.nextUp / Math.max(1, categories.tiny.count)) * 100,
        nextDownPercent: (categories.tiny.nextDown / Math.max(1, categories.tiny.count)) * 100,
        avgNextMovement: categories.tiny.nextMovements.reduce((a, b) => a + b, 0) / Math.max(1, categories.tiny.nextMovements.length),
      },
      small: {
        name: 'Small Movement',
        range: '0.1-0.3%',
        count: categories.small.count,
        nextUp: categories.small.nextUp,
        nextDown: categories.small.nextDown,
        nextUpPercent: (categories.small.nextUp / Math.max(1, categories.small.count)) * 100,
        nextDownPercent: (categories.small.nextDown / Math.max(1, categories.small.count)) * 100,
        avgNextMovement: categories.small.nextMovements.reduce((a, b) => a + b, 0) / Math.max(1, categories.small.nextMovements.length),
      },
      medium: {
        name: 'Medium Movement',
        range: '0.3-0.6%',
        count: categories.medium.count,
        nextUp: categories.medium.nextUp,
        nextDown: categories.medium.nextDown,
        nextUpPercent: (categories.medium.nextUp / Math.max(1, categories.medium.count)) * 100,
        nextDownPercent: (categories.medium.nextDown / Math.max(1, categories.medium.count)) * 100,
        avgNextMovement: categories.medium.nextMovements.reduce((a, b) => a + b, 0) / Math.max(1, categories.medium.nextMovements.length),
      },
      large: {
        name: 'Large Movement',
        range: '0.6-1.0%',
        count: categories.large.count,
        nextUp: categories.large.nextUp,
        nextDown: categories.large.nextDown,
        nextUpPercent: (categories.large.nextUp / Math.max(1, categories.large.count)) * 100,
        nextDownPercent: (categories.large.nextDown / Math.max(1, categories.large.count)) * 100,
        avgNextMovement: categories.large.nextMovements.reduce((a, b) => a + b, 0) / Math.max(1, categories.large.nextMovements.length),
      },
      huge: {
        name: 'Huge Movement',
        range: '>1.0%',
        count: categories.huge.count,
        nextUp: categories.huge.nextUp,
        nextDown: categories.huge.nextDown,
        nextUpPercent: (categories.huge.nextUp / Math.max(1, categories.huge.count)) * 100,
        nextDownPercent: (categories.huge.nextDown / Math.max(1, categories.huge.count)) * 100,
        avgNextMovement: categories.huge.nextMovements.reduce((a, b) => a + b, 0) / Math.max(1, categories.huge.nextMovements.length),
      },
    },
    consecutiveMoves: {
      twoUpInRow: {
        name: 'Two UP in a row',
        description: 'When last 2 rounds went UP',
        count: consecutiveStats.twoUpInRow.count,
        nextUp: consecutiveStats.twoUpInRow.nextUp,
        nextDown: consecutiveStats.twoUpInRow.nextDown,
        nextUpPercent: (consecutiveStats.twoUpInRow.nextUp / Math.max(1, consecutiveStats.twoUpInRow.count)) * 100,
        nextDownPercent: (consecutiveStats.twoUpInRow.nextDown / Math.max(1, consecutiveStats.twoUpInRow.count)) * 100,
        nextReversal: consecutiveStats.twoUpInRow.nextReversal,
        nextContinuation: consecutiveStats.twoUpInRow.nextContinuation,
      },
      twoDownInRow: {
        name: 'Two DOWN in a row',
        description: 'When last 2 rounds went DOWN',
        count: consecutiveStats.twoDownInRow.count,
        nextUp: consecutiveStats.twoDownInRow.nextUp,
        nextDown: consecutiveStats.twoDownInRow.nextDown,
        nextUpPercent: (consecutiveStats.twoDownInRow.nextUp / Math.max(1, consecutiveStats.twoDownInRow.count)) * 100,
        nextDownPercent: (consecutiveStats.twoDownInRow.nextDown / Math.max(1, consecutiveStats.twoDownInRow.count)) * 100,
        nextReversal: consecutiveStats.twoDownInRow.nextReversal,
        nextContinuation: consecutiveStats.twoDownInRow.nextContinuation,
      },
      twoLargeUpInRow: {
        name: 'Two LARGE UP in a row',
        description: 'When last 2 rounds went UP by >0.6% each',
        count: consecutiveStats.twoLargeUpInRow.count,
        nextUp: consecutiveStats.twoLargeUpInRow.nextUp,
        nextDown: consecutiveStats.twoLargeUpInRow.nextDown,
        nextUpPercent: (consecutiveStats.twoLargeUpInRow.nextUp / Math.max(1, consecutiveStats.twoLargeUpInRow.count)) * 100,
        nextDownPercent: (consecutiveStats.twoLargeUpInRow.nextDown / Math.max(1, consecutiveStats.twoLargeUpInRow.count)) * 100,
        nextReversal: consecutiveStats.twoLargeUpInRow.nextReversal,
        nextContinuation: consecutiveStats.twoLargeUpInRow.nextContinuation,
      },
      twoLargeDownInRow: {
        name: 'Two LARGE DOWN in a row',
        description: 'When last 2 rounds went DOWN by >0.6% each',
        count: consecutiveStats.twoLargeDownInRow.count,
        nextUp: consecutiveStats.twoLargeDownInRow.nextUp,
        nextDown: consecutiveStats.twoLargeDownInRow.nextDown,
        nextUpPercent: (consecutiveStats.twoLargeDownInRow.nextUp / Math.max(1, consecutiveStats.twoLargeDownInRow.count)) * 100,
        nextDownPercent: (consecutiveStats.twoLargeDownInRow.nextDown / Math.max(1, consecutiveStats.twoLargeDownInRow.count)) * 100,
        nextReversal: consecutiveStats.twoLargeDownInRow.nextReversal,
        nextContinuation: consecutiveStats.twoLargeDownInRow.nextContinuation,
      },
    },
  };
}

export function formatPriceMovementCorrelation(result: CorrelationResult): string {
  let output = '';

  output += '═══════════════════════════════════════════════════════════════\n';
  output += '      PRICE MOVEMENT MAGNITUDE CORRELATION ANALYSIS\n';
  output += '═══════════════════════════════════════════════════════════════\n\n';

  output += `📊 Analyzed ${result.totalRounds.toLocaleString()} rounds\n\n`;

  output += '═══════════════════════════════════════════════════════════════\n';
  output += '📏 DOES MOVEMENT SIZE AFFECT NEXT OUTCOME?\n';
  output += '═══════════════════════════════════════════════════════════════\n\n';

  const movements = [result.movements.tiny, result.movements.small, result.movements.medium, result.movements.large, result.movements.huge];
  movements.forEach(m => {
    const bias = Math.abs(m.nextUpPercent - 50);
    const significant = bias > 5 ? '⚠️ ' : '';
    output += `${significant}${m.name} (${m.range})\n`;
    output += `  Occurred: ${m.count} times\n`;
    output += `  Next round: ${m.nextUp} UP (${m.nextUpPercent.toFixed(1)}%) | ${m.nextDown} DOWN (${m.nextDownPercent.toFixed(1)}%)\n`;
    output += `  Avg next movement: ${m.avgNextMovement.toFixed(3)}%\n`;
    if (bias > 5) {
      output += `  ⚠️  Bias detected: ${bias.toFixed(1)}% from 50/50\n`;
    }
    output += '\n';
  });

  output += '═══════════════════════════════════════════════════════════════\n';
  output += '🔄 CONSECUTIVE MOVEMENTS ANALYSIS\n';
  output += '═══════════════════════════════════════════════════════════════\n\n';

  const consecutive = [
    result.consecutiveMoves.twoUpInRow,
    result.consecutiveMoves.twoDownInRow,
    result.consecutiveMoves.twoLargeUpInRow,
    result.consecutiveMoves.twoLargeDownInRow,
  ];

  consecutive.forEach(c => {
    const bias = Math.abs(c.nextUpPercent - 50);
    const significant = bias > 5 ? '⚠️ ' : '';
    const reversalRate = (c.nextReversal / Math.max(1, c.count)) * 100;

    output += `${significant}${c.name}\n`;
    output += `  ${c.description}\n`;
    output += `  Occurred: ${c.count} times\n`;
    output += `  Next round: ${c.nextUp} UP (${c.nextUpPercent.toFixed(1)}%) | ${c.nextDown} DOWN (${c.nextDownPercent.toFixed(1)}%)\n`;
    output += `  Reversal rate: ${reversalRate.toFixed(1)}% | Continuation: ${((c.nextContinuation / Math.max(1, c.count)) * 100).toFixed(1)}%\n`;
    if (bias > 5) {
      output += `  ⚠️  Bias detected: ${bias.toFixed(1)}% from 50/50\n`;
    }
    output += '\n';
  });

  output += '═══════════════════════════════════════════════════════════════\n';
  output += '💡 KEY INSIGHTS\n';
  output += '═══════════════════════════════════════════════════════════════\n';

  // Check if any category shows significant bias
  const anySignificant = movements.some(m => Math.abs(m.nextUpPercent - 50) > 5) ||
                        consecutive.some(c => Math.abs(c.nextUpPercent - 50) > 5);

  if (anySignificant) {
    output += '⚠️  Some price movement patterns show bias!\n';
    output += 'This could indicate exploitable correlations.\n';
  } else {
    output += '✅ No significant correlation found between price movement\n';
    output += '   magnitude and next round outcome.\n\n';
    output += 'This confirms:\n';
    output += '• Large moves do NOT predict reversals\n';
    output += '• Consecutive large moves do NOT predict continuation\n';
    output += '• Price movements remain random regardless of prior magnitude\n';
  }

  output += '═══════════════════════════════════════════════════════════════\n';

  return output;
}
