import { getDb } from '../store/sqlite.js';
import { formatEther } from 'viem';

type RoundWithPrice = {
  epoch: number;
  lockPrice: bigint;
  closePrice: bigint;
  winner: string;
  lockTs: number;
};

export async function analyzeThreeConsecutiveUps(daysBack: number = 30): Promise<void> {
  const db = await getDb();
  const cutoffTs = Math.floor(Date.now() / 1000) - daysBack * 24 * 60 * 60;

  const result = db.exec(`
    SELECT epoch, lock_price, close_price, winner, lock_ts
    FROM rounds
    WHERE winner IN ('UP', 'DOWN')
      AND lock_ts >= ${cutoffTs}
    ORDER BY epoch ASC
  `);

  if (!result[0] || result[0].values.length < 4) {
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

  console.log(`\n📊 Three Consecutive Large UP Moves Analysis - Last ${daysBack} Days`);
  console.log(`Total rounds analyzed: ${rounds.length}\n`);
  console.log('═'.repeat(80));

  // Calculate price movements in dollar terms
  const movements = rounds.map((round) => {
    const change = round.closePrice - round.lockPrice;
    const changeDollar = Number(formatEther(change > 0n ? change : -change));
    return {
      epoch: round.epoch,
      winner: round.winner,
      changeDollar: change > 0n ? changeDollar : -changeDollar,
      changePercent: Number((change * 10000n) / round.lockPrice) / 100,
    };
  });

  console.log('\n🔍 THREE CONSECUTIVE LARGE UP MOVES (≥$1.00) → What happens on 4th round?\n');

  const dollarThresholds = [0.5, 0.75, 1.0, 1.25, 1.5];

  for (const threshold of dollarThresholds) {
    let fourthUp = 0;
    let fourthDown = 0;
    const examples: Array<{ epochs: number[]; fourth: string }> = [];

    for (let i = 3; i < movements.length; i++) {
      const m1 = movements[i - 3];
      const m2 = movements[i - 2];
      const m3 = movements[i - 1];
      const m4 = movements[i];

      // Check if first three are all UP with moves >= threshold
      if (
        m1.winner === 'UP' &&
        m2.winner === 'UP' &&
        m3.winner === 'UP' &&
        m1.changeDollar >= threshold &&
        m2.changeDollar >= threshold &&
        m3.changeDollar >= threshold
      ) {
        if (m4.winner === 'UP') {
          fourthUp++;
        } else {
          fourthDown++;
        }

        if (examples.length < 5) {
          examples.push({
            epochs: [m1.epoch, m2.epoch, m3.epoch, m4.epoch],
            fourth: m4.winner,
          });
        }
      }
    }

    const total = fourthUp + fourthDown;
    if (total > 0) {
      const downPct = ((fourthDown / total) * 100).toFixed(1);
      const upPct = ((fourthUp / total) * 100).toFixed(1);

      console.log(`≥$${threshold.toFixed(2)} moves:`);
      console.log(`  Found ${total} occurrences`);
      console.log(`  4th round: ${fourthUp} UP (${upPct}%), ${fourthDown} DOWN (${downPct}%)`);

      if (examples.length > 0) {
        console.log(`  Examples:`);
        examples.forEach((ex, idx) => {
          console.log(`    ${idx + 1}. Epochs ${ex.epochs[0]}-${ex.epochs[3]} → 4th was ${ex.fourth}`);
        });
      }
      console.log();
    } else {
      console.log(`≥$${threshold.toFixed(2)} moves: No occurrences found\n`);
    }
  }

  // Also check percentage-based
  console.log('\n🔍 THREE CONSECUTIVE LARGE UP MOVES (by %) → What happens on 4th round?\n');

  const pctThresholds = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6];

  for (const threshold of pctThresholds) {
    let fourthUp = 0;
    let fourthDown = 0;
    const examples: Array<{ epochs: number[]; amounts: number[]; fourth: string; fourthAmount: number }> = [];

    for (let i = 3; i < movements.length; i++) {
      const m1 = movements[i - 3];
      const m2 = movements[i - 2];
      const m3 = movements[i - 1];
      const m4 = movements[i];

      if (
        m1.winner === 'UP' &&
        m2.winner === 'UP' &&
        m3.winner === 'UP' &&
        m1.changePercent >= threshold &&
        m2.changePercent >= threshold &&
        m3.changePercent >= threshold
      ) {
        if (m4.winner === 'UP') fourthUp++;
        else fourthDown++;

        if (examples.length < 3) {
          examples.push({
            epochs: [m1.epoch, m2.epoch, m3.epoch, m4.epoch],
            amounts: [m1.changePercent, m2.changePercent, m3.changePercent],
            fourth: m4.winner,
            fourthAmount: m4.changePercent,
          });
        }
      }
    }

    const total = fourthUp + fourthDown;
    if (total > 0) {
      const downPct = ((fourthDown / total) * 100).toFixed(1);
      const upPct = ((fourthUp / total) * 100).toFixed(1);
      console.log(
        `≥${threshold}%: ${total.toString().padStart(4)} occurrences → 4th: ${fourthUp.toString().padStart(3)} UP (${upPct.padStart(5)}%), ${fourthDown.toString().padStart(3)} DOWN (${downPct.padStart(5)}%)`
      );

      if (examples.length > 0 && threshold <= 0.3) {
        examples.forEach((ex, idx) => {
          console.log(
            `       Example ${idx + 1}: ${ex.amounts.map((a) => a.toFixed(2) + '%').join(', ')} → 4th: ${ex.fourth} (${ex.fourthAmount >= 0 ? '+' : ''}${ex.fourthAmount.toFixed(2)}%)`
          );
        });
      }
    }
  }

  console.log('\n═'.repeat(80));
  console.log('💡 KEY INSIGHT:');
  console.log('   If 4th round DOWN rate is >55%, bet DOWN after 3 consecutive large UPs');
  console.log('   If close to 50%, pattern is random - no edge\n');
}
