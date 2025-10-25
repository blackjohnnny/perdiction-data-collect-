import initSqlJs from 'sql.js';
import fs from 'fs';
import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';

const RPC_URL = process.env.RPC_URL || 'https://bsc-dataseed1.binance.org';

const client = createPublicClient({
  chain: bsc,
  transport: http(RPC_URL),
});

const CHAINLINK_BNB_USD = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';

const ABI = [
  {
    inputs: [{ internalType: 'uint80', name: 'roundId', type: 'uint80' }],
    name: 'getRoundData',
    outputs: [
      { internalType: 'uint80', name: 'roundId', type: 'uint80' },
      { internalType: 'int256', name: 'answer', type: 'int256' },
      { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
      { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
      { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { internalType: 'uint80', name: 'roundId', type: 'uint80' },
      { internalType: 'int256', name: 'answer', type: 'int256' },
      { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
      { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
      { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

console.log('=== EMA TREND ANALYSIS ===\n');
console.log('Testing if EMA trends help predict outcomes during high-bias periods\n');

const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync('prediction-data.db'));

// Get snapshot rounds with winners
const snapshots = db.exec(`
  SELECT s.epoch, s.taken_at, s.bull_amount_wei, s.bear_amount_wei,
         r.lock_price, r.close_price, r.winner, r.lock_ts
  FROM snapshots s
  JOIN rounds r ON s.epoch = r.epoch
  WHERE r.winner IN ('UP', 'DOWN')
  ORDER BY s.taken_at ASC
`);

if (!snapshots[0] || snapshots[0].values.length === 0) {
  console.log('No snapshot data found');
  db.close();
  process.exit(0);
}

const rounds = snapshots[0].values.map(row => ({
  epoch: row[0],
  takenAt: row[1],
  bullAmount: BigInt(row[2]),
  bearAmount: BigInt(row[3]),
  lockPrice: BigInt(row[4]),
  closePrice: BigInt(row[5]),
  winner: row[6],
  lockTs: row[7]
}));

console.log(`Analyzing ${rounds.length} snapshot rounds\n`);

// Get Chainlink oracle data around each round to calculate EMA
console.log('Fetching Chainlink price data for EMA calculation...\n');

// Get latest round ID to work backwards
const latest = await client.readContract({
  address: CHAINLINK_BNB_USD,
  abi: ABI,
  functionName: 'latestRoundData',
});

const latestRoundId = latest[0];
console.log(`Latest Chainlink round: ${latestRoundId}\n`);

// EMA calculation helper
function calculateEMA(prices, period) {
  if (prices.length < period) return null;

  const multiplier = 2 / (period + 1);

  // Start with SMA for first value
  let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;

  // Calculate EMA for remaining values
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }

  return ema;
}

// Test different EMA strategies
console.log('Testing EMA strategies:\n');

const strategies = {
  ema9_vs_ema21: { correct: 0, wrong: 0, name: 'EMA 9 vs 21 (fast > slow = UP)' },
  ema12_vs_ema26: { correct: 0, wrong: 0, name: 'EMA 12 vs 26 (MACD-style)' },
  ema_slope_5: { correct: 0, wrong: 0, name: 'EMA 5 slope (rising = UP)' },
  ema_slope_9: { correct: 0, wrong: 0, name: 'EMA 9 slope (rising = UP)' },
  crowd_only: { correct: 0, wrong: 0, name: 'Crowd (baseline - no EMA)' },
  ema9_AND_crowd: { correct: 0, wrong: 0, name: 'EMA 9 > 21 AND agree with crowd' },
  ema_contradict_crowd: { correct: 0, wrong: 0, name: 'EMA when it contradicts crowd' }
};

// For each snapshot, get historical prices
let processed = 0;
const skip = Math.max(1, Math.floor(rounds.length / 10)); // Show 10 progress updates

for (let i = 0; i < rounds.length; i++) {
  const round = rounds[i];

  try {
    // Find Chainlink round closest to snapshot time
    // Search backwards from latest round
    let searchRoundId = latestRoundId;
    let targetTime = round.takenAt;
    let closestRound = null;
    let attempts = 0;
    const maxAttempts = 100;

    // Binary search-like approach to find round near target time
    while (attempts < maxAttempts) {
      try {
        const roundData = await client.readContract({
          address: CHAINLINK_BNB_USD,
          abi: ABI,
          functionName: 'getRoundData',
          args: [searchRoundId],
        });

        const updatedAt = Number(roundData[3]);

        if (Math.abs(updatedAt - targetTime) < 3600) { // Within 1 hour
          closestRound = { id: searchRoundId, timestamp: updatedAt, price: Number(roundData[1]) };
          break;
        }

        if (updatedAt > targetTime) {
          searchRoundId = searchRoundId - 100n; // Go back
        } else {
          searchRoundId = searchRoundId + 50n; // Go forward
        }

        attempts++;
      } catch (e) {
        searchRoundId = searchRoundId - 10n;
        attempts++;
      }
    }

    if (!closestRound) {
      continue; // Skip this round if we can't find oracle data
    }

    // Get previous 30 rounds for EMA calculation
    const prices = [];
    for (let j = 0; j < 30; j++) {
      try {
        const roundData = await client.readContract({
          address: CHAINLINK_BNB_USD,
          abi: ABI,
          functionName: 'getRoundData',
          args: [closestRound.id - BigInt(j)],
        });
        prices.unshift(Number(roundData[1]) / 1e8); // Convert to regular price
      } catch (e) {
        break;
      }
    }

    if (prices.length < 26) {
      continue; // Need at least 26 prices for EMA26
    }

    // Calculate EMAs
    const ema5 = calculateEMA(prices, 5);
    const ema9 = calculateEMA(prices, 9);
    const ema12 = calculateEMA(prices, 12);
    const ema21 = calculateEMA(prices, 21);
    const ema26 = calculateEMA(prices, 26);

    // Calculate slopes
    const ema5_prev = calculateEMA(prices.slice(0, -1), 5);
    const ema9_prev = calculateEMA(prices.slice(0, -1), 9);
    const ema5_slope = ema5 > ema5_prev ? 'UP' : 'DOWN';
    const ema9_slope = ema9 > ema9_prev ? 'UP' : 'DOWN';

    // Determine crowd bet
    const crowdBet = round.bullAmount > round.bearAmount ? 'UP' : 'DOWN';

    // Strategy 1: EMA 9 vs 21
    const ema9_signal = ema9 > ema21 ? 'UP' : 'DOWN';
    if (ema9_signal === round.winner) strategies.ema9_vs_ema21.correct++;
    else strategies.ema9_vs_ema21.wrong++;

    // Strategy 2: EMA 12 vs 26 (MACD-style)
    const ema12_signal = ema12 > ema26 ? 'UP' : 'DOWN';
    if (ema12_signal === round.winner) strategies.ema12_vs_ema26.correct++;
    else strategies.ema12_vs_ema26.wrong++;

    // Strategy 3: EMA 5 slope
    if (ema5_slope === round.winner) strategies.ema_slope_5.correct++;
    else strategies.ema_slope_5.wrong++;

    // Strategy 4: EMA 9 slope
    if (ema9_slope === round.winner) strategies.ema_slope_9.correct++;
    else strategies.ema_slope_9.wrong++;

    // Baseline: Crowd
    if (crowdBet === round.winner) strategies.crowd_only.correct++;
    else strategies.crowd_only.wrong++;

    // Strategy 6: EMA 9 AND crowd agree
    if (ema9_signal === crowdBet && ema9_signal === round.winner) {
      strategies.ema9_AND_crowd.correct++;
    } else if (ema9_signal === crowdBet && ema9_signal !== round.winner) {
      strategies.ema9_AND_crowd.wrong++;
    }

    // Strategy 7: EMA contradicts crowd - follow EMA
    if (ema9_signal !== crowdBet) {
      if (ema9_signal === round.winner) strategies.ema_contradict_crowd.correct++;
      else strategies.ema_contradict_crowd.wrong++;
    }

    processed++;

    if (processed % skip === 0) {
      console.log(`Progress: ${processed}/${rounds.length} (${(processed*100/rounds.length).toFixed(0)}%)`);
    }

  } catch (error) {
    console.error(`Error processing epoch ${round.epoch}:`, error.message);
  }
}

console.log(`\n✓ Processed ${processed} rounds\n`);
console.log('='.repeat(80));
console.log('RESULTS\n');

// Calculate and display results
const results = [];

for (const [key, data] of Object.entries(strategies)) {
  const total = data.correct + data.wrong;
  if (total === 0) continue;

  const winRate = (data.correct * 100 / total);
  const edge = winRate - 51.5; // Need >51.5% to beat house edge
  const profitable = edge > 0 ? '✓' : '✗';

  results.push({
    name: data.name,
    wins: data.correct,
    losses: data.wrong,
    total,
    winRate,
    edge,
    profitable
  });
}

// Sort by edge (best first)
results.sort((a, b) => b.edge - a.edge);

console.log('Strategy Performance (sorted by edge):\n');
results.forEach((r, i) => {
  console.log(`${i + 1}. ${r.name}`);
  console.log(`   Wins: ${r.wins}/${r.total} (${r.winRate.toFixed(1)}%)`);
  console.log(`   Edge: ${r.edge > 0 ? '+' : ''}${r.edge.toFixed(1)}% ${r.profitable}`);
  console.log(`   Profitable: ${r.edge > 0 ? 'YES' : 'NO'}`);
  console.log('');
});

console.log('='.repeat(80));
console.log('\nCONCLUSION:\n');

const bestStrategy = results[0];
const baseline = results.find(r => r.name.includes('baseline') || r.name.includes('Crowd'));

if (bestStrategy.edge > baseline.edge) {
  console.log(`✓ EMA helps! Best strategy: "${bestStrategy.name}"`);
  console.log(`  Improvement: +${(bestStrategy.edge - baseline.edge).toFixed(1)}% over crowd-following`);
} else {
  console.log(`✗ EMA doesn't help significantly in this dataset`);
  console.log(`  Best result: ${bestStrategy.edge.toFixed(1)}% vs baseline ${baseline.edge.toFixed(1)}%`);
}

db.close();
