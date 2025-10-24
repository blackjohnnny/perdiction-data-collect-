import { getDb } from '../store/sqlite.js';
import { formatEther } from 'viem';

type RoundWithPrice = {
  epoch: number;
  lockPrice: bigint;
  closePrice: bigint;
  winner: string;
  lockTs: number;
};

export async function analyzeAdvancedPatterns(daysBack: number = 30): Promise<void> {
  const db = await getDb();
  const cutoffTs = Math.floor(Date.now() / 1000) - daysBack * 24 * 60 * 60;

  const result = db.exec(`
    SELECT epoch, lock_price, close_price, winner, lock_ts
    FROM rounds
    WHERE winner IN ('UP', 'DOWN')
      AND lock_ts >= ${cutoffTs}
    ORDER BY epoch ASC
  `);

  if (!result[0] || result[0].values.length < 10) {
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

  console.log(`\n📊 Advanced Pattern Analysis - Last ${daysBack} Days`);
  console.log(`Total rounds: ${rounds.length}\n`);
  console.log('═'.repeat(80));

  // PATTERN 1: Alternating pattern break
  console.log('\n🔍 PATTERN 1: Alternating Breaks (UP-DOWN-UP-DOWN → 5th breaks pattern?)');
  console.log('After perfect alternation, does it continue or break?\n');

  let altBreaks = 0;
  let altContinues = 0;

  for (let i = 4; i < movements.length; i++) {
    const m1 = movements[i - 4];
    const m2 = movements[i - 3];
    const m3 = movements[i - 2];
    const m4 = movements[i - 1];
    const m5 = movements[i];

    // Check for alternating pattern
    if (
      m1.winner === 'UP' &&
      m2.winner === 'DOWN' &&
      m3.winner === 'UP' &&
      m4.winner === 'DOWN'
    ) {
      if (m5.winner === 'UP') altContinues++;
      else altBreaks++;
    } else if (
      m1.winner === 'DOWN' &&
      m2.winner === 'UP' &&
      m3.winner === 'DOWN' &&
      m4.winner === 'UP'
    ) {
      if (m5.winner === 'DOWN') altContinues++;
      else altBreaks++;
    }
  }

  const altTotal = altBreaks + altContinues;
  if (altTotal > 0) {
    console.log(`Found ${altTotal} alternating patterns`);
    console.log(`  Pattern continues: ${altContinues} (${((altContinues / altTotal) * 100).toFixed(1)}%)`);
    console.log(`  Pattern breaks: ${altBreaks} (${((altBreaks / altTotal) * 100).toFixed(1)}%)`);
  } else {
    console.log('No alternating patterns found');
  }

  // PATTERN 2: Large move followed by same direction small move
  console.log('\n🔍 PATTERN 2: Large Move → Small Same Direction → Reversal?');
  console.log('Big UP, then small UP → does it reverse DOWN?\n');

  for (const largeThreshold of [0.3, 0.4, 0.5]) {
    for (const smallThreshold of [0.05, 0.1, 0.15]) {
      let reversals = 0;
      let continuations = 0;

      for (let i = 2; i < movements.length; i++) {
        const m1 = movements[i - 2];
        const m2 = movements[i - 1];
        const m3 = movements[i];

        // Large UP, small UP → ?
        if (
          m1.winner === 'UP' &&
          m1.changePercent >= largeThreshold &&
          m2.winner === 'UP' &&
          m2.changePercent < smallThreshold
        ) {
          if (m3.winner === 'DOWN') reversals++;
          else continuations++;
        }

        // Large DOWN, small DOWN → ?
        if (
          m1.winner === 'DOWN' &&
          m1.changePercent <= -largeThreshold &&
          m2.winner === 'DOWN' &&
          m2.changePercent > -smallThreshold
        ) {
          if (m3.winner === 'UP') reversals++;
          else continuations++;
        }
      }

      const total = reversals + continuations;
      if (total >= 5) {
        console.log(
          `Large ≥${largeThreshold}%, then small <${smallThreshold}%: ${reversals}/${total} reversed (${((reversals / total) * 100).toFixed(1)}%)`
        );
      }
    }
  }

  // PATTERN 3: Streak exhaustion
  console.log('\n🔍 PATTERN 3: Streak Exhaustion (4+ same direction → reversal?)');
  console.log('After 4, 5, 6+ in same direction, what happens next?\n');

  for (const streakLen of [4, 5, 6, 7]) {
    let reversals = 0;
    let continuations = 0;

    for (let i = streakLen; i < movements.length; i++) {
      let isUpStreak = true;
      let isDownStreak = true;

      // Check if previous N are all same direction
      for (let j = 1; j <= streakLen; j++) {
        if (movements[i - j].winner !== 'UP') isUpStreak = false;
        if (movements[i - j].winner !== 'DOWN') isDownStreak = false;
      }

      if (isUpStreak && movements[i].winner === 'DOWN') reversals++;
      else if (isUpStreak && movements[i].winner === 'UP') continuations++;
      else if (isDownStreak && movements[i].winner === 'UP') reversals++;
      else if (isDownStreak && movements[i].winner === 'DOWN') continuations++;
    }

    const total = reversals + continuations;
    if (total > 0) {
      console.log(
        `After ${streakLen} in a row: ${reversals}/${total} reversed (${((reversals / total) * 100).toFixed(1)}%)`
      );
    }
  }

  // PATTERN 4: Momentum with magnitude
  console.log('\n🔍 PATTERN 4: Building Momentum (increasing magnitude UPs)');
  console.log('UP with 0.1%, then UP with 0.2%, then UP with 0.3%+ → reversal?\n');

  let buildingMomentumRev = 0;
  let buildingMomentumCont = 0;

  for (let i = 3; i < movements.length; i++) {
    const m1 = movements[i - 3];
    const m2 = movements[i - 2];
    const m3 = movements[i - 1];
    const m4 = movements[i];

    // Three UPs with increasing magnitude
    if (
      m1.winner === 'UP' &&
      m2.winner === 'UP' &&
      m3.winner === 'UP' &&
      m2.changePercent > m1.changePercent &&
      m3.changePercent > m2.changePercent &&
      m3.changePercent >= 0.2
    ) {
      if (m4.winner === 'DOWN') buildingMomentumRev++;
      else buildingMomentumCont++;
    }

    // Three DOWNs with increasing magnitude
    if (
      m1.winner === 'DOWN' &&
      m2.winner === 'DOWN' &&
      m3.winner === 'DOWN' &&
      m2.changePercent < m1.changePercent &&
      m3.changePercent < m2.changePercent &&
      m3.changePercent <= -0.2
    ) {
      if (m4.winner === 'UP') buildingMomentumRev++;
      else buildingMomentumCont++;
    }
  }

  const momentumTotal = buildingMomentumRev + buildingMomentumCont;
  if (momentumTotal > 0) {
    console.log(`Found ${momentumTotal} building momentum patterns`);
    console.log(
      `  4th round reversal: ${buildingMomentumRev} (${((buildingMomentumRev / momentumTotal) * 100).toFixed(1)}%)`
    );
    console.log(
      `  4th round continuation: ${buildingMomentumCont} (${((buildingMomentumCont / momentumTotal) * 100).toFixed(1)}%)`
    );
  }

  // PATTERN 5: V-shaped reversal
  console.log('\n🔍 PATTERN 5: Sharp Reversal Continuation');
  console.log('Large UP → Large DOWN → does it continue DOWN or bounce UP?\n');

  for (const threshold of [0.3, 0.4, 0.5]) {
    let bounceUp = 0;
    let continueDown = 0;

    for (let i = 2; i < movements.length; i++) {
      const m1 = movements[i - 2];
      const m2 = movements[i - 1];
      const m3 = movements[i];

      // Large UP, then Large DOWN
      if (m1.changePercent >= threshold && m2.changePercent <= -threshold) {
        if (m3.winner === 'UP') bounceUp++;
        else continueDown++;
      }

      // Large DOWN, then Large UP
      if (m1.changePercent <= -threshold && m2.changePercent >= threshold) {
        if (m3.winner === 'DOWN') continueDown++;
        else bounceUp++;
      }
    }

    const total = bounceUp + continueDown;
    if (total >= 5) {
      console.log(
        `Sharp reversal ≥${threshold}%: ${bounceUp}/${total} bounced back (${((bounceUp / total) * 100).toFixed(1)}%), ${continueDown}/${total} continued (${((continueDown / total) * 100).toFixed(1)}%)`
      );
    }
  }

  console.log('\n═'.repeat(80));
  console.log('💡 SUMMARY:');
  console.log('   Look for patterns with >55% win rate and >20 occurrences');
  console.log('   Best patterns are usually exhaustion/reversal based\n');
}
