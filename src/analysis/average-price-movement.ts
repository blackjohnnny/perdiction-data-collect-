import { getDb } from '../store/sqlite.js';

interface MovementStats {
  totalRounds: number;
  daysAnalyzed: number;
  avgPriceUSD: number;
  movements: {
    avgMovementUSD: number;
    avgMovementPercent: number;
    medianMovementUSD: number;
    minMovementUSD: number;
    maxMovementUSD: number;
    upMoves: {
      count: number;
      avgUSD: number;
      avgPercent: number;
    };
    downMoves: {
      count: number;
      avgUSD: number;
      avgPercent: number;
    };
  };
  volatilityByHour: Array<{
    hour: number;
    avgMovementUSD: number;
    avgMovementPercent: number;
    count: number;
  }>;
}

export async function analyzeAveragePriceMovement(daysBack: number = 60): Promise<MovementStats> {
  const db = await getDb();

  const nowTs = Math.floor(Date.now() / 1000);
  const startTs = nowTs - (daysBack * 24 * 60 * 60);

  const rows = db.exec(`
    SELECT
      epoch,
      lock_price,
      close_price,
      lock_ts,
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

  const movements: Array<{
    movementUSD: number;
    movementPercent: number;
    lockPriceUSD: number;
    hour: number;
    winner: string;
  }> = [];

  let totalPrice = 0;

  rows[0].values.forEach((row: any) => {
    const lockPrice = Number(row[1]) / 1e8;
    const closePrice = Number(row[2]) / 1e8;
    const lockTs = row[3] as number;
    const winner = row[4] as string;

    const movementUSD = Math.abs(closePrice - lockPrice);
    const movementPercent = (movementUSD / lockPrice) * 100;
    const hour = new Date(lockTs * 1000).getUTCHours();

    movements.push({
      movementUSD,
      movementPercent,
      lockPriceUSD: lockPrice,
      hour,
      winner,
    });

    totalPrice += lockPrice;
  });

  const avgPriceUSD = totalPrice / movements.length;

  // Calculate statistics
  const sortedMovements = [...movements].sort((a, b) => a.movementUSD - b.movementUSD);
  const medianMovementUSD = sortedMovements[Math.floor(sortedMovements.length / 2)].movementUSD;

  const totalMovementUSD = movements.reduce((sum, m) => sum + m.movementUSD, 0);
  const totalMovementPercent = movements.reduce((sum, m) => sum + m.movementPercent, 0);

  const upMoves = movements.filter(m => m.winner === 'UP');
  const downMoves = movements.filter(m => m.winner === 'DOWN');

  // Volatility by hour
  const hourlyStats = new Map<number, { total: number; count: number; totalPercent: number }>();
  movements.forEach(m => {
    if (!hourlyStats.has(m.hour)) {
      hourlyStats.set(m.hour, { total: 0, count: 0, totalPercent: 0 });
    }
    const stats = hourlyStats.get(m.hour)!;
    stats.total += m.movementUSD;
    stats.count++;
    stats.totalPercent += m.movementPercent;
  });

  const volatilityByHour = Array.from(hourlyStats.entries())
    .map(([hour, stats]) => ({
      hour,
      avgMovementUSD: stats.total / stats.count,
      avgMovementPercent: stats.totalPercent / stats.count,
      count: stats.count,
    }))
    .sort((a, b) => a.hour - b.hour);

  return {
    totalRounds: movements.length,
    daysAnalyzed: daysBack,
    avgPriceUSD,
    movements: {
      avgMovementUSD: totalMovementUSD / movements.length,
      avgMovementPercent: totalMovementPercent / movements.length,
      medianMovementUSD,
      minMovementUSD: sortedMovements[0].movementUSD,
      maxMovementUSD: sortedMovements[sortedMovements.length - 1].movementUSD,
      upMoves: {
        count: upMoves.length,
        avgUSD: upMoves.reduce((sum, m) => sum + m.movementUSD, 0) / upMoves.length,
        avgPercent: upMoves.reduce((sum, m) => sum + m.movementPercent, 0) / upMoves.length,
      },
      downMoves: {
        count: downMoves.length,
        avgUSD: downMoves.reduce((sum, m) => sum + m.movementUSD, 0) / downMoves.length,
        avgPercent: downMoves.reduce((sum, m) => sum + m.movementPercent, 0) / downMoves.length,
      },
    },
    volatilityByHour,
  };
}

export function formatAveragePriceMovement(result: MovementStats): string {
  let output = '';

  output += '═══════════════════════════════════════════════════════════════\n';
  output += `     AVERAGE PRICE MOVEMENT (LAST ${result.daysAnalyzed} DAYS)\n`;
  output += '═══════════════════════════════════════════════════════════════\n\n';

  output += `📊 Analyzed ${result.totalRounds.toLocaleString()} rounds over ${result.daysAnalyzed} days\n`;
  output += `💰 Average BNB Price: $${result.avgPriceUSD.toFixed(2)}\n\n`;

  output += '═══════════════════════════════════════════════════════════════\n';
  output += '📏 PRICE MOVEMENT STATISTICS\n';
  output += '═══════════════════════════════════════════════════════════════\n\n';

  output += `Average Movement (USD):     $${result.movements.avgMovementUSD.toFixed(2)}\n`;
  output += `Average Movement (%):       ${result.movements.avgMovementPercent.toFixed(3)}%\n`;
  output += `Median Movement (USD):      $${result.movements.medianMovementUSD.toFixed(2)}\n`;
  output += `Min Movement (USD):         $${result.movements.minMovementUSD.toFixed(2)}\n`;
  output += `Max Movement (USD):         $${result.movements.maxMovementUSD.toFixed(2)}\n\n`;

  output += '═══════════════════════════════════════════════════════════════\n';
  output += '📈 UP MOVES vs 📉 DOWN MOVES\n';
  output += '═══════════════════════════════════════════════════════════════\n\n';

  output += `UP Moves:\n`;
  output += `  Count:           ${result.movements.upMoves.count.toLocaleString()}\n`;
  output += `  Avg USD:         $${result.movements.upMoves.avgUSD.toFixed(2)}\n`;
  output += `  Avg %:           ${result.movements.upMoves.avgPercent.toFixed(3)}%\n\n`;

  output += `DOWN Moves:\n`;
  output += `  Count:           ${result.movements.downMoves.count.toLocaleString()}\n`;
  output += `  Avg USD:         $${result.movements.downMoves.avgUSD.toFixed(2)}\n`;
  output += `  Avg %:           ${result.movements.downMoves.avgPercent.toFixed(3)}%\n\n`;

  output += '═══════════════════════════════════════════════════════════════\n';
  output += '🕐 VOLATILITY BY HOUR (UTC)\n';
  output += '═══════════════════════════════════════════════════════════════\n\n';

  // Sort by volatility (highest first)
  const sortedByVolatility = [...result.volatilityByHour].sort((a, b) => b.avgMovementUSD - a.avgMovementUSD);

  output += 'Most Volatile Hours:\n';
  sortedByVolatility.slice(0, 5).forEach((h, idx) => {
    output += `  ${idx + 1}. ${String(h.hour).padStart(2, '0')}:00 UTC - $${h.avgMovementUSD.toFixed(2)} avg (${h.avgMovementPercent.toFixed(3)}%) - ${h.count} rounds\n`;
  });

  output += '\nLeast Volatile Hours:\n';
  sortedByVolatility.slice(-5).reverse().forEach((h, idx) => {
    output += `  ${idx + 1}. ${String(h.hour).padStart(2, '0')}:00 UTC - $${h.avgMovementUSD.toFixed(2)} avg (${h.avgMovementPercent.toFixed(3)}%) - ${h.count} rounds\n`;
  });

  output += '\n═══════════════════════════════════════════════════════════════\n';
  output += '💡 SUMMARY\n';
  output += '═══════════════════════════════════════════════════════════════\n';
  output += `In a typical 5-minute round, BNB moves about $${result.movements.avgMovementUSD.toFixed(2)}\n`;
  output += `(${result.movements.avgMovementPercent.toFixed(3)}% of its price).\n`;
  output += '═══════════════════════════════════════════════════════════════\n';

  return output;
}
