import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('📊 PURE STATISTICAL TEST: REVERSE CROWD vs FOLLOW CROWD\n');
console.log('No bias, no assumptions - just raw numbers\n');
console.log('Testing with REALISTIC T-10s timing\n');
console.log('═'.repeat(100) + '\n');

function runTest(strategyName, strategyLogic) {
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

  let bankroll = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;
  let totalBetAmount = 0;
  let totalProfit = 0;

  // Circuit breaker
  let cbActive = false;
  let cbLossStreak = 0;
  let cbCooldownUntil = null;
  let lastTwoResults = [];

  // Trade logging for verification
  const trades = [];

  for (let i = 60; i < rounds.length; i++) {
    const r = rounds[i];

    // Circuit breaker check
    if (cbActive && cbCooldownUntil && r.lock_timestamp < cbCooldownUntil) continue;
    if (cbActive && cbCooldownUntil && r.lock_timestamp >= cbCooldownUntil) {
      cbActive = false;
      cbCooldownUntil = null;
      cbLossStreak = 0;
    }

    // Calculate amounts and payouts
    const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;

    if (totalAmount === 0) continue;

    const bullPayout = (totalAmount * 0.97) / bullAmount;
    const bearPayout = (totalAmount * 0.97) / bearAmount;

    // Get signal from strategy
    const signal = strategyLogic(r, bullPayout, bearPayout);
    if (!signal) continue;

    // Get payout for our bet
    const ourPayout = signal === 'BULL' ? bullPayout : bearPayout;

    // Minimum payout filter
    if (ourPayout < 1.3) continue;

    // Position sizing
    const effectiveBankroll = Math.min(bankroll, 50);
    let positionMultiplier = 1.0;

    // Momentum multiplier
    if (r.ema_gap >= 0.05) {
      positionMultiplier *= 2.2;
    }

    // Recovery multiplier
    if (lastTwoResults.length >= 2 && lastTwoResults.every(res => !res)) {
      positionMultiplier *= 1.5;
    }

    const betAmount = effectiveBankroll * 0.045 * positionMultiplier;
    totalBetAmount += betAmount;

    // Determine actual winner
    const actualWinner = r.winner === 'bull' ? 'BULL' : 'BEAR';
    const won = signal === actualWinner;

    // Calculate P&L
    let profit = 0;
    if (won) {
      profit = betAmount * (ourPayout - 1);
      bankroll += profit;
      wins++;
      cbLossStreak = 0;
    } else {
      profit = -betAmount;
      bankroll -= betAmount;
      losses++;
      cbLossStreak++;

      if (cbLossStreak >= 3) {
        cbActive = true;
        cbCooldownUntil = r.lock_timestamp + (45 * 60);
      }
    }

    totalProfit += profit;

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();

    // Track peak and drawdown
    if (bankroll > peak) peak = bankroll;
    const currentDD = ((peak - bankroll) / peak) * 100;
    if (currentDD > maxDrawdown) maxDrawdown = currentDD;

    // Log trade for verification
    trades.push({
      round: r.epoch,
      signal,
      actualWinner,
      won,
      betAmount: betAmount.toFixed(4),
      payout: ourPayout.toFixed(2),
      profit: profit.toFixed(4),
      bankroll: bankroll.toFixed(4)
    });

    // Cap to prevent infinity
    if (bankroll > 100000) {
      bankroll = 100000;
      break;
    }

    if (bankroll <= 0) {
      bankroll = 0;
      break;
    }
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const avgBetSize = totalTrades > 0 ? totalBetAmount / totalTrades : 0;
  const roi = ((bankroll - 1) / 1) * 100;
  const expectancy = totalTrades > 0 ? totalProfit / totalTrades : 0;

  return {
    strategyName,
    finalBankroll: bankroll,
    roi,
    maxDrawdown,
    totalTrades,
    wins,
    losses,
    winRate,
    totalProfit,
    avgBetSize,
    expectancy,
    trades: trades.slice(0, 10) // First 10 trades for verification
  };
}

// STRATEGY 1: REVERSE CROWD
// Bet HIGH payout side when EMA agrees (fade the crowd)
function reverseCrowdLogic(round, bullPayout, bearPayout) {
  if (!round.ema_signal || round.ema_signal === 'NEUTRAL') return null;

  // REVERSE CROWD: Bet the side with HIGHER payout (less crowd money)
  if (round.ema_signal === 'BULL') {
    // EMA says BULL
    if (bullPayout > bearPayout && bullPayout >= 1.55) {
      return 'BULL'; // High payout on BULL = less crowd on BULL = fade bears
    }
  } else if (round.ema_signal === 'BEAR') {
    // EMA says BEAR
    if (bearPayout > bullPayout && bearPayout >= 1.55) {
      return 'BEAR'; // High payout on BEAR = less crowd on BEAR = fade bulls
    }
  }

  return null;
}

// STRATEGY 2: FOLLOW CROWD
// Bet LOW payout side when EMA agrees (follow the crowd)
function followCrowdLogic(round, bullPayout, bearPayout) {
  if (!round.ema_signal || round.ema_signal === 'NEUTRAL') return null;

  // FOLLOW CROWD: Bet the side with LOWER payout (more crowd money)
  if (round.ema_signal === 'BULL') {
    // EMA says BULL
    if (bullPayout < bearPayout && bullPayout >= 1.3) {
      return 'BULL'; // Low payout on BULL = more crowd on BULL = follow crowd
    }
  } else if (round.ema_signal === 'BEAR') {
    // EMA says BEAR
    if (bearPayout < bullPayout && bearPayout >= 1.3) {
      return 'BEAR'; // Low payout on BEAR = more crowd on BEAR = follow crowd
    }
  }

  return null;
}

// STRATEGY 3: EMA ONLY (no crowd consideration)
function emaOnlyLogic(round, bullPayout, bearPayout) {
  if (!round.ema_signal || round.ema_signal === 'NEUTRAL') return null;
  if (round.ema_gap < 0.05) return null; // Need strong signal

  // Just follow EMA, ignore crowd
  return round.ema_signal === 'BULL' ? 'BULL' : 'BEAR';
}

console.log('Running tests...\n');

const results = [];

console.log('1/3 Testing REVERSE CROWD...');
results.push(runTest('REVERSE CROWD', reverseCrowdLogic));

console.log('2/3 Testing FOLLOW CROWD...');
results.push(runTest('FOLLOW CROWD', followCrowdLogic));

console.log('3/3 Testing EMA ONLY...');
results.push(runTest('EMA ONLY', emaOnlyLogic));

console.log('\n\n' + '═'.repeat(120));
console.log('📊 PURE STATISTICAL RESULTS - NO BIAS');
console.log('═'.repeat(120));
console.log('Strategy        │  Final     │    ROI     │   DD   │ Trades │  W/L      │  WR    │ Expectancy');
console.log('─'.repeat(120));

for (const r of results) {
  const name = r.strategyName.padEnd(15);
  const final = r.finalBankroll.toFixed(2).padStart(10);
  const roi = r.roi >= 999999 ? '999999+%' : (r.roi.toFixed(1) + '%');
  const roiPadded = roi.padStart(10);
  const dd = r.maxDrawdown.toFixed(1).padStart(5);
  const trades = r.totalTrades.toString().padStart(6);
  const wl = `${r.wins}/${r.losses}`.padStart(9);
  const wr = r.winRate.toFixed(1).padStart(5);
  const exp = r.expectancy.toFixed(4).padStart(10);

  console.log(`${name} │ ${final} │ ${roiPadded} │ ${dd}% │ ${trades} │ ${wl} │ ${wr}% │ ${exp}`);
}

console.log('═'.repeat(120));

// Find best by win rate
const bestWR = results.reduce((a, b) => a.winRate > b.winRate ? a : b);

// Find best by final bankroll
const bestBankroll = results.reduce((a, b) => a.finalBankroll > b.finalBankroll ? a : b);

// Find best by expectancy
const bestExpectancy = results.reduce((a, b) => a.expectancy > b.expectancy ? a : b);

console.log('\n🏆 STATISTICAL WINNERS:\n');
console.log(`Highest Win Rate: ${bestWR.strategyName} (${bestWR.winRate.toFixed(1)}%)`);
console.log(`Highest Bankroll: ${bestBankroll.strategyName} (${bestBankroll.finalBankroll.toFixed(2)} BNB)`);
console.log(`Best Expectancy: ${bestExpectancy.strategyName} (${bestExpectancy.expectancy.toFixed(4)} BNB per trade)`);

console.log('\n📈 DETAILED COMPARISON:\n');

const reverse = results.find(r => r.strategyName === 'REVERSE CROWD');
const follow = results.find(r => r.strategyName === 'FOLLOW CROWD');
const emaOnly = results.find(r => r.strategyName === 'EMA ONLY');

console.log('REVERSE CROWD:');
console.log(`  Win Rate: ${reverse.winRate.toFixed(1)}%`);
console.log(`  Final: ${reverse.finalBankroll.toFixed(2)} BNB`);
console.log(`  Drawdown: ${reverse.maxDrawdown.toFixed(1)}%`);
console.log(`  Trades: ${reverse.totalTrades}`);
console.log(`  Expectancy: ${reverse.expectancy.toFixed(4)} BNB per trade\n`);

console.log('FOLLOW CROWD:');
console.log(`  Win Rate: ${follow.winRate.toFixed(1)}%`);
console.log(`  Final: ${follow.finalBankroll.toFixed(2)} BNB`);
console.log(`  Drawdown: ${follow.maxDrawdown.toFixed(1)}%`);
console.log(`  Trades: ${follow.totalTrades}`);
console.log(`  Expectancy: ${follow.expectancy.toFixed(4)} BNB per trade\n`);

console.log('EMA ONLY:');
console.log(`  Win Rate: ${emaOnly.winRate.toFixed(1)}%`);
console.log(`  Final: ${emaOnly.finalBankroll.toFixed(2)} BNB`);
console.log(`  Drawdown: ${emaOnly.maxDrawdown.toFixed(1)}%`);
console.log(`  Trades: ${emaOnly.totalTrades}`);
console.log(`  Expectancy: ${emaOnly.expectancy.toFixed(4)} BNB per trade\n`);

// Direct comparison
const reverseVsFollow = ((reverse.finalBankroll / follow.finalBankroll) - 1) * 100;
const reverseVsEma = ((reverse.finalBankroll / emaOnly.finalBankroll) - 1) * 100;

console.log('═'.repeat(120));
console.log('💡 DIRECT COMPARISONS:\n');
console.log(`REVERSE CROWD vs FOLLOW CROWD: ${reverseVsFollow >= 0 ? '+' : ''}${reverseVsFollow.toFixed(1)}% better`);
console.log(`REVERSE CROWD vs EMA ONLY: ${reverseVsEma >= 0 ? '+' : ''}${reverseVsEma.toFixed(1)}% better`);

console.log('\n✅ VERIFICATION - First 10 trades of REVERSE CROWD:');
console.log('Round    │ Signal │ Winner │ Result │ Bet    │ Payout │ Profit  │ Bankroll');
console.log('─'.repeat(90));
for (const t of reverse.trades) {
  console.log(`${t.round} │ ${t.signal.padEnd(6)} │ ${t.actualWinner.padEnd(6)} │ ${t.won ? 'WIN ✅' : 'LOSS❌'} │ ${t.betAmount} │ ${t.payout.padStart(6)} │ ${t.profit.padStart(7)} │ ${t.bankroll}`);
}

console.log('\n' + '═'.repeat(120));
console.log('🎯 FINAL VERDICT:\n');

if (reverse.winRate > follow.winRate && reverse.finalBankroll > follow.finalBankroll) {
  console.log('✅ REVERSE CROWD is statistically BETTER than FOLLOW CROWD');
  console.log(`   - ${(reverse.winRate - follow.winRate).toFixed(1)}% higher win rate`);
  console.log(`   - ${reverseVsFollow.toFixed(1)}% more profitable`);
} else if (follow.winRate > reverse.winRate && follow.finalBankroll > reverse.finalBankroll) {
  console.log('✅ FOLLOW CROWD is statistically BETTER than REVERSE CROWD');
  console.log(`   - ${(follow.winRate - reverse.winRate).toFixed(1)}% higher win rate`);
  console.log(`   - ${-reverseVsFollow.toFixed(1)}% more profitable`);
} else {
  console.log('⚠️  Results are MIXED - need more analysis');
}

db.close();
