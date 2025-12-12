import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🔄 TESTING: WITH CROWD + FAKEOUT FILTER\n');
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
const MOMENTUM_THRESHOLD = 0.15;
const BASE_SIZE = 0.045;
const MOMENTUM_SIZE = 0.085;
const RECOVERY_MULTIPLIER = 1.5;
const LOOKBACK = 12;

// Test 4 scenarios
const scenarios = [
  {
    name: 'BASELINE: Against Crowd (Payout ≥1.45x), No Filter',
    payoutFilter: 'against', // payout >= 1.45
    fakeoutFilter: false
  },
  {
    name: 'WITH CROWD: Payout <1.45x, No Filter',
    payoutFilter: 'with', // payout < 1.45
    fakeoutFilter: false
  },
  {
    name: 'AGAINST CROWD: Payout ≥1.45x, WITH Fakeout Filter',
    payoutFilter: 'against',
    fakeoutFilter: true
  },
  {
    name: 'WITH CROWD: Payout <1.45x, WITH Fakeout Filter',
    payoutFilter: 'with',
    fakeoutFilter: true
  }
];

function calculateFakeoutScore(rounds, index, signal) {
  let score = 0;

  // Factor 1: EMA Gap Shrinking
  if (index >= 1) {
    const currentGap = Math.abs(rounds[index].ema_gap);
    const previousGap = Math.abs(rounds[index - 1].ema_gap);

    if (currentGap < previousGap * 0.8) {
      score += 1;
    }
  }

  // Factor 2: Extreme Crowd
  const bullWei = BigInt(rounds[index].t20s_bull_wei);
  const bearWei = BigInt(rounds[index].t20s_bear_wei);
  const totalWei = bullWei + bearWei;
  const bullPct = Number((bullWei * 10000n) / totalWei) / 100;

  if ((signal === 'bull' && bullPct > 80) || (signal === 'bear' && bullPct < 20)) {
    score += 1;
  }

  // Factor 3: Price Position
  if (index >= 14) {
    const prices = rounds.slice(index - 14, index + 1).map(r => Number(r.lock_price) / 1e8);
    const highest = Math.max(...prices);
    const lowest = Math.min(...prices);
    const current = prices[prices.length - 1];
    const range = highest - lowest;

    if (range > 0) {
      const position = (current - lowest) / range;

      if ((signal === 'bull' && position > 0.8) || (signal === 'bear' && position < 0.2)) {
        score += 1;
      }
    }
  }

  return score;
}

function testScenario(scenario) {
  let bankroll = 1.0;
  let wins = 0;
  let losses = 0;
  let totalTrades = 0;
  let lastTwoResults = [];
  let maxBankroll = 1.0;
  let maxDrawdown = 0;
  let skippedByFakeout = 0;
  let skippedByPayout = 0;

  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i];
    const emaGap = round.ema_gap;

    // Check EMA signal
    if (Math.abs(emaGap) < EMA_GAP_THRESHOLD) continue;

    const signal = emaGap > 0 ? 'bull' : 'bear';

    // Calculate estimated payout at T-20s
    const bullWei = BigInt(round.t20s_bull_wei);
    const bearWei = BigInt(round.t20s_bear_wei);
    const totalWei = bullWei + bearWei;
    const ourSideWei = signal === 'bull' ? bullWei : bearWei;
    const estPayout = Number(totalWei) / Number(ourSideWei);

    // Apply payout filter
    if (scenario.payoutFilter === 'against') {
      // Against crowd: payout >= 1.45 (minority side)
      if (estPayout < 1.45) {
        skippedByPayout++;
        continue;
      }
    } else if (scenario.payoutFilter === 'with') {
      // With crowd: payout < 1.45 (majority side)
      if (estPayout >= 1.45) {
        skippedByPayout++;
        continue;
      }
    }

    // Apply fakeout filter if enabled
    if (scenario.fakeoutFilter) {
      const fakeoutScore = calculateFakeoutScore(rounds, i, signal);
      if (fakeoutScore >= 2) {
        skippedByFakeout++;
        continue;
      }
    }

    // Calculate bet size with dynamic positioning
    const hasMomentum = Math.abs(emaGap) > MOMENTUM_THRESHOLD;
    const lastResult = lastTwoResults[0];
    const profitTakingNext = lastTwoResults.length === 2 &&
                              lastTwoResults[0] === 'WIN' &&
                              lastTwoResults[1] === 'WIN';

    let betSize;
    if (profitTakingNext) {
      betSize = bankroll * BASE_SIZE;
    } else if (lastResult === 'LOSS') {
      betSize = bankroll * (hasMomentum ? MOMENTUM_SIZE : BASE_SIZE) * RECOVERY_MULTIPLIER;
    } else {
      betSize = bankroll * (hasMomentum ? MOMENTUM_SIZE : BASE_SIZE);
    }

    // Execute trade
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
    skippedByFakeout,
    skippedByPayout
  };
}

console.log('🧪 TESTING ALL SCENARIOS\n');
console.log('═'.repeat(80) + '\n');

const results = [];

for (const scenario of scenarios) {
  console.log(`📊 ${scenario.name}\n`);

  const result = testScenario(scenario);

  console.log(`   Trades: ${result.trades}`);
  console.log(`   Wins: ${result.wins} | Losses: ${result.losses}`);
  console.log(`   Win Rate: ${result.winRate.toFixed(2)}%`);
  console.log(`   Final Bankroll: ${result.finalBankroll.toFixed(4)} BNB`);
  console.log(`   ROI: ${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(2)}%`);
  console.log(`   Max Drawdown: ${result.maxDrawdown.toFixed(2)}%`);
  console.log(`   Skipped by Payout Filter: ${result.skippedByPayout}`);
  console.log(`   Skipped by Fakeout Filter: ${result.skippedByFakeout}\n`);

  console.log('─'.repeat(80) + '\n');

  results.push({
    name: scenario.name,
    ...result
  });
}

console.log('═'.repeat(80) + '\n');
console.log('📈 COMPARISON TABLE\n');
console.log('═'.repeat(80) + '\n');

console.log('┌────────────────────────────────────────┬────────┬──────────┬──────────────┬──────────────┐');
console.log('│ Strategy                               │ Trades │ Win Rate │ Final (BNB)  │     ROI      │');
console.log('├────────────────────────────────────────┼────────┼──────────┼──────────────┼──────────────┤');

for (const r of results) {
  const name = r.name.substring(0, 38).padEnd(38);
  const trades = r.trades.toString().padStart(6);
  const winRate = (r.winRate.toFixed(2) + '%').padStart(8);
  const final = r.finalBankroll.toFixed(2).padStart(12);
  const roi = ((r.roi >= 0 ? '+' : '') + r.roi.toFixed(0) + '%').padStart(12);

  console.log(`│ ${name} │ ${trades} │ ${winRate} │ ${final} │ ${roi} │`);
}

console.log('└────────────────────────────────────────┴────────┴──────────┴──────────────┴──────────────┘\n');

console.log('═'.repeat(80) + '\n');
console.log('🔍 KEY INSIGHTS\n');
console.log('═'.repeat(80) + '\n');

const baseline = results[0];
const withCrowd = results[1];
const againstCrowdFiltered = results[2];
const withCrowdFiltered = results[3];

console.log('💡 AGAINST CROWD vs WITH CROWD (No Filter):\n');
console.log(`   Against Crowd: ${baseline.winRate.toFixed(2)}% win rate, ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(0)}% ROI`);
console.log(`   With Crowd:    ${withCrowd.winRate.toFixed(2)}% win rate, ${withCrowd.roi >= 0 ? '+' : ''}${withCrowd.roi.toFixed(0)}% ROI`);
console.log(`   Difference:    ${(baseline.roi - withCrowd.roi).toFixed(0)}% ROI advantage for AGAINST CROWD\n`);

console.log('💡 FAKEOUT FILTER IMPACT:\n');
console.log(`   Against Crowd + Filter: ${againstCrowdFiltered.roi >= 0 ? '+' : ''}${againstCrowdFiltered.roi.toFixed(0)}% ROI (${(againstCrowdFiltered.roi - baseline.roi).toFixed(0)}% improvement)`);
console.log(`   With Crowd + Filter:    ${withCrowdFiltered.roi >= 0 ? '+' : ''}${withCrowdFiltered.roi.toFixed(0)}% ROI (${(withCrowdFiltered.roi - withCrowd.roi).toFixed(0)}% improvement)\n`);

console.log('🏆 BEST STRATEGY:\n');
const best = results.reduce((max, r) => r.roi > max.roi ? r : max);
console.log(`   ${best.name}`);
console.log(`   Win Rate: ${best.winRate.toFixed(2)}%`);
console.log(`   ROI: ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(2)}%`);
console.log(`   Final: ${best.finalBankroll.toFixed(2)} BNB\n`);

console.log('❌ WORST STRATEGY:\n');
const worst = results.reduce((min, r) => r.roi < min.roi ? r : min);
console.log(`   ${worst.name}`);
console.log(`   Win Rate: ${worst.winRate.toFixed(2)}%`);
console.log(`   ROI: ${worst.roi >= 0 ? '+' : ''}${worst.roi.toFixed(2)}%`);
console.log(`   Final: ${worst.finalBankroll.toFixed(2)} BNB\n`);

console.log('═'.repeat(80) + '\n');

console.log('📊 ANSWER TO YOUR QUESTION:\n');
console.log('═'.repeat(80) + '\n');

console.log('Question: "What if we bet WITH crowd + keep fakeout filter?"\n');
console.log(`Answer:\n`);
console.log(`   WITH CROWD + FILTER:     ${withCrowdFiltered.finalBankroll.toFixed(2)} BNB (${withCrowdFiltered.roi >= 0 ? '+' : ''}${withCrowdFiltered.roi.toFixed(0)}% ROI)`);
console.log(`   AGAINST CROWD + FILTER:  ${againstCrowdFiltered.finalBankroll.toFixed(2)} BNB (${againstCrowdFiltered.roi >= 0 ? '+' : ''}${againstCrowdFiltered.roi.toFixed(0)}% ROI)\n`);

const diff = againstCrowdFiltered.roi - withCrowdFiltered.roi;
console.log(`   Performance Gap: ${diff.toFixed(0)}% ROI difference\n`);

if (diff > 500) {
  console.log('   ✅ RECOMMENDATION: Stay AGAINST CROWD (contrarian)');
  console.log('      Betting with the majority kills profitability.');
} else if (diff > 0) {
  console.log('   🔶 RECOMMENDATION: AGAINST CROWD is better but both work');
} else {
  console.log('   ⚠️ SURPRISING: WITH CROWD performs better!');
}

console.log('\n' + '═'.repeat(80) + '\n');

db.close();
