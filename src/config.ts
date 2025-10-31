import dotenv from 'dotenv';

dotenv.config();

export const config = {
  bscRpc: process.env.BSC_RPC || 'https://bsc-dataseed.binance.org',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '3000', 10),
  predictionContractAddress: '0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA' as const,
  dbPath: process.env.DB_PATH || './data/prediction-data.db',
  concurrency: parseInt(process.env.CONCURRENCY || '6', 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || '5', 10),
  retryBaseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS || '200', 10),
} as const;
