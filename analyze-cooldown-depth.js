import { initDatabase } from './db-init.js';
import fs from 'fs';

const db = initDatabase();

// Read cooldown data
const cooldownCSV = fs.readFileSync('cooldown-rounds.csv', 'utf-8').split('\n').slice(1);
const cooldownData = cooldownCSV.filter(line => line.trim()).map(line => {
  const [epoch, lock_timestamp, lock_price, close_price, winner, bull_payout, bear_payout] = line.split(',');
  return {
    epoch: parseInt(epoch),
    lock_price: parseFloat(lock_price),
    close_price: parseFloat(close_price),
    winner,
    bull_payout: parseFloat(bull_payout),
    bear_payout: parseFloat(bear_payout),
  };
});

// Get full round data with EMA
const rounds = db.prepare(`
  SELECT epoch, ema_signal, close_price
  FROM rounds
  WHERE close_price IS NOT NULL
  ORDER BY epoch ASC
`).all();

// Create lookup map
const roundMap = {};
rounds.forEach(r => {
  roundMap[r.epoch] = r;
});

console.log('🔬 DEEP ANALYSIS: Cooldown trading patterns\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

// 1. Analyze EMA signals during cooldown
console.log('📊 EMA SIGNALS DURING COOLDOWNS:\n');

let emaAvailable = 0;
let emaBullish = 0, emaBearish = 0, emaNeutral = 0;
const emaFollowTrades = [];
const trendFollowTrades = [];

for (let i = 0; i < cooldownData.length; i++) {
  const cd = cooldownData[i];
  const roundInfo = roundMap[cd.epoch];

  if (roundInfo && roundInfo.ema_signal) {
    emaAvailable++;

    if (roundInfo.ema_signal === 'BULL') emaBullish++;
    else if (roundInfo.ema_signal === 'BEAR') emaBearish++;
    else emaNeutral++;

    // Test EMA follow strategy
    if (roundInfo.ema_signal === 'BULL' && cd.bull_payout >= 1.5) {
      emaFollowTrades.push({ signal: 'BULL', won: cd.winner === 'bull', payout: cd.bull_payout });
    } else if (roundInfo.ema_signal === 'BEAR' && cd.bear_payout >= 1.5) {
      emaFollowTrades.push({ signal: 'BEAR', won: cd.winner === 'bear', payout: cd.bear_payout });
    }
  }

  // Test trend follow (if last 2 cooldown rounds same direction)
  if (i >= 2) {
    const prev2 = cooldownData.slice(i - 2, i);
    const bullCount = prev2.filter(r => r.winner === 'bull').length;

    if (bullCount === 2 && cd.bull_payout >= 1.5) {
      trendFollowTrades.push({ signal: 'BULL', won: cd.winner === 'bull', payout: cd.bull_payout });
    } else if (bullCount === 0 && cd.bear_payout >= 1.5) {
      trendFollowTrades.push({ signal: 'BEAR', won: cd.winner === 'bear', payout: cd.bear_payout });
    }
  }
}

console.log(`Total cooldown rounds: ${cooldownData.length}`);
console.log(`Rounds with EMA data: ${emaAvailable} (${(emaAvailable/cooldownData.length*100).toFixed(1)}%)`);
console.log(`  EMA Bullish: ${emaBullish} (${(emaBullish/emaAvailable*100).toFixed(1)}%)`);
console.log(`  EMA Bearish: ${emaBearish} (${(emaBearish/emaAvailable*100).toFixed(1)}%)`);
console.log(`  EMA Neutral: ${emaNeutral} (${(emaNeutral/emaAvailable*100).toFixed(1)}%)\n`);

// 2. Compare strategies
console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('💡 STRATEGY COMPARISON ON COOLDOWN ROUNDS:\n');

const emaWins = emaFollowTrades.filter(t => t.won).length;
const emaWR = emaFollowTrades.length > 0 ? (emaWins / emaFollowTrades.length * 100) : 0;

const trendWins = trendFollowTrades.filter(t => t.won).length;
const trendWR = trendFollowTrades.length > 0 ? (trendWins / trendFollowTrades.length * 100) : 0;

console.log(`EMA FOLLOW (use EMA signal, ≥1.5x):`);
console.log(`  Trades: ${emaFollowTrades.length}`);
console.log(`  Wins: ${emaWins}`);
console.log(`  Win Rate: ${emaWR.toFixed(1)}%\n`);

console.log(`TREND FOLLOW (last 2 cooldown rounds, ≥1.5x):`);
console.log(`  Trades: ${trendFollowTrades.length}`);
console.log(`  Wins: ${trendWins}`);
console.log(`  Win Rate: ${trendWR.toFixed(1)}%\n`);

// 3. Check how often patterns occur
console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('📈 PATTERN FREQUENCY:\n');

let consecutive2Bull = 0, consecutive2Bear = 0, alternating = 0;

for (let i = 2; i < cooldownData.length; i++) {
  const prev2 = cooldownData.slice(i - 2, i);
  const bullCount = prev2.filter(r => r.winner === 'bull').length;

  if (bullCount === 2) consecutive2Bull++;
  else if (bullCount === 0) consecutive2Bear++;
  else alternating++;
}

const totalPatterns = consecutive2Bull + consecutive2Bear + alternating;
console.log(`Consecutive 2 Bulls: ${consecutive2Bull} (${(consecutive2Bull/totalPatterns*100).toFixed(1)}%)`);
console.log(`Consecutive 2 Bears: ${consecutive2Bear} (${(consecutive2Bear/totalPatterns*100).toFixed(1)}%)`);
console.log(`Alternating: ${alternating} (${(alternating/totalPatterns*100).toFixed(1)}%)\n`);

console.log(`TREND opportunities (2 same direction): ${consecutive2Bull + consecutive2Bear} (${((consecutive2Bull + consecutive2Bear)/totalPatterns*100).toFixed(1)}%)\n`);

// 4. Test mean reversion with STRICT conditions
console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('🔄 MEAN REVERSION TESTS (strict conditions):\n');

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const changes = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? -c : 0);
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Get price history for RSI calculation
const priceHistory = rounds.map(r => r.close_price);
const meanReversionTests = [
  { name: 'Fade 3+ same direction', trades: 0, wins: 0 },
  { name: 'RSI extreme (<25 or >75)', trades: 0, wins: 0 },
  { name: 'Big payout gap (≥0.5x)', trades: 0, wins: 0 },
];

for (let i = 0; i < cooldownData.length; i++) {
  const cd = cooldownData[i];

  // Test 1: Fade after 3+ same direction
  if (i >= 3) {
    const prev3 = cooldownData.slice(i - 3, i);
    const bulls = prev3.filter(r => r.winner === 'bull').length;
    if (bulls >= 3 && cd.bear_payout >= 1.6) {
      meanReversionTests[0].trades++;
      if (cd.winner === 'bear') meanReversionTests[0].wins++;
    } else if (bulls === 0 && cd.bull_payout >= 1.6) {
      meanReversionTests[0].trades++;
      if (cd.winner === 'bull') meanReversionTests[0].wins++;
    }
  }

  // Test 2: RSI extreme
  const roundIdx = rounds.findIndex(r => r.epoch === cd.epoch);
  if (roundIdx >= 14) {
    const prices = priceHistory.slice(Math.max(0, roundIdx - 20), roundIdx + 1);
    const rsi = calculateRSI(prices, 14);
    if (rsi !== null && !isNaN(rsi)) {
      if (rsi < 25 && cd.bull_payout >= 1.7) {
        meanReversionTests[1].trades++;
        if (cd.winner === 'bull') meanReversionTests[1].wins++;
      } else if (rsi > 75 && cd.bear_payout >= 1.7) {
        meanReversionTests[1].trades++;
        if (cd.winner === 'bear') meanReversionTests[1].wins++;
      }
    }
  }

  // Test 3: Big payout gap
  const gap = Math.abs(cd.bull_payout - cd.bear_payout);
  if (gap >= 0.5) {
    meanReversionTests[2].trades++;
    if (cd.bull_payout > cd.bear_payout && cd.winner === 'bull') meanReversionTests[2].wins++;
    else if (cd.bear_payout > cd.bull_payout && cd.winner === 'bear') meanReversionTests[2].wins++;
  }
}

meanReversionTests.forEach(test => {
  const wr = test.trades > 0 ? (test.wins / test.trades * 100) : 0;
  const mark = wr >= 55 ? ' ✅' : wr >= 50 ? ' ⚠️' : ' ❌';
  console.log(`${test.name.padEnd(30)}: ${String(test.trades).padStart(3)} trades, ${String(test.wins).padStart(2)} wins, ${wr.toFixed(1).padStart(5)}% WR${mark}`);
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

console.log('💡 CONCLUSION:\n');
if (emaWR > trendWR && emaFollowTrades.length >= trendFollowTrades.length * 0.5) {
  console.log('✅ EMA FOLLOW is better: More trades, similar/better WR');
  console.log(`   Use EMA signal during cooldowns instead of pattern-based trend following`);
} else if (trendWR >= 55) {
  console.log('✅ TREND FOLLOW works: Pattern-based approach has good WR');
  console.log(`   ${trendFollowTrades.length} trades with ${trendWR.toFixed(1)}% WR`);
} else {
  console.log('⚠️ Both strategies are marginal');
  console.log(`   Consider skipping cooldowns or using most conservative approach`);
}

const bestMeanRev = meanReversionTests.reduce((best, curr) => {
  const currWR = curr.trades > 0 ? curr.wins / curr.trades : 0;
  const bestWR = best.trades > 0 ? best.wins / best.trades : 0;
  return currWR > bestWR ? curr : best;
});

if (bestMeanRev.trades > 0 && (bestMeanRev.wins / bestMeanRev.trades) >= 0.55) {
  console.log(`\n✅ Mean reversion CAN work: ${bestMeanRev.name}`);
  console.log(`   ${bestMeanRev.trades} trades, ${((bestMeanRev.wins/bestMeanRev.trades)*100).toFixed(1)}% WR`);
}
