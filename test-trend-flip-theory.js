import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('🔬 TESTING TREND FLIP THEORY\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');

const rounds = db.prepare(`
  SELECT epoch, lock_timestamp, ema_signal, ema_gap,
         t20s_bull_wei, t20s_bear_wei, winner, close_price, lock_price
  FROM rounds
  WHERE t20s_bull_wei IS NOT NULL
    AND t20s_bear_wei IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
    AND close_price IS NOT NULL
  ORDER BY epoch ASC
`).all();

console.log('Step 1: Find trend periods (high win streaks)\n');

// First pass: identify trend periods based on consecutive wins
const tradingHistory = [];
let consecutiveWins = 0;
let maxWinStreak = 0;
const trendPeriods = [];
let currentTrendStart = null;

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];

  const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
  const totalAmount = bullAmount + bearAmount;
  if (totalAmount === 0) continue;

  const bullPayout = totalAmount / bullAmount;
  const bearPayout = totalAmount / bearAmount;

  // REVERSE CROWD signal
  let signal = null;
  if (r.ema_signal === 'BULL' && bullPayout > bearPayout && bullPayout >= 1.55) {
    signal = 'BULL';
  } else if (r.ema_signal === 'BEAR' && bearPayout > bullPayout && bearPayout >= 1.55) {
    signal = 'BEAR';
  }

  if (!signal) continue;

  const won = (signal === 'BULL' && r.winner === 'bull') || (signal === 'BEAR' && r.winner === 'bear');

  tradingHistory.push({
    epoch: r.epoch,
    signal,
    won,
    closePrice: r.close_price,
    winStreak: 0 // will fill in next
  });

  if (won) {
    consecutiveWins++;
    if (consecutiveWins > maxWinStreak) maxWinStreak = consecutiveWins;

    // Mark start of potential trend (4+ wins = strong trend)
    if (consecutiveWins === 4 && !currentTrendStart) {
      currentTrendStart = tradingHistory.length - 4;
    }
  } else {
    // Loss - end of trend if we were in one
    if (currentTrendStart !== null && consecutiveWins >= 4) {
      trendPeriods.push({
        start: currentTrendStart,
        end: tradingHistory.length - 1,
        length: tradingHistory.length - currentTrendStart,
        winStreak: consecutiveWins
      });
    }
    consecutiveWins = 0;
    currentTrendStart = null;
  }
}

// Fill in win streaks
let streak = 0;
for (let i = tradingHistory.length - 1; i >= 0; i--) {
  if (tradingHistory[i].won) {
    streak++;
    tradingHistory[i].winStreak = streak;
  } else {
    streak = 0;
    tradingHistory[i].winStreak = 0;
  }
}

console.log(`Total trades analyzed: ${tradingHistory.length}`);
console.log(`Max win streak found: ${maxWinStreak}`);
console.log(`Trend periods identified (4+ win streaks): ${trendPeriods.length}\n`);

if (trendPeriods.length > 0) {
  console.log('Sample trend periods:');
  trendPeriods.slice(0, 5).forEach((tp, i) => {
    console.log(`  ${i+1}. Trades ${tp.start}-${tp.end} (${tp.length} trades, ${tp.winStreak} win streak)`);
  });
  console.log('');
}

// Analyze what happens AFTER trends end
console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('Step 2: Analyze what happens AFTER high win streaks\n');

const afterTrendStats = { wins: 0, total: 0 };
trendPeriods.forEach(tp => {
  // Look at next 5 trades after trend ends
  for (let i = tp.end + 1; i < Math.min(tp.end + 6, tradingHistory.length); i++) {
    if (tradingHistory[i].won) afterTrendStats.wins++;
    afterTrendStats.total++;
  }
});

const afterTrendWR = afterTrendStats.total > 0 ? (afterTrendStats.wins / afterTrendStats.total * 100) : 0;
console.log(`Trades immediately AFTER trend ends: ${afterTrendStats.total}`);
console.log(`Win rate: ${afterTrendWR.toFixed(1)}%`);
console.log(`Interpretation: ${afterTrendWR > 55 ? '✅ Keep trading normally' : '⚠️ Struggle after trends end'}\n`);

// Now test different trend detection methods
console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('Step 3: Test FLIP strategy with different trend detectors\n');

function testFlipStrategy(detectionMethod) {
  let bankroll = 1.0;
  let peak = bankroll;
  let maxDD = 0;
  let normalMode = true; // true = REVERSE CROWD, false = FLIPPED (follow crowd)
  let consecutiveLosses = 0;
  let trades = 0, wins = 0;
  let flippedTrades = 0, flippedWins = 0;
  let flipCount = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;
    if (totalAmount === 0) continue;

    const bullPayout = totalAmount / bullAmount;
    const bearPayout = totalAmount / bearAmount;

    // Base REVERSE CROWD signal
    let baseSignal = null;
    if (r.ema_signal === 'BULL' && bullPayout > bearPayout && bullPayout >= 1.55) {
      baseSignal = 'BULL';
    } else if (r.ema_signal === 'BEAR' && bearPayout > bullPayout && bearPayout >= 1.55) {
      baseSignal = 'BEAR';
    }

    if (!baseSignal) continue;

    // Trend detection
    let shouldFlip = false;

    if (detectionMethod === 'consecutive_losses') {
      // Flip after 3 consecutive losses
      if (consecutiveLosses >= 3) {
        shouldFlip = true;
      }
      // Exit flip after 2 consecutive wins
      if (!normalMode && consecutiveLosses === 0 && i > 0) {
        const prevWon = tradingHistory[i-1] && tradingHistory[i-1].won;
        const prev2Won = tradingHistory[i-2] && tradingHistory[i-2].won;
        if (prevWon && prev2Won) {
          normalMode = true; // Back to normal
        }
      }
    } else if (detectionMethod === 'price_momentum') {
      // Flip when price shows strong momentum (5 rounds same direction)
      if (i >= 5) {
        const last5 = rounds.slice(i - 5, i);
        const bullWins = last5.filter(r => r.winner === 'bull').length;
        shouldFlip = (bullWins >= 4 || bullWins <= 1); // Strong trend
      }
    } else if (detectionMethod === 'never') {
      // Always normal mode (baseline)
      shouldFlip = false;
    }

    // Apply flip
    if (shouldFlip && normalMode) {
      normalMode = false;
      flipCount++;
    }

    // Determine final signal
    let signal = baseSignal;
    if (!normalMode) {
      // FLIP: do opposite
      signal = baseSignal === 'BULL' ? 'BEAR' : 'BULL';
    }

    // Trade execution
    const effectiveBankroll = Math.min(bankroll, 50);
    const betAmount = effectiveBankroll * 0.045;
    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = (signal === 'BULL' && r.winner === 'bull') || (signal === 'BEAR' && r.winner === 'bear');
    const profit = won ? betAmount * (actualPayout - 1) : -betAmount;

    bankroll += profit;
    if (bankroll <= 0) break;

    if (bankroll > peak) peak = bankroll;
    const dd = ((peak - bankroll) / peak) * 100;
    if (dd > maxDD) maxDD = dd;

    trades++;
    if (won) {
      wins++;
      consecutiveLosses = 0;
    } else {
      consecutiveLosses++;
    }

    if (!normalMode) {
      flippedTrades++;
      if (won) flippedWins++;
    }
  }

  const wr = trades > 0 ? (wins / trades * 100) : 0;
  const flippedWR = flippedTrades > 0 ? (flippedWins / flippedTrades * 100) : 0;

  return {
    method: detectionMethod,
    bankroll,
    maxDD,
    trades,
    wr,
    flippedTrades,
    flippedWR,
    flipCount
  };
}

const methods = [
  { name: 'Baseline (no flip)', method: 'never' },
  { name: 'Flip after 3 losses', method: 'consecutive_losses' },
  { name: 'Flip on price momentum', method: 'price_momentum' },
];

const results = [];
for (const m of methods) {
  const result = testFlipStrategy(m.method);
  results.push({ name: m.name, ...result });
}

results.sort((a, b) => b.bankroll - a.bankroll);

console.log('Method                        │  Final   │  DD   │ Trades │  WR   │ Flipped │ Flip WR');
console.log('──────────────────────────────┼──────────┼───────┼────────┼───────┼─────────┼────────');

results.forEach(r => {
  const roi = ((r.bankroll - 1) * 100).toFixed(0);
  const flippedInfo = r.flippedTrades > 0 ? `${String(r.flippedTrades).padStart(7)} │ ${r.flippedWR.toFixed(1)}%` : '      - │     -';
  console.log(
    `${r.name.padEnd(29)} │ ${r.bankroll.toFixed(2).padStart(8)} │ ${r.maxDD.toFixed(1).padStart(5)}% │ ${String(r.trades).padStart(6)} │ ${r.wr.toFixed(1).padStart(5)}% │ ${flippedInfo}`
  );
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const winner = results[0];
console.log(`🏆 WINNER: ${winner.name}\n`);

if (winner.name.includes('no flip')) {
  console.log('❌ FLIP THEORY DOESN\'T WORK - Keep normal REVERSE CROWD strategy');
  console.log('   Flipping makes performance worse during trends.\n');
} else {
  console.log(`✅ FLIP THEORY WORKS! Using ${winner.name}`);
  console.log(`   Flip triggered ${winner.flipCount} times`);
  console.log(`   Flipped trades: ${winner.flippedTrades} (${winner.flippedWR.toFixed(1)}% WR)`);
  console.log(`   Improvement: ${((winner.bankroll / results.find(r => r.name.includes('no flip')).bankroll - 1) * 100).toFixed(1)}%\n`);
}

console.log('💡 CONCLUSION:');
console.log('   Testing if flipping to opposite signals during trends helps performance.');
