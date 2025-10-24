import { getCurrentEpoch, getRound } from '../contract.js';
import { upsertRound } from '../store/sqlite.js';
import { config } from '../config.js';

export type BackfillOptions = {
  from: number | 'latest';
  to: number | 'latest';
  concurrency?: number;
  onProgress?: (epoch: number, total: number) => void;
};

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = config.maxRetries,
  baseDelay: number = config.retryBaseDelayMs
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

async function processEpoch(epoch: number): Promise<void> {
  const round = await retryWithBackoff(() => getRound(BigInt(epoch)));
  await upsertRound(round);
}

class PromisePool {
  private pending: Set<Promise<void>> = new Set();
  private maxConcurrency: number;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  async add(promiseFn: () => Promise<void>): Promise<void> {
    while (this.pending.size >= this.maxConcurrency) {
      await Promise.race(this.pending);
    }

    const promise = promiseFn()
      .finally(() => {
        this.pending.delete(promise);
      });

    this.pending.add(promise);
  }

  async drain(): Promise<void> {
    await Promise.all(this.pending);
  }
}

export async function backfillHistorical(options: BackfillOptions): Promise<void> {
  const currentEpoch = await getCurrentEpoch();
  const currentEpochNum = Number(currentEpoch);

  // Resolve 'latest' to actual epoch numbers
  const fromEpoch = options.from === 'latest' ? currentEpochNum : options.from;
  const toEpoch = options.to === 'latest' ? currentEpochNum : options.to;

  if (fromEpoch > toEpoch) {
    throw new Error(`Invalid range: from (${fromEpoch}) > to (${toEpoch})`);
  }

  const total = toEpoch - fromEpoch + 1;
  const concurrency = options.concurrency || config.concurrency;

  console.log(`Starting backfill: epochs ${fromEpoch} to ${toEpoch} (${total} rounds)`);
  console.log(`Concurrency: ${concurrency}, Max retries: ${config.maxRetries}`);

  const pool = new PromisePool(concurrency);
  let processed = 0;
  let lastLoggedProgress = 0;

  for (let epoch = fromEpoch; epoch <= toEpoch; epoch++) {
    const currentEpoch = epoch;

    await pool.add(async () => {
      try {
        await processEpoch(currentEpoch);
        processed++;

        // Log progress every 100 epochs or at completion
        if (processed - lastLoggedProgress >= 100 || processed === total) {
          console.log(`Progress: ${processed}/${total} (${((processed / total) * 100).toFixed(1)}%)`);
          lastLoggedProgress = processed;
        }

        if (options.onProgress) {
          options.onProgress(currentEpoch, total);
        }
      } catch (error) {
        console.error(`Failed to process epoch ${currentEpoch}:`, error);
        throw error;
      }
    });
  }

  await pool.drain();
  console.log(`Backfill complete: ${processed} rounds processed`);
}
