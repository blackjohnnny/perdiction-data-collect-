import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('🔬 TESTING FOLLOW→REVERSE FLIP THEORY\n');
console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('Theory: Start in FOLLOW CROWD mode (safer)');
console.log('        Detect trends → FLIP to REVERSE CROWD (exploit)');
console.log('        Trend ends → FLIP back to FOLLOW CROWD\n');
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

function testStrategy(detectionMethod, flipThreshold, exitThreshold) {
  let bankroll = 1.0;
  let peak = bankroll;
  let maxDD = 0;

  let mode = 'FOLLOW'; // Start in FOLLOW CROWD mode
  let consecutiveWins = 0;
  let consecutiveLosses = 0;
  let lastTwoResults = [];

  let trades = 0, wins = 0;
  let followTrades = 0, followWins = 0;
  let reverseTrades = 0, reverseWins = 0;
  let flipToReverseCount = 0;
  let flipToFollowCount = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;
    if (totalAmount === 0) continue;

    const bullPayout = totalAmount / bullAmount;
    const bearPayout = totalAmount / bearAmount;

    let signal = null;

    // Calculate signal based on current mode
    if (mode === 'FOLLOW') {
      // FOLLOW CROWD: Bet on LOW payout side (where crowd is)
      if (r.ema_signal === 'BULL') {
        if (bullPayout < bearPayout && bullPayout >= 1.55) {
          signal = 'BULL'; // Crowd betting bull, follow them
        }
      } else if (r.ema_signal === 'BEAR') {
        if (bearPayout < bullPayout && bearPayout >= 1.55) {
          signal = 'BEAR'; // Crowd betting bear, follow them
        }
      }
    } else {
      // REVERSE CROWD: Bet on HIGH payout side (fade crowd)
      if (r.ema_signal === 'BULL') {
        if (bullPayout > bearPayout && bullPayout >= 1.55) {
          signal = 'BULL'; // Crowd betting bear, fade them
        }
      } else if (r.ema_signal === 'BEAR') {
        if (bearPayout > bullPayout && bearPayout >= 1.55) {
          signal = 'BEAR'; // Crowd betting bull, fade them
        }
      }
    }

    if (!signal) continue;

    // Position sizing
    const effectiveBankroll = Math.min(bankroll, 50);
    let positionMultiplier = 1.0;

    if (r.ema_gap >= 0.05) {
      positionMultiplier *= 2.2;
    }

    if (lastTwoResults.length >= 2 && lastTwoResults.every(r => !r)) {
      positionMultiplier *= 1.5;
    }

    const betAmount = effectiveBankroll * 0.045 * positionMultiplier;
    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = (signal === 'BULL' && r.winner === 'bull') || (signal === 'BEAR' && r.winner === 'bear');
    const profit = won ? betAmount * (actualPayout - 1) : -betAmount;

    bankroll += profit;
    if (bankroll <= 0) break;

    if (bankroll > peak) peak = bankroll;
    const dd = ((peak - bankroll) / peak) * 100;
    if (dd > maxDD) maxDD = dd;

    // Track stats
    trades++;
    if (won) {
      wins++;
      consecutiveWins++;
      consecutiveLosses = 0;
    } else {
      consecutiveLosses++;
      consecutiveWins = 0;
    }

    if (mode === 'FOLLOW') {
      followTrades++;
      if (won) followWins++;
    } else {
      reverseTrades++;
      if (won) reverseWins++;
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    // TREND DETECTION & MODE SWITCHING
    if (detectionMethod === 'consecutive_wins') {
      // FLIP to REVERSE after X consecutive wins (we're on a roll)
      if (mode === 'FOLLOW' && consecutiveWins >= flipThreshold) {
        mode = 'REVERSE';
        flipToReverseCount++;
      }
      // FLIP back to FOLLOW after X consecutive losses (trend ended)
      if (mode === 'REVERSE' && consecutiveLosses >= exitThreshold) {
        mode = 'FOLLOW';
        flipToFollowCount++;
        consecutiveWins = 0;
        consecutiveLosses = 0;
      }
    } else if (detectionMethod === 'consecutive_losses') {
      // FLIP to REVERSE after X consecutive losses (follow mode failing, try reverse)
      if (mode === 'FOLLOW' && consecutiveLosses >= flipThreshold) {
        mode = 'REVERSE';
        flipToReverseCount++;
      }
      // FLIP back after X consecutive wins in REVERSE
      if (mode === 'REVERSE' && consecutiveWins >= exitThreshold) {
        mode = 'FOLLOW';
        flipToFollowCount++;
        consecutiveWins = 0;
        consecutiveLosses = 0;
      }
    } else if (detectionMethod === 'win_rate_window') {
      // FLIP based on recent performance (last 10 trades)
      if (i >= 10) {
        const last10 = lastTwoResults.slice(-10);
        const recentWins = last10.filter(r => r).length;
        const recentWR = recentWins / 10;

        if (mode === 'FOLLOW' && recentWR >= 0.7) {
          // Hot streak, switch to reverse
          mode = 'REVERSE';
          flipToReverseCount++;
        } else if (mode === 'REVERSE' && recentWR <= 0.4) {
          // Cold streak, back to follow
          mode = 'FOLLOW';
          flipToFollowCount++;
        }
      }
    }
  }

  const wr = trades > 0 ? (wins / trades * 100) : 0;
  const followWR = followTrades > 0 ? (followWins / followTrades * 100) : 0;
  const reverseWR = reverseTrades > 0 ? (reverseWins / reverseTrades * 100) : 0;

  return {
    bankroll,
    maxDD,
    trades,
    wr,
    followTrades,
    followWR,
    reverseTrades,
    reverseWR,
    flipToReverseCount,
    flipToFollowCount
  };
}

console.log('Testing different detection methods:\n');

const testConfigs = [
  // Baseline: pure modes
  { name: 'Pure FOLLOW (no flip)', method: 'consecutive_wins', flip: 999, exit: 999 },
  { name: 'Pure REVERSE (no flip)', method: 'never', flip: 0, exit: 0 }, // will set this manually

  // Win-based detection
  { name: 'Flip after 3 wins → exit after 3 losses', method: 'consecutive_wins', flip: 3, exit: 3 },
  { name: 'Flip after 4 wins → exit after 2 losses', method: 'consecutive_wins', flip: 4, exit: 2 },
  { name: 'Flip after 5 wins → exit after 3 losses', method: 'consecutive_wins', flip: 5, exit: 3 },

  // Loss-based detection
  { name: 'Flip after 3 losses → exit after 3 wins', method: 'consecutive_losses', flip: 3, exit: 3 },
  { name: 'Flip after 2 losses → exit after 4 wins', method: 'consecutive_losses', flip: 2, exit: 4 },

  // Win rate window
  { name: 'Flip on 70% WR window → exit on 40%', method: 'win_rate_window', flip: 0.7, exit: 0.4 },
];

const results = [];

// Test pure REVERSE manually
let pureReverse = testStrategy('consecutive_wins', 999, 999);
// Manually calculate pure reverse
let bankroll = 1.0;
let peak = 1.0;
let maxDD = 0;
let trades = 0, wins = 0;

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];
  const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
  const totalAmount = bullAmount + bearAmount;
  if (totalAmount === 0) continue;

  const bullPayout = totalAmount / bullAmount;
  const bearPayout = totalAmount / bearAmount;

  let signal = null;
  if (r.ema_signal === 'BULL' && bullPayout > bearPayout && bullPayout >= 1.55) {
    signal = 'BULL';
  } else if (r.ema_signal === 'BEAR' && bearPayout > bullPayout && bearPayout >= 1.55) {
    signal = 'BEAR';
  }

  if (!signal) continue;

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
  if (won) wins++;
}

results.push({
  name: 'Pure REVERSE (no flip)',
  bankroll,
  maxDD,
  trades,
  wr: (wins / trades * 100),
  followTrades: 0,
  followWR: 0,
  reverseTrades: trades,
  reverseWR: (wins / trades * 100),
  flipToReverseCount: 0,
  flipToFollowCount: 0
});

// Test all other configs
for (const config of testConfigs) {
  if (config.name === 'Pure REVERSE (no flip)') continue;
  const result = testStrategy(config.method, config.flip, config.exit);
  results.push({ name: config.name, ...result });
}

results.sort((a, b) => b.bankroll - a.bankroll);

console.log('Method                                          │  Final   │  DD   │ Overall │ Follow │ Reverse │ Flips');
console.log('────────────────────────────────────────────────┼──────────┼───────┼─────────┼────────┼─────────┼──────');

results.forEach(r => {
  const flips = r.flipToReverseCount > 0 ? `${r.flipToReverseCount}→R, ${r.flipToFollowCount}→F` : '-';
  console.log(
    `${r.name.padEnd(47)} │ ${r.bankroll.toFixed(2).padStart(8)} │ ${r.maxDD.toFixed(1).padStart(5)}% │ ${r.wr.toFixed(1).padStart(5)}% │ ${r.followWR.toFixed(1).padStart(5)}% │ ${r.reverseWR.toFixed(1).padStart(6)}% │ ${flips}`
  );
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const winner = results[0];
const baseline = results.find(r => r.name.includes('Pure REVERSE'));

console.log(`🏆 WINNER: ${winner.name}\n`);
console.log(`Final: ${winner.bankroll.toFixed(2)} BNB`);
console.log(`Max DD: ${winner.maxDD.toFixed(1)}%`);
console.log(`Overall WR: ${winner.wr.toFixed(1)}%\n`);

if (winner.flipToReverseCount > 0) {
  console.log(`Mode Switching:`);
  console.log(`  Follow mode: ${winner.followTrades} trades, ${winner.followWR.toFixed(1)}% WR`);
  console.log(`  Reverse mode: ${winner.reverseTrades} trades, ${winner.reverseWR.toFixed(1)}% WR`);
  console.log(`  Flips to REVERSE: ${winner.flipToReverseCount}`);
  console.log(`  Flips to FOLLOW: ${winner.flipToFollowCount}\n`);

  const improvement = ((winner.bankroll / baseline.bankroll - 1) * 100).toFixed(1);
  if (parseFloat(improvement) > 0) {
    console.log(`✅ THEORY WORKS! ${improvement}% better than pure REVERSE`);
  } else {
    console.log(`⚠️ Theory doesn't help - pure REVERSE is ${Math.abs(improvement)}% better`);
  }
} else {
  console.log(`❌ Pure mode wins - no benefit from flipping`);
}
