import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('📊 PERFORMANCE TREND ANALYSIS\n');
console.log('═'.repeat(100) + '\n');
console.log('Question: After GOOD performance, do we get BAD performance?\n');
console.log('         After BAD performance, do we get GOOD/MEDIUM/BAD performance?\n');
console.log('─'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Analyzing ${rounds.length} complete rounds\n\n`);

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0
};

// Run consensus strategy and track performance windows
function analyzePerformanceTrends() {
  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  const tradeLog = [];

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const emaSignal = r.ema_signal;
    if (!emaSignal || emaSignal === 'NEUTRAL') continue;

    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    let signal = null;
    // Consensus
    if (emaSignal === 'BULL' && bullPayout < 1.45) {
      signal = 'BULL';
    } else if (emaSignal === 'BEAR' && bearPayout < 1.45) {
      signal = 'BEAR';
    }

    if (!signal) continue;

    let sizeMultiplier = 1.0;
    const emaGap = parseFloat(r.ema_gap) || 0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;

    if (hasStrongSignal) {
      sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    if (lastTwoResults.length >= 2 && lastTwoResults.slice(-2).every(r => !r)) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betSize = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    if (betSize > bankroll) continue;

    const actualPayout = parseFloat(r.winner_payout_multiple);
    const won = signal.toLowerCase() === r.winner.toLowerCase();

    const prevBankroll = bankroll;

    if (won) {
      const profit = betSize * (actualPayout - 1);
      bankroll += profit;
    } else {
      bankroll -= betSize;
    }

    const roiChange = ((bankroll - prevBankroll) / prevBankroll) * 100;

    lastTwoResults.push(won);
    if (lastTwoResults.length > 20) lastTwoResults.shift();

    tradeLog.push({
      index: tradeLog.length,
      won,
      bankroll,
      roiChange
    });
  }

  return tradeLog;
}

console.log('Running baseline strategy and tracking performance...\n\n');

const tradeLog = analyzePerformanceTrends();

console.log('═'.repeat(100) + '\n');
console.log('📈 PERFORMANCE WINDOW ANALYSIS\n');
console.log('═'.repeat(100) + '\n\n');

// Analyze different window sizes
const windows = [5, 10, 15, 20];

for (const windowSize of windows) {
  console.log(`─`.repeat(100));
  console.log(`\n🔍 WINDOW SIZE: ${windowSize} trades\n`);
  console.log(`─`.repeat(100) + '\n');

  const trends = {
    afterGood: { good: 0, medium: 0, bad: 0 },
    afterMedium: { good: 0, medium: 0, bad: 0 },
    afterBad: { good: 0, medium: 0, bad: 0 }
  };

  for (let i = windowSize; i < tradeLog.length - windowSize; i++) {
    // Calculate performance of PREVIOUS window
    const prevWindow = tradeLog.slice(i - windowSize, i);
    const prevWins = prevWindow.filter(t => t.won).length;
    const prevWR = (prevWins / windowSize) * 100;

    // Calculate performance of NEXT window
    const nextWindow = tradeLog.slice(i, i + windowSize);
    const nextWins = nextWindow.filter(t => t.won).length;
    const nextWR = (nextWins / windowSize) * 100;

    // Classify previous performance
    let prevPerf;
    if (prevWR >= 60) prevPerf = 'good';
    else if (prevWR >= 50) prevPerf = 'medium';
    else prevPerf = 'bad';

    // Classify next performance
    let nextPerf;
    if (nextWR >= 60) nextPerf = 'good';
    else if (nextWR >= 50) nextPerf = 'medium';
    else nextPerf = 'bad';

    // Record trend
    trends[`after${prevPerf.charAt(0).toUpperCase() + prevPerf.slice(1)}`][nextPerf]++;
  }

  // Display results
  console.log('After GOOD performance (WR ≥60%):');
  const totalAfterGood = trends.afterGood.good + trends.afterGood.medium + trends.afterGood.bad;
  if (totalAfterGood > 0) {
    const goodPct = (trends.afterGood.good / totalAfterGood * 100).toFixed(1);
    const mediumPct = (trends.afterGood.medium / totalAfterGood * 100).toFixed(1);
    const badPct = (trends.afterGood.bad / totalAfterGood * 100).toFixed(1);

    console.log(`  Next ${windowSize} trades: ${goodPct}% GOOD | ${mediumPct}% MEDIUM | ${badPct}% BAD`);
    console.log(`  (${trends.afterGood.good}G, ${trends.afterGood.medium}M, ${trends.afterGood.bad}B out of ${totalAfterGood} occurrences)`);

    // Determine trend
    if (trends.afterGood.bad > trends.afterGood.good) {
      console.log(`  ⚠️  TREND: GOOD → BAD (${badPct}% chance of bad performance)`);
    } else if (trends.afterGood.good > trends.afterGood.bad) {
      console.log(`  ✅ TREND: GOOD → GOOD (${goodPct}% continues good performance)`);
    } else {
      console.log(`  ➡️  TREND: GOOD → MEDIUM (${mediumPct}% regresses to mean)`);
    }
  } else {
    console.log('  No data (no good performance periods found)');
  }
  console.log();

  console.log('After MEDIUM performance (WR 50-60%):');
  const totalAfterMedium = trends.afterMedium.good + trends.afterMedium.medium + trends.afterMedium.bad;
  if (totalAfterMedium > 0) {
    const goodPct = (trends.afterMedium.good / totalAfterMedium * 100).toFixed(1);
    const mediumPct = (trends.afterMedium.medium / totalAfterMedium * 100).toFixed(1);
    const badPct = (trends.afterMedium.bad / totalAfterMedium * 100).toFixed(1);

    console.log(`  Next ${windowSize} trades: ${goodPct}% GOOD | ${mediumPct}% MEDIUM | ${badPct}% BAD`);
    console.log(`  (${trends.afterMedium.good}G, ${trends.afterMedium.medium}M, ${trends.afterMedium.bad}B out of ${totalAfterMedium} occurrences)`);

    // Determine trend
    if (trends.afterMedium.good > trends.afterMedium.bad) {
      console.log(`  ✅ TREND: MEDIUM → GOOD (${goodPct}% improves)`);
    } else if (trends.afterMedium.bad > trends.afterMedium.good) {
      console.log(`  ⚠️  TREND: MEDIUM → BAD (${badPct}% deteriorates)`);
    } else {
      console.log(`  ➡️  TREND: MEDIUM → MEDIUM (${mediumPct}% stays stable)`);
    }
  } else {
    console.log('  No data');
  }
  console.log();

  console.log('After BAD performance (WR <50%):');
  const totalAfterBad = trends.afterBad.good + trends.afterBad.medium + trends.afterBad.bad;
  if (totalAfterBad > 0) {
    const goodPct = (trends.afterBad.good / totalAfterBad * 100).toFixed(1);
    const mediumPct = (trends.afterBad.medium / totalAfterBad * 100).toFixed(1);
    const badPct = (trends.afterBad.bad / totalAfterBad * 100).toFixed(1);

    console.log(`  Next ${windowSize} trades: ${goodPct}% GOOD | ${mediumPct}% MEDIUM | ${badPct}% BAD`);
    console.log(`  (${trends.afterBad.good}G, ${trends.afterBad.medium}M, ${trends.afterBad.bad}B out of ${totalAfterBad} occurrences)`);

    // Determine trend
    if (trends.afterBad.good > trends.afterBad.bad) {
      console.log(`  ✅ TREND: BAD → GOOD (${goodPct}% bounces back)`);
    } else if (trends.afterBad.bad > trends.afterBad.good) {
      console.log(`  ⚠️  TREND: BAD → BAD (${badPct}% continues bad performance)`);
    } else {
      console.log(`  ➡️  TREND: BAD → MEDIUM (${mediumPct}% partial recovery)`);
    }
  } else {
    console.log('  No data');
  }
  console.log('\n');
}

console.log('═'.repeat(100) + '\n');
console.log('📊 CORRELATION SUMMARY\n');
console.log('═'.repeat(100) + '\n');

// Calculate overall correlation
const correlations = [];

for (let lookback = 5; lookback <= 20; lookback++) {
  for (let lookahead = 5; lookahead <= 20; lookahead++) {
    let correlation = 0;
    let count = 0;

    for (let i = lookback; i < tradeLog.length - lookahead; i++) {
      const prevWindow = tradeLog.slice(i - lookback, i);
      const prevWins = prevWindow.filter(t => t.won).length;
      const prevWR = (prevWins / lookback) * 100;

      const nextWindow = tradeLog.slice(i, i + lookahead);
      const nextWins = nextWindow.filter(t => t.won).length;
      const nextWR = (nextWins / lookahead) * 100;

      // Positive correlation: good → good, bad → bad
      // Negative correlation: good → bad, bad → good
      const prevScore = prevWR - 50; // -50 to +50
      const nextScore = nextWR - 50; // -50 to +50

      correlation += (prevScore * nextScore) / (50 * 50); // Normalize
      count++;
    }

    if (count > 0) {
      correlation /= count;
      correlations.push({ lookback, lookahead, correlation, count });
    }
  }
}

// Find strongest correlations
correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

console.log('Top 5 Strongest Correlations:\n');

for (let i = 0; i < Math.min(5, correlations.length); i++) {
  const c = correlations[i];
  const type = c.correlation > 0 ? '✅ POSITIVE' : '⚠️  NEGATIVE';
  const meaning = c.correlation > 0
    ? 'Good → Good, Bad → Bad (momentum continues)'
    : 'Good → Bad, Bad → Good (mean reversion)';

  console.log(`${i + 1}. Look back ${c.lookback} trades → Look ahead ${c.lookahead} trades`);
  console.log(`   Correlation: ${c.correlation.toFixed(3)} (${type})`);
  console.log(`   Meaning: ${meaning}`);
  console.log(`   Sample size: ${c.count} windows\n`);
}

console.log('═'.repeat(100) + '\n');
console.log('🎯 ACTIONABLE INSIGHTS:\n');
console.log('─'.repeat(100) + '\n');

const strongestCorr = correlations[0];

if (Math.abs(strongestCorr.correlation) > 0.1) {
  if (strongestCorr.correlation > 0) {
    console.log(`✅ MOMENTUM EFFECT DETECTED (correlation: ${strongestCorr.correlation.toFixed(3)})\n`);
    console.log(`After ${strongestCorr.lookback} trades of good performance:`);
    console.log(`  → Next ${strongestCorr.lookahead} trades likely to be GOOD\n`);
    console.log(`After ${strongestCorr.lookback} trades of bad performance:`);
    console.log(`  → Next ${strongestCorr.lookahead} trades likely to be BAD\n`);
    console.log(`💡 Strategy: INCREASE position size after good runs, DECREASE after bad runs\n`);
  } else {
    console.log(`⚠️  MEAN REVERSION DETECTED (correlation: ${strongestCorr.correlation.toFixed(3)})\n`);
    console.log(`After ${strongestCorr.lookback} trades of good performance:`);
    console.log(`  → Next ${strongestCorr.lookahead} trades likely to be BAD\n`);
    console.log(`After ${strongestCorr.lookback} trades of bad performance:`);
    console.log(`  → Next ${strongestCorr.lookahead} trades likely to be GOOD\n`);
    console.log(`💡 Strategy: DECREASE position size after good runs, INCREASE after bad runs\n`);
  }
} else {
  console.log(`➡️  NO STRONG CORRELATION FOUND (${strongestCorr.correlation.toFixed(3)})\n`);
  console.log(`Performance appears RANDOM - past performance doesn't predict future\n`);
  console.log(`💡 Strategy: Use fixed position sizing, don't adjust based on recent performance\n`);
}

console.log('═'.repeat(100));

db.close();
