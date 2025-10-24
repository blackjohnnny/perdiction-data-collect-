import { getDb } from '../store/sqlite.js';
import { formatEther } from 'viem';

type RoundWithPrice = {
  epoch: number;
  lockPrice: bigint;
  closePrice: bigint;
  winner: string;
  lockTs: number;
};

export async function analyzeTrendPeriods(daysBack: number = 30): Promise<void> {
  const db = await getDb();
  const cutoffTs = Math.floor(Date.now() / 1000) - daysBack * 24 * 60 * 60;

  const result = db.exec(`
    SELECT epoch, lock_price, close_price, winner, lock_ts
    FROM rounds
    WHERE winner IN ('UP', 'DOWN')
      AND lock_ts >= ${cutoffTs}
    ORDER BY lock_ts ASC
  `);

  if (!result[0] || result[0].values.length < 100) {
    console.log('Not enough data for analysis');
    return;
  }

  const rounds: RoundWithPrice[] = result[0].values.map(([epoch, lockPrice, closePrice, winner, lockTs]) => ({
    epoch: Number(epoch),
    lockPrice: BigInt(lockPrice as string),
    closePrice: BigInt(closePrice as string),
    winner: String(winner),
    lockTs: Number(lockTs),
  }));

  console.log(`\n📊 Price Trend Period Analysis - Last ${daysBack} Days`);
  console.log(`Total rounds: ${rounds.length}\n`);
  console.log('═'.repeat(100));

  // Group by time windows and detect trending periods
  const windowSizes = [1, 2, 3, 6, 12]; // hours

  for (const windowHours of windowSizes) {
    console.log(`\n🔍 ANALYSIS: ${windowHours}-Hour Windows\n`);

    const windowSeconds = windowHours * 60 * 60;
    const trendingPeriods: Array<{
      start: number;
      end: number;
      upWins: number;
      downWins: number;
      priceChange: number;
      priceChangePct: number;
      upRate: number;
      bias: number;
    }> = [];

    // Slide through time windows
    let windowStart = rounds[0].lockTs;
    const lastTs = rounds[rounds.length - 1].lockTs;

    while (windowStart + windowSeconds <= lastTs) {
      const windowEnd = windowStart + windowSeconds;

      // Get rounds in this window
      const windowRounds = rounds.filter((r) => r.lockTs >= windowStart && r.lockTs < windowEnd);

      if (windowRounds.length < 20) {
        windowStart += windowSeconds;
        continue;
      }

      const upWins = windowRounds.filter((r) => r.winner === 'UP').length;
      const downWins = windowRounds.filter((r) => r.winner === 'DOWN').length;
      const total = upWins + downWins;
      const upRate = (upWins / total) * 100;

      // Calculate actual BNB price movement in this window
      const firstPrice = windowRounds[0].lockPrice;
      const lastPrice = windowRounds[windowRounds.length - 1].lockPrice;
      const priceChange = Number(formatEther(lastPrice - firstPrice));
      const priceChangePct = Number(((lastPrice - firstPrice) * 10000n) / firstPrice) / 100;

      // Calculate bias: how much UP wins deviate from 50%
      const bias = upRate - 50;

      trendingPeriods.push({
        start: windowStart,
        end: windowEnd,
        upWins,
        downWins,
        priceChange,
        priceChangePct,
        upRate,
        bias,
      });

      windowStart += windowSeconds;
    }

    // Find periods with strongest bias
    const sortedByBias = [...trendingPeriods].sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias));
    const strongBiasPeriods = sortedByBias.filter((p) => Math.abs(p.bias) >= 10).slice(0, 10);

    if (strongBiasPeriods.length === 0) {
      console.log('No periods with significant bias (≥10%) found\n');
      continue;
    }

    console.log(`Found ${strongBiasPeriods.length} periods with ≥10% bias:\n`);

    strongBiasPeriods.forEach((period, idx) => {
      const startDate = new Date(period.start * 1000);
      const endDate = new Date(period.end * 1000);

      const formatDate = (d: Date) => {
        const day = d.getDate().toString().padStart(2, '0');
        const month = d.toLocaleString('en-US', { month: 'short' });
        const year = d.getFullYear().toString().slice(-2);
        const hours = d.getHours().toString().padStart(2, '0');
        const mins = d.getMinutes().toString().padStart(2, '0');
        return `${day}/${month}/${year} ${hours}:${mins}`;
      };

      const direction = period.bias > 0 ? 'UP' : 'DOWN';
      const total = period.upWins + period.downWins;

      console.log(`${idx + 1}. ${formatDate(startDate)} → ${formatDate(endDate)}`);
      console.log(
        `   Bias: ${direction} had ${Math.abs(period.bias).toFixed(1)}% higher win rate (${period.upWins}/${total} = ${period.upRate.toFixed(1)}% UP)`
      );
      console.log(
        `   BNB Price: ${period.priceChange >= 0 ? '+' : ''}$${period.priceChange.toFixed(2)} (${period.priceChangePct >= 0 ? '+' : ''}${period.priceChangePct.toFixed(2)}%)`
      );

      // Check if bias aligns with price movement
      const aligned =
        (period.bias > 0 && period.priceChangePct > 0) || (period.bias < 0 && period.priceChangePct < 0);
      console.log(`   Correlation: ${aligned ? '✓ Bias ALIGNED with price trend' : '✗ Bias NOT aligned with price trend'}`);
      console.log();
    });

    // Calculate overall correlation
    let alignedCount = 0;
    let totalWithMovement = 0;

    trendingPeriods.forEach((p) => {
      if (Math.abs(p.priceChangePct) > 0.5) {
        // Only count periods with meaningful price movement
        totalWithMovement++;
        const aligned = (p.bias > 0 && p.priceChangePct > 0) || (p.bias < 0 && p.priceChangePct < 0);
        if (aligned) alignedCount++;
      }
    });

    if (totalWithMovement > 0) {
      console.log(`📈 Correlation Summary:`);
      console.log(
        `   ${alignedCount}/${totalWithMovement} periods (${((alignedCount / totalWithMovement) * 100).toFixed(1)}%) had win bias ALIGNED with BNB price trend`
      );
      console.log();
    }
  }

  console.log('═'.repeat(100));
  console.log('💡 KEY INSIGHTS:');
  console.log('   - If bias aligns with BNB price trend: Market follows overall trend');
  console.log('   - If bias does NOT align: Prediction market is independent of price movement');
  console.log('   - Look for periods with strong bias (>15%) to trade in that direction\n');
}
