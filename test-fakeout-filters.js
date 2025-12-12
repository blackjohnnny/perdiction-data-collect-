import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🔬 TESTING MULTIPLE FAKEOUT DETECTION METHODS\n');
console.log('═'.repeat(80) + '\n');

const db = initDatabase(DB_PATH);

const rounds = db.prepare(`
  SELECT
    sample_id,
    epoch,
    lock_timestamp,
    t20s_bull_wei,
    t20s_bear_wei,
    lock_price,
    close_price,
    winner,
    winner_payout_multiple,
    ema_gap
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_gap IS NOT NULL
    AND lock_price IS NOT NULL
    AND close_price IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Found ${rounds.length} complete rounds\n`);

// Strategy constants
const EMA_GAP_THRESHOLD = 0.05;
const PAYOUT_THRESHOLD = 1.45;
const MOMENTUM_THRESHOLD = 0.15;
const BASE_SIZE = 0.045;
const MOMENTUM_SIZE = 0.085;
const RECOVERY_MULTIPLIER = 1.5;

// Define multiple fakeout detection methods
const methods = [
  {
    name: 'Method 1: Price Momentum Reversal',
    description: 'Check if recent price momentum opposes our signal',
    detect: (rounds, index, signal) => {
      if (index < 3) return false;

      const prices = rounds.slice(index - 3, index + 1).map(r => Number(r.lock_price) / 1e8);

      // Calculate momentum (3-candle change)
      const priceChange = prices[3] - prices[0];
      const momentum = priceChange > 0 ? 'bullish' : 'bearish';

      // Recent acceleration
      const recentChange = prices[3] - prices[2];
      const prevChange = prices[2] - prices[1];
      const isAccelerating = Math.abs(recentChange) > Math.abs(prevChange);

      // Fakeout = strong recent momentum opposite to our signal
      if (signal === 'bull' && momentum === 'bearish' && isAccelerating) return true;
      if (signal === 'bear' && momentum === 'bullish' && isAccelerating) return true;

      return false;
    }
  },
  {
    name: 'Method 2: EMA Divergence',
    description: 'Check if EMA gap is shrinking (trend weakening)',
    detect: (rounds, index, signal) => {
      if (index < 2) return false;

      const currentGap = Math.abs(rounds[index].ema_gap);
      const prevGap = Math.abs(rounds[index - 1].ema_gap);
      const prev2Gap = Math.abs(rounds[index - 2].ema_gap);

      // EMA gap shrinking = trend losing strength = potential reversal
      const gapShrinking = currentGap < prevGap && prevGap < prev2Gap;
      const significantShrink = currentGap < prevGap * 0.7;

      return gapShrinking || significantShrink;
    }
  },
  {
    name: 'Method 3: Oversold/Overbought RSI-like',
    description: 'Detect extreme price moves that may reverse',
    detect: (rounds, index, signal) => {
      if (index < 14) return false;

      const window = 14;
      const prices = rounds.slice(index - window, index + 1).map(r => Number(r.lock_price) / 1e8);

      // Calculate price position in recent range
      const highest = Math.max(...prices);
      const lowest = Math.min(...prices);
      const current = prices[prices.length - 1];
      const range = highest - lowest;

      if (range === 0) return false;

      const position = (current - lowest) / range;

      // Extreme positions
      const overbought = position > 0.85;
      const oversold = position < 0.15;

      // Fakeout = buying BULL when overbought, BEAR when oversold
      if (signal === 'bull' && overbought) return true;
      if (signal === 'bear' && oversold) return true;

      return false;
    }
  },
  {
    name: 'Method 4: Crowd Panic Indicator',
    description: 'Extreme crowd imbalance suggests exhaustion',
    detect: (rounds, index, signal) => {
      const round = rounds[index];
      const bullWei = BigInt(round.t20s_bull_wei);
      const bearWei = BigInt(round.t20s_bear_wei);
      const totalWei = bullWei + bearWei;

      const bullPct = Number((bullWei * 10000n) / totalWei) / 100;
      const bearPct = 100 - bullPct;

      // Extreme crowd = potential reversal
      const extremeBull = bullPct > 85;
      const extremeBear = bearPct > 85;

      // Fakeout = following the extreme crowd
      if (signal === 'bull' && extremeBull) return true;
      if (signal === 'bear' && extremeBear) return true;

      return false;
    }
  },
  {
    name: 'Method 5: Volume Spike Detection',
    description: 'Sudden volume spike suggests climax/reversal',
    detect: (rounds, index, signal) => {
      if (index < 5) return false;

      const getVolume = (r) => {
        const bullWei = BigInt(r.t20s_bull_wei);
        const bearWei = BigInt(r.t20s_bear_wei);
        return Number(bullWei + bearWei);
      };

      const currentVol = getVolume(rounds[index]);
      const avgVol = rounds.slice(index - 5, index).reduce((sum, r) => sum + getVolume(r), 0) / 5;

      // Volume spike (2x average or more)
      const volumeSpike = currentVol > avgVol * 2;

      return volumeSpike;
    }
  },
  {
    name: 'Method 6: Price Extension',
    description: 'Price moved too far too fast from average',
    detect: (rounds, index, signal) => {
      if (index < 20) return false;

      const prices = rounds.slice(index - 20, index + 1).map(r => Number(r.lock_price) / 1e8);
      const avgPrice = prices.reduce((a, b) => a + b) / prices.length;
      const current = prices[prices.length - 1];

      const deviation = ((current - avgPrice) / avgPrice) * 100;

      // Extended beyond 1.5% from 20-period average
      const overextendedUp = deviation > 1.5;
      const overextendedDown = deviation < -1.5;

      if (signal === 'bull' && overextendedUp) return true;
      if (signal === 'bear' && overextendedDown) return true;

      return false;
    }
  },
  {
    name: 'Method 7: Consecutive Candles Filter',
    description: 'Too many consecutive same-direction candles',
    detect: (rounds, index, signal) => {
      if (index < 4) return false;

      const prices = rounds.slice(index - 4, index + 1).map(r => Number(r.lock_price) / 1e8);

      // Count consecutive up/down candles
      let consecutiveUp = 0;
      let consecutiveDown = 0;

      for (let i = 1; i < prices.length; i++) {
        if (prices[i] > prices[i-1]) {
          consecutiveUp++;
          consecutiveDown = 0;
        } else if (prices[i] < prices[i-1]) {
          consecutiveDown++;
          consecutiveUp = 0;
        }
      }

      // 4+ consecutive = exhaustion
      if (signal === 'bull' && consecutiveUp >= 4) return true;
      if (signal === 'bear' && consecutiveDown >= 4) return true;

      return false;
    }
  },
  {
    name: 'Method 8: Combined Multi-Factor',
    description: 'Combination of multiple signals',
    detect: (rounds, index, signal) => {
      let fakeoutScore = 0;

      // Factor 1: EMA gap shrinking
      if (index >= 2) {
        const currentGap = Math.abs(rounds[index].ema_gap);
        const prevGap = Math.abs(rounds[index - 1].ema_gap);
        if (currentGap < prevGap * 0.8) fakeoutScore += 1;
      }

      // Factor 2: Extreme crowd
      const bullWei = BigInt(rounds[index].t20s_bull_wei);
      const bearWei = BigInt(rounds[index].t20s_bear_wei);
      const totalWei = bullWei + bearWei;
      const bullPct = Number((bullWei * 10000n) / totalWei) / 100;

      if ((signal === 'bull' && bullPct > 80) || (signal === 'bear' && bullPct < 20)) {
        fakeoutScore += 1;
      }

      // Factor 3: Price position
      if (index >= 14) {
        const prices = rounds.slice(index - 14, index + 1).map(r => Number(r.lock_price) / 1e8);
        const highest = Math.max(...prices);
        const lowest = Math.min(...prices);
        const current = prices[prices.length - 1];
        const range = highest - lowest;

        if (range > 0) {
          const position = (current - lowest) / range;
          if ((signal === 'bull' && position > 0.8) || (signal === 'bear' && position < 0.2)) {
            fakeoutScore += 1;
          }
        }
      }

      // Fakeout if 2+ factors triggered
      return fakeoutScore >= 2;
    }
  }
];

// Test strategy with baseline (no filter) and each filter method
function testStrategy(rounds, filterMethod = null) {
  let bankroll = 1.0;
  let wins = 0;
  let losses = 0;
  let totalTrades = 0;
  let skippedFakeouts = 0;
  let lastTwoResults = [];
  let maxBankroll = 1.0;
  let maxDrawdown = 0;

  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i];
    const emaGap = round.ema_gap;

    if (Math.abs(emaGap) < EMA_GAP_THRESHOLD) continue;

    const signal = emaGap > 0 ? 'bull' : 'bear';

    const bullWei = BigInt(round.t20s_bull_wei);
    const bearWei = BigInt(round.t20s_bear_wei);
    const totalWei = bullWei + bearWei;
    const ourSideWei = signal === 'bull' ? bullWei : bearWei;
    const estPayout = Number(totalWei) / Number(ourSideWei);

    if (estPayout < PAYOUT_THRESHOLD) continue;

    // Apply fakeout filter if provided
    if (filterMethod && filterMethod.detect(rounds, i, signal)) {
      skippedFakeouts++;
      continue;
    }

    // Calculate bet size
    const hasMomentum = Math.abs(emaGap) > MOMENTUM_THRESHOLD;
    const lastResult = lastTwoResults[0];
    const profitTakingNext = lastTwoResults.length === 2 &&
                              lastTwoResults[0] === 'WIN' &&
                              lastTwoResults[1] === 'WIN';

    let betSize;
    if (profitTakingNext) {
      betSize = bankroll * 0.045;
    } else if (lastResult === 'LOSS') {
      betSize = bankroll * (hasMomentum ? MOMENTUM_SIZE : BASE_SIZE) * RECOVERY_MULTIPLIER;
    } else {
      betSize = bankroll * (hasMomentum ? MOMENTUM_SIZE : BASE_SIZE);
    }

    const won = round.winner === signal;

    if (won) {
      const profit = betSize * (round.winner_payout_multiple - 1);
      bankroll += profit;
      wins++;
      lastTwoResults.unshift('WIN');
    } else {
      bankroll -= betSize;
      losses++;
      lastTwoResults.unshift('LOSS');
    }

    if (lastTwoResults.length > 2) lastTwoResults.pop();
    totalTrades++;

    maxBankroll = Math.max(maxBankroll, bankroll);
    const drawdown = ((maxBankroll - bankroll) / maxBankroll) * 100;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const roi = ((bankroll - 1) / 1) * 100;

  return {
    trades: totalTrades,
    wins,
    losses,
    winRate,
    finalBankroll: bankroll,
    roi,
    maxDrawdown,
    skippedFakeouts
  };
}

console.log('🎯 BASELINE (No Filter)\n');
console.log('─'.repeat(80) + '\n');

const baseline = testStrategy(rounds);

console.log(`Trades: ${baseline.trades}`);
console.log(`Wins: ${baseline.wins} | Losses: ${baseline.losses}`);
console.log(`Win Rate: ${baseline.winRate.toFixed(2)}%`);
console.log(`Final Bankroll: ${baseline.finalBankroll.toFixed(4)} BNB`);
console.log(`ROI: ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(2)}%`);
console.log(`Max Drawdown: ${baseline.maxDrawdown.toFixed(2)}%\n`);

console.log('═'.repeat(80) + '\n');

console.log('🧪 TESTING FAKEOUT FILTERS\n');
console.log('═'.repeat(80) + '\n');

const results = [];

for (const method of methods) {
  console.log(`📊 ${method.name}`);
  console.log(`   ${method.description}\n`);

  const result = testStrategy(rounds, method);

  const winRateDiff = result.winRate - baseline.winRate;
  const roiDiff = result.roi - baseline.roi;
  const tradesDiff = result.trades - baseline.trades;

  console.log(`   Trades: ${result.trades} (${tradesDiff >= 0 ? '+' : ''}${tradesDiff})`);
  console.log(`   Skipped Fakeouts: ${result.skippedFakeouts}`);
  console.log(`   Wins: ${result.wins} | Losses: ${result.losses}`);
  console.log(`   Win Rate: ${result.winRate.toFixed(2)}% (${winRateDiff >= 0 ? '+' : ''}${winRateDiff.toFixed(2)}%)`);
  console.log(`   Final: ${result.finalBankroll.toFixed(4)} BNB`);
  console.log(`   ROI: ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(2)}% (${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}%)`);
  console.log(`   Max DD: ${result.maxDrawdown.toFixed(2)}%\n`);

  const performance = winRateDiff > 0 && roiDiff > 0 ? '✅ IMPROVED' :
                      winRateDiff > 0 || roiDiff > 0 ? '🔶 MIXED' :
                      '❌ WORSE';

  console.log(`   ${performance}\n`);
  console.log('─'.repeat(80) + '\n');

  results.push({
    method: method.name,
    winRate: result.winRate,
    roi: result.roi,
    trades: result.trades,
    skipped: result.skippedFakeouts,
    winRateDiff,
    roiDiff,
    maxDrawdown: result.maxDrawdown,
    finalBankroll: result.finalBankroll,
    improvement: winRateDiff + (roiDiff / 100) // Combined score
  });
}

console.log('═'.repeat(80) + '\n');
console.log('🏆 RANKING BY PERFORMANCE IMPROVEMENT\n');
console.log('═'.repeat(80) + '\n');

results.sort((a, b) => b.improvement - a.improvement);

console.log('┌─────┬─────────────────────────────────────┬────────────┬────────────┬──────────┐');
console.log('│ Rank│ Method                              │ Win Rate Δ │    ROI Δ   │ Trades   │');
console.log('├─────┼─────────────────────────────────────┼────────────┼────────────┼──────────┤');

results.forEach((r, index) => {
  const rank = (index + 1).toString().padStart(4);
  const name = r.method.substring(0, 35).padEnd(35);
  const wrDiff = (r.winRateDiff >= 0 ? '+' : '') + r.winRateDiff.toFixed(2) + '%';
  const roiDiff = (r.roiDiff >= 0 ? '+' : '') + r.roiDiff.toFixed(1) + '%';
  const trades = r.trades.toString();

  console.log(`│ ${rank}│ ${name} │ ${wrDiff.padStart(10)} │ ${roiDiff.padStart(10)} │ ${trades.padStart(8)} │`);
});

console.log('└─────┴─────────────────────────────────────┴────────────┴────────────┴──────────┘\n');

console.log('═'.repeat(80) + '\n');
console.log('🥇 BEST PERFORMING FILTER\n');
console.log('═'.repeat(80) + '\n');

const best = results[0];

console.log(`Method: ${best.method}`);
console.log(`Win Rate: ${best.winRate.toFixed(2)}% (${best.winRateDiff >= 0 ? '+' : ''}${best.winRateDiff.toFixed(2)}% vs baseline)`);
console.log(`ROI: ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(2)}% (${best.roiDiff >= 0 ? '+' : ''}${best.roiDiff.toFixed(2)}% vs baseline)`);
console.log(`Final Bankroll: ${best.finalBankroll.toFixed(4)} BNB`);
console.log(`Trades: ${best.trades} (skipped ${best.skipped} potential fakeouts)`);
console.log(`Max Drawdown: ${best.maxDrawdown.toFixed(2)}%\n`);

if (best.winRateDiff > 2 && best.roiDiff > 100) {
  console.log('✅ HIGHLY RECOMMENDED: This filter significantly improves performance!');
} else if (best.winRateDiff > 0 && best.roiDiff > 0) {
  console.log('🔶 RECOMMENDED: This filter shows modest improvements.');
} else {
  console.log('❌ NOT RECOMMENDED: Filters did not improve performance.');
}

console.log('\n' + '═'.repeat(80) + '\n');

db.close();
