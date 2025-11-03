import { getCurrentEpoch, getRound, calculateImpliedMultiples } from '../contract.js';
import { upsertRound, upsertSnapshot, hasSnapshot } from '../store/sqlite.js';
import { config } from '../config.js';

export type LiveWatcherOptions = {
  pollIntervalMs?: number;
  onNewRound?: (epoch: number) => void;
  onSnapshot?: (epoch: number) => void;
};

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runLiveWatcher(options: LiveWatcherOptions = {}): Promise<void> {
  const pollInterval = options.pollIntervalMs || config.pollIntervalMs;

  console.log(`Starting live watcher (poll interval: ${pollInterval}ms)`);

  let lastSeenEpoch = await getCurrentEpoch();
  console.log(`Initial epoch: ${lastSeenEpoch}`);

  // Track which epochs we've attempted snapshots for (separate for each type)
  const snapshot20sAttempted = new Set<string>();
  const snapshot8sAttempted = new Set<string>();
  const snapshot4sAttempted = new Set<string>();

  while (true) {
    try {
      const nowEpoch = await getCurrentEpoch();

      // New epoch detected - previous one just closed
      if (nowEpoch > lastSeenEpoch) {
        console.log(`New epoch detected: ${nowEpoch} (previous: ${lastSeenEpoch})`);

        // Fetch and store the final data for the previous epoch
        try {
          const previousRound = await getRound(lastSeenEpoch);
          await upsertRound(previousRound);
          console.log(`Stored final data for epoch ${lastSeenEpoch}`);

          if (options.onNewRound) {
            options.onNewRound(Number(lastSeenEpoch));
          }
        } catch (error) {
          console.error(`Failed to fetch final data for epoch ${lastSeenEpoch}:`, error);
        }

        lastSeenEpoch = nowEpoch;
      }

      // Handle snapshots for current epoch
      try {
        const currentRound = await getRound(nowEpoch);
        const lockTimestamp = Number(currentRound.lockTimestamp);
        const nowSeconds = Math.floor(Date.now() / 1000);
        const timeUntilLock = lockTimestamp - nowSeconds;

        const epochKey = nowEpoch.toString();

        // Capture T-20s snapshot (20 seconds before lock)
        if (
          timeUntilLock <= 22 &&
          timeUntilLock > 17 &&
          !snapshot20sAttempted.has(epochKey) &&
          !(await hasSnapshot(nowEpoch, 'T_MINUS_20S'))
        ) {
          console.log(`Capturing T-20s snapshot for epoch ${nowEpoch} (${timeUntilLock}s until lock)`);

          const { impliedUp, impliedDown } = calculateImpliedMultiples(
            currentRound.totalAmount,
            currentRound.bullAmount,
            currentRound.bearAmount
          );

          await upsertSnapshot(
            nowEpoch,
            currentRound.totalAmount,
            currentRound.bullAmount,
            currentRound.bearAmount,
            impliedUp,
            impliedDown,
            'T_MINUS_20S'
          );

          snapshot20sAttempted.add(epochKey);
          console.log(
            `T-20s snapshot saved for epoch ${nowEpoch}: ` +
              `impliedUp=${impliedUp?.toFixed(3)}, impliedDown=${impliedDown?.toFixed(3)}`
          );

          if (options.onSnapshot) {
            options.onSnapshot(Number(nowEpoch));
          }
        }

        // Capture T-8s snapshot (8 seconds before lock)
        if (
          timeUntilLock <= 10 &&
          timeUntilLock > 6 &&
          !snapshot8sAttempted.has(epochKey) &&
          !(await hasSnapshot(nowEpoch, 'T_MINUS_8S'))
        ) {
          console.log(`Capturing T-8s snapshot for epoch ${nowEpoch} (${timeUntilLock}s until lock)`);

          const { impliedUp, impliedDown } = calculateImpliedMultiples(
            currentRound.totalAmount,
            currentRound.bullAmount,
            currentRound.bearAmount
          );

          await upsertSnapshot(
            nowEpoch,
            currentRound.totalAmount,
            currentRound.bullAmount,
            currentRound.bearAmount,
            impliedUp,
            impliedDown,
            'T_MINUS_8S'
          );

          snapshot8sAttempted.add(epochKey);
          console.log(
            `T-8s snapshot saved for epoch ${nowEpoch}: ` +
              `impliedUp=${impliedUp?.toFixed(3)}, impliedDown=${impliedDown?.toFixed(3)}`
          );

          if (options.onSnapshot) {
            options.onSnapshot(Number(nowEpoch));
          }
        }

        // Capture T-4s snapshot (4 seconds before lock)
        if (
          timeUntilLock <= 6 &&
          timeUntilLock > 2 &&
          !snapshot4sAttempted.has(epochKey) &&
          !(await hasSnapshot(nowEpoch, 'T_MINUS_4S'))
        ) {
          console.log(`Capturing T-4s snapshot for epoch ${nowEpoch} (${timeUntilLock}s until lock)`);

          const { impliedUp, impliedDown } = calculateImpliedMultiples(
            currentRound.totalAmount,
            currentRound.bullAmount,
            currentRound.bearAmount
          );

          await upsertSnapshot(
            nowEpoch,
            currentRound.totalAmount,
            currentRound.bullAmount,
            currentRound.bearAmount,
            impliedUp,
            impliedDown,
            'T_MINUS_4S'
          );

          snapshot4sAttempted.add(epochKey);
          console.log(
            `T-4s snapshot saved for epoch ${nowEpoch}: ` +
              `impliedUp=${impliedUp?.toFixed(3)}, impliedDown=${impliedDown?.toFixed(3)}`
          );

          if (options.onSnapshot) {
            options.onSnapshot(Number(nowEpoch));
          }
        }

        // Clean up old snapshot attempts (keep last 100)
        if (snapshot20sAttempted.size > 100) {
          const sorted = Array.from(snapshot20sAttempted)
            .map((s) => BigInt(s))
            .sort((a, b) => Number(a - b));
          const toRemove = sorted.slice(0, sorted.length - 100);
          toRemove.forEach((epoch) => snapshot20sAttempted.delete(epoch.toString()));
        }
        if (snapshot8sAttempted.size > 100) {
          const sorted = Array.from(snapshot8sAttempted)
            .map((s) => BigInt(s))
            .sort((a, b) => Number(a - b));
          const toRemove = sorted.slice(0, sorted.length - 100);
          toRemove.forEach((epoch) => snapshot8sAttempted.delete(epoch.toString()));
        }
        if (snapshot4sAttempted.size > 100) {
          const sorted = Array.from(snapshot4sAttempted)
            .map((s) => BigInt(s))
            .sort((a, b) => Number(a - b));
          const toRemove = sorted.slice(0, sorted.length - 100);
          toRemove.forEach((epoch) => snapshot4sAttempted.delete(epoch.toString()));
        }
      } catch (error) {
        console.error(`Error checking snapshot for epoch ${nowEpoch}:`, error);
      }

      await sleep(pollInterval);
    } catch (error) {
      console.error('Error in live watcher loop:', error);
      await sleep(pollInterval * 2); // Back off on error
    }
  }
}
