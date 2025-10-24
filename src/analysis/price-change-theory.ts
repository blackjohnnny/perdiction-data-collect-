import { getDb } from '../store/sqlite.js';
import { formatEther } from 'viem';

type RoundWithPrice = {
  epoch: number;
  lockPrice: bigint;
  closePrice: bigint;
  winner: string;
  lockTs: number;
};

export async function analyzePriceChangeTheory(daysBack: number = 30): Promise<void> {
  const db = await getDb();
  const cutoffTs = Math.floor(Date.now() / 1000) - daysBack * 24 * 60 * 60;

  const result = db.exec(`
    SELECT epoch, lock_price, close_price, winner, lock_ts
    FROM rounds
    WHERE winner IN ('UP', 'DOWN')
      AND lock_ts >= ${cutoffTs}
    ORDER BY epoch ASC
  `);

  if (!result[0] || result[0].values.length < 3) {
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

  console.log(`\n📊 Price Change Theory Analysis - Last ${daysBack} Days`);
  console.log(`Total rounds analyzed: ${rounds.length}\n`);
  console.log('═'.repeat(80));

  // Calculate price movements
  const movements = rounds.map((round) => {
    const change = round.closePrice - round.lockPrice;
    const changePercent = Number((change * 10000n) / round.lockPrice) / 100;
    const changeDollar = Number(formatEther(change > 0n ? change : -change));
    return {
      epoch: round.epoch,
      winner: round.winner,
      changePercent,
      changeDollar: change > 0n ? changeDollar : -changeDollar,
      magnitude: Math.abs(changePercent),
    };
  });

  // 1. Large move followed by reversal
  console.log('\n🔍 THEORY 1: Large Price Moves → Reversal Pattern');
  console.log('If price moves LARGE in one direction, does it reverse next round?\n');

  const thresholds = [0.3, 0.4, 0.5, 0.6, 0.8];

  for (const threshold of thresholds) {
    const largeUpMoves = movements.filter((m, idx) => {
      if (idx === 0) return false;
      const prev = movements[idx - 1];
      return prev.changePercent >= threshold;
    });

    const largeDownMoves = movements.filter((m, idx) => {
      if (idx === 0) return false;
      const prev = movements[idx - 1];
      return prev.changePercent <= -threshold;
    });

    if (largeUpMoves.length > 0) {
      const reversals = largeUpMoves.filter((m) => m.winner === 'DOWN').length;
      const reversalRate = (reversals / largeUpMoves.length) * 100;
      console.log(
        `After LARGE UP move (≥${threshold}%): ${reversals}/${largeUpMoves.length} reversed (${reversalRate.toFixed(1)}% DOWN next)`
      );
    }

    if (largeDownMoves.length > 0) {
      const reversals = largeDownMoves.filter((m) => m.winner === 'UP').length;
      const reversalRate = (reversals / largeDownMoves.length) * 100;
      console.log(
        `After LARGE DOWN move (≤-${threshold}%): ${reversals}/${largeDownMoves.length} reversed (${reversalRate.toFixed(1)}% UP next)`
      );
    }
  }

  // 2. Consecutive large moves
  console.log('\n🔍 THEORY 2: Two Consecutive Large Moves → Third Move Pattern');
  console.log('After two large moves in SAME direction, what happens next?\n');

  for (const threshold of [0.4, 0.5, 0.6]) {
    let twoUpThenUp = 0;
    let twoUpThenDown = 0;
    let twoDownThenUp = 0;
    let twoDownThenDown = 0;

    for (let i = 2; i < movements.length; i++) {
      const prev2 = movements[i - 2];
      const prev1 = movements[i - 1];
      const current = movements[i];

      // Two consecutive UP moves
      if (prev2.changePercent >= threshold && prev1.changePercent >= threshold) {
        if (current.winner === 'UP') twoUpThenUp++;
        else twoUpThenDown++;
      }

      // Two consecutive DOWN moves
      if (prev2.changePercent <= -threshold && prev1.changePercent <= -threshold) {
        if (current.winner === 'UP') twoDownThenUp++;
        else twoDownThenDown++;
      }
    }

    const totalTwoUp = twoUpThenUp + twoUpThenDown;
    const totalTwoDown = twoDownThenUp + twoDownThenDown;

    if (totalTwoUp > 0) {
      console.log(
        `Two UP moves (≥${threshold}%): ${twoUpThenUp}/${totalTwoUp} continued UP (${((twoUpThenUp / totalTwoUp) * 100).toFixed(1)}%), ` +
          `${twoUpThenDown}/${totalTwoUp} reversed DOWN (${((twoUpThenDown / totalTwoUp) * 100).toFixed(1)}%)`
      );
    }

    if (totalTwoDown > 0) {
      console.log(
        `Two DOWN moves (≤-${threshold}%): ${twoDownThenUp}/${totalTwoDown} reversed UP (${((twoDownThenUp / totalTwoDown) * 100).toFixed(1)}%), ` +
          `${twoDownThenDown}/${totalTwoDown} continued DOWN (${((twoDownThenDown / totalTwoDown) * 100).toFixed(1)}%)`
      );
    }
  }

  // 3. Volatility clustering
  console.log('\n🔍 THEORY 3: Volatility Clustering');
  console.log('Do large moves tend to follow large moves (regardless of direction)?\n');

  const avgMagnitude = movements.reduce((sum, m) => sum + m.magnitude, 0) / movements.length;
  console.log(`Average price movement: ${avgMagnitude.toFixed(3)}%`);

  for (const threshold of [0.4, 0.5, 0.6]) {
    let largeFollowedByLarge = 0;
    let largeFollowedBySmall = 0;

    for (let i = 1; i < movements.length; i++) {
      const prev = movements[i - 1];
      const current = movements[i];

      if (prev.magnitude >= threshold) {
        if (current.magnitude >= threshold) {
          largeFollowedByLarge++;
        } else {
          largeFollowedBySmall++;
        }
      }
    }

    const total = largeFollowedByLarge + largeFollowedBySmall;
    if (total > 0) {
      console.log(
        `After move ≥${threshold}%: ${largeFollowedByLarge}/${total} (${((largeFollowedByLarge / total) * 100).toFixed(1)}%) had another large move`
      );
    }
  }

  // 4. Movement size distribution
  console.log('\n🔍 THEORY 4: Price Movement Distribution\n');

  const bins = [
    { label: '0-0.1%', min: 0, max: 0.1 },
    { label: '0.1-0.2%', min: 0.1, max: 0.2 },
    { label: '0.2-0.3%', min: 0.2, max: 0.3 },
    { label: '0.3-0.5%', min: 0.3, max: 0.5 },
    { label: '0.5-0.8%', min: 0.5, max: 0.8 },
    { label: '>0.8%', min: 0.8, max: Infinity },
  ];

  bins.forEach((bin) => {
    const count = movements.filter((m) => m.magnitude >= bin.min && m.magnitude < bin.max).length;
    const pct = (count / movements.length) * 100;
    const bar = '█'.repeat(Math.floor(pct / 2));
    console.log(`${bin.label.padEnd(12)} ${count.toString().padStart(5)} (${pct.toFixed(1)}%) ${bar}`);
  });

  console.log('\n═'.repeat(80));
  console.log('💡 INSIGHTS:');
  console.log('   - Look for reversal patterns after large moves (>0.5%)');
  console.log('   - Volatility clustering: large moves often followed by more large moves');
  console.log('   - Most moves are small (<0.3%) - random/unpredictable');
  console.log('   - Strategy opportunity: Bet AGAINST extreme moves (mean reversion)\n');
}
