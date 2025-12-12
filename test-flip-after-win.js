import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('🔄 TESTING: FLIP DIRECTION AFTER EVERY WIN\n');
console.log('Strategy: REVERSE CROWD but flip to opposite side after each win\n');
console.log('Theory: Avoid overconfidence, bet against momentum after wins\n');
console.log('═'.repeat(100) + '\n');

function runStrategy(name, flipAfterWin) {
  const rounds = db.prepare(`
    SELECT epoch, lock_timestamp, ema_signal, ema_gap,
           t20s_bull_wei, t20s_bear_wei, winner, close_price
    FROM rounds
    WHERE t20s_bull_wei IS NOT NULL
      AND t20s_bear_wei IS NOT NULL
      AND winner IS NOT NULL
      AND ema_signal IS NOT NULL
      AND close_price IS NOT NULL
    ORDER BY epoch ASC
  `).all();

  let bankroll = 1, peak = 1, maxDrawdown = 0;
  let wins = 0, losses = 0;
  let cbActive = false, cbLossStreak = 0, cbCooldownUntil = null;
  let lastTwoResults = [];
  let lastWasWin = false;

  for (let i = 60; i < rounds.length; i++) {
    const r = rounds[i];

    // Circuit breaker
    if (cbActive && cbCooldownUntil && r.lock_timestamp < cbCooldownUntil) continue;
    if (cbActive && cbCooldownUntil && r.lock_timestamp >= cbCooldownUntil) {
      cbActive = false;
      cbCooldownUntil = null;
      cbLossStreak = 0;
    }

    // Calculate payouts
    const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;
    if (totalAmount === 0) continue;

    const bullPayout = (totalAmount * 0.97) / bullAmount;
    const bearPayout = (totalAmount * 0.97) / bearAmount;

    // Base REVERSE CROWD logic
    let baseSignal = null;
    if (r.ema_signal === 'BULL' && bullPayout > bearPayout && bullPayout >= 1.55) {
      baseSignal = 'BULL';
    } else if (r.ema_signal === 'BEAR' && bearPayout > bullPayout && bearPayout >= 1.55) {
      baseSignal = 'BEAR';
    }

    if (!baseSignal) continue;

    // FLIP LOGIC: If last trade was a win, flip to opposite
    let signal = baseSignal;
    if (flipAfterWin && lastWasWin) {
      signal = baseSignal === 'BULL' ? 'BEAR' : 'BULL';
    }

    const payout = signal === 'BULL' ? bullPayout : bearPayout;
    if (payout < 1.3) continue;

    // Position sizing
    const effectiveBankroll = Math.min(bankroll, 50);
    let positionMultiplier = 1.0;

    // Momentum multiplier (only on base signal, not flipped)
    if (!flipAfterWin || !lastWasWin) {
      if (r.ema_gap >= 0.05) positionMultiplier *= 2.2;
    }

    // Recovery multiplier
    if (lastTwoResults.length >= 2 && lastTwoResults.every(res => !res)) {
      positionMultiplier *= 1.5;
    }

    const betAmount = effectiveBankroll * 0.045 * positionMultiplier;

    // Determine winner
    const actualWinner = r.winner === 'bull' ? 'BULL' : 'BEAR';
    const won = signal === actualWinner;

    if (won) {
      bankroll += betAmount * (payout - 1);
      wins++;
      cbLossStreak = 0;
      lastWasWin = true;
    } else {
      bankroll -= betAmount;
      losses++;
      cbLossStreak++;
      lastWasWin = false;
      if (cbLossStreak >= 3) {
        cbActive = true;
        cbCooldownUntil = r.lock_timestamp + (45 * 60);
      }
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    if (bankroll > peak) peak = bankroll;
    const currentDD = ((peak - bankroll) / peak) * 100;
    if (currentDD > maxDrawdown) maxDrawdown = currentDD;

    if (bankroll > 100000) {
      bankroll = 100000;
      break;
    }
    if (bankroll <= 0) break;
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;

  return {
    name,
    finalBankroll: bankroll,
    maxDrawdown,
    totalTrades,
    wins,
    losses,
    winRate
  };
}

console.log('Testing strategies...\n');

const strategies = [
  { name: 'REVERSE CROWD (normal)', flip: false },
  { name: 'REVERSE CROWD (flip after win)', flip: true }
];

const results = [];

for (const strategy of strategies) {
  console.log(`Testing ${strategy.name}...`);
  const result = runStrategy(strategy.name, strategy.flip);
  results.push(result);
}

console.log('\n\n' + '═'.repeat(120));
console.log('📊 COMPARISON: NORMAL vs FLIP AFTER WIN');
console.log('═'.repeat(120));
console.log('Strategy                              │  Final     │   DD   │ Trades │  W/L      │  WR   ');
console.log('─'.repeat(120));

for (const r of results) {
  const name = r.name.padEnd(37);
  const final = r.finalBankroll.toFixed(2).padStart(10);
  const dd = r.maxDrawdown.toFixed(1).padStart(5);
  const trades = r.totalTrades.toString().padStart(6);
  const wl = `${r.wins}/${r.losses}`.padStart(9);
  const wr = r.winRate.toFixed(1).padStart(5);

  console.log(`${name} │ ${final} │ ${dd}% │ ${trades} │ ${wl} │ ${wr}%`);
}

console.log('═'.repeat(120));

const normal = results[0];
const flipped = results[1];
const improvement = ((flipped.finalBankroll - normal.finalBankroll) / normal.finalBankroll * 100);

console.log(`\n📈 ANALYSIS:`);
console.log(`   Normal: ${normal.finalBankroll.toFixed(2)} BNB (${normal.winRate.toFixed(1)}% WR)`);
console.log(`   Flip After Win: ${flipped.finalBankroll.toFixed(2)} BNB (${flipped.winRate.toFixed(1)}% WR)`);
console.log(`   Difference: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(2)}%`);
console.log(`   WR Change: ${flipped.winRate >= normal.winRate ? '+' : ''}${(flipped.winRate - normal.winRate).toFixed(1)}%`);

if (improvement > 10) {
  console.log('\n🎉 FLIPPING AFTER WINS SIGNIFICANTLY IMPROVES PERFORMANCE!');
} else if (improvement > 0) {
  console.log('\n✅ Flipping after wins shows slight improvement');
} else if (improvement > -10) {
  console.log('\n⚠️  Flipping after wins slightly hurts performance');
} else {
  console.log('\n❌ FLIPPING AFTER WINS SIGNIFICANTLY HURTS PERFORMANCE!');
}

console.log('\n💡 THEORY EXPLANATION:');
if (flipped.winRate > normal.winRate) {
  console.log('   Flipping prevents "winning streak bias" - after a win, the opposite side becomes value');
} else {
  console.log('   Flipping disrupts the edge - REVERSE CROWD works because of consistent logic, not randomness');
}

db.close();
