import { initDatabase } from './db-init.js';

const db = initDatabase();

console.log('🔍 COMPREHENSIVE STRATEGY TESTING - FIND WHAT ACTUALLY WORKS\n');
console.log('Testing with REALISTIC T-10s timing (can only see previous rounds)\n');
console.log('═'.repeat(100) + '\n');

// Helper: Calculate indicators
function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function runStrategy(name, strategyFunc) {
  const rounds = db.prepare(`
    SELECT epoch, lock_timestamp, ema_signal, ema_gap,
           t20s_bull_wei, t20s_bear_wei, winner, close_price, lock_price
    FROM rounds
    WHERE t20s_bull_wei IS NOT NULL
      AND t20s_bear_wei IS NOT NULL
      AND winner IS NOT NULL
      AND close_price IS NOT NULL
    ORDER BY epoch ASC
  `).all();

  let bankroll = 1, peak = 1, maxDrawdown = 0;
  let wins = 0, losses = 0;
  let cbActive = false, cbLossStreak = 0, cbCooldownUntil = null;
  let lastTwoResults = [];

  for (let i = 60; i < rounds.length; i++) {
    const currentRound = rounds[i];

    // Circuit breaker
    if (cbActive && cbCooldownUntil && currentRound.lock_timestamp < cbCooldownUntil) continue;
    if (cbActive && cbCooldownUntil && currentRound.lock_timestamp >= cbCooldownUntil) {
      cbActive = false;
      cbCooldownUntil = null;
      cbLossStreak = 0;
    }

    // Get signal (only use historical data)
    const signal = strategyFunc(rounds, i, currentRound);
    if (!signal) continue;

    // Calculate payouts
    const bullAmount = parseFloat(currentRound.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(currentRound.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;
    if (totalAmount === 0) continue;

    const bullPayout = (totalAmount * 0.97) / bullAmount;
    const bearPayout = (totalAmount * 0.97) / bearAmount;
    const payout = signal === 'BULL' ? bullPayout : bearPayout;

    if (payout < 1.3) continue;

    // Position sizing
    const effectiveBankroll = Math.min(bankroll, 50);
    let positionMultiplier = 1.0;
    if (lastTwoResults.length >= 2 && lastTwoResults.every(res => !res)) {
      positionMultiplier *= 1.5;
    }

    const betAmount = effectiveBankroll * 0.045 * positionMultiplier;

    // Determine winner
    const actualWinner = currentRound.winner === 'bull' ? 'BULL' : 'BEAR';
    const won = signal === actualWinner;

    if (won) {
      bankroll += betAmount * (payout - 1);
      wins++;
      cbLossStreak = 0;
    } else {
      bankroll -= betAmount;
      losses++;
      cbLossStreak++;
      if (cbLossStreak >= 3) {
        cbActive = true;
        cbCooldownUntil = currentRound.lock_timestamp + (45 * 60);
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

// STRATEGY 1: REVERSE CROWD (original)
const reverseCrowd = (rounds, i, current) => {
  if (!current.ema_signal || current.ema_signal === 'NEUTRAL') return null;

  const bullAmount = parseFloat(current.t20s_bull_wei) / 1e18;
  const bearAmount = parseFloat(current.t20s_bear_wei) / 1e18;
  const totalAmount = bullAmount + bearAmount;

  const bullPayout = (totalAmount * 0.97) / bullAmount;
  const bearPayout = (totalAmount * 0.97) / bearAmount;

  // REVERSE CROWD: Bet high payout side when EMA agrees
  if (current.ema_signal === 'BULL' && bullPayout > bearPayout && bullPayout >= 1.55) {
    return 'BULL';
  }
  if (current.ema_signal === 'BEAR' && bearPayout > bullPayout && bearPayout >= 1.55) {
    return 'BEAR';
  }
  return null;
};

// STRATEGY 2: FOLLOW CROWD
const followCrowd = (rounds, i, current) => {
  if (!current.ema_signal || current.ema_signal === 'NEUTRAL') return null;

  const bullAmount = parseFloat(current.t20s_bull_wei) / 1e18;
  const bearAmount = parseFloat(current.t20s_bear_wei) / 1e18;
  const totalAmount = bullAmount + bearAmount;

  const bullPayout = (totalAmount * 0.97) / bullAmount;
  const bearPayout = (totalAmount * 0.97) / bearAmount;

  // FOLLOW CROWD: Bet low payout side (where crowd is)
  if (current.ema_signal === 'BULL' && bullPayout < bearPayout) {
    return 'BULL';
  }
  if (current.ema_signal === 'BEAR' && bearPayout < bullPayout) {
    return 'BEAR';
  }
  return null;
};

// STRATEGY 3: EMA ONLY (ignore crowd)
const emaOnly = (rounds, i, current) => {
  if (!current.ema_signal || current.ema_signal === 'NEUTRAL') return null;
  if (current.ema_gap < 0.05) return null; // Need strong signal
  return current.ema_signal === 'BULL' ? 'BULL' : 'BEAR';
};

// STRATEGY 4: PRICE MOMENTUM
const priceMomentum = (rounds, i, current) => {
  if (i < 5) return null;
  const recent = rounds.slice(i - 5, i).map(r => parseFloat(r.close_price));
  const current_price = parseFloat(rounds[i-1].close_price);

  const ups = recent.filter((p, idx) => idx > 0 && p > recent[idx-1]).length;

  if (ups >= 4) return 'BULL'; // 4/5 up candles
  if (ups <= 1) return 'BEAR'; // 4/5 down candles
  return null;
};

// STRATEGY 5: CONTRARIAN TO RECENT TREND
const contrarian = (rounds, i, current) => {
  if (i < 5) return null;
  const recent = rounds.slice(i - 5, i).map(r => parseFloat(r.close_price));

  const ups = recent.filter((p, idx) => idx > 0 && p > recent[idx-1]).length;

  // If strong trend, bet reversal
  if (ups >= 4) return 'BEAR';
  if (ups <= 1) return 'BULL';
  return null;
};

// STRATEGY 6: LARGE BET DETECTION (whale watching)
const fadeWhales = (rounds, i, current) => {
  const bullAmount = parseFloat(current.t20s_bull_wei) / 1e18;
  const bearAmount = parseFloat(current.t20s_bear_wei) / 1e18;
  const totalAmount = bullAmount + bearAmount;

  // If one side has >75% of money, fade it
  const bullPercent = bullAmount / totalAmount * 100;
  const bearPercent = bearAmount / totalAmount * 100;

  if (bullPercent > 75) return 'BEAR'; // Fade the bull whales
  if (bearPercent > 75) return 'BULL'; // Fade the bear whales
  return null;
};

// STRATEGY 7: FOLLOW WHALES
const followWhales = (rounds, i, current) => {
  const bullAmount = parseFloat(current.t20s_bull_wei) / 1e18;
  const bearAmount = parseFloat(current.t20s_bear_wei) / 1e18;
  const totalAmount = bullAmount + bearAmount;

  const bullPercent = bullAmount / totalAmount * 100;
  const bearPercent = bearAmount / totalAmount * 100;

  if (bullPercent > 70) return 'BULL'; // Follow bull whales
  if (bearPercent > 70) return 'BEAR'; // Follow bear whales
  return null;
};

// STRATEGY 8: BET SIZE MOMENTUM
const betMomentum = (rounds, i, current) => {
  if (i < 2) return null;

  const curr_bull = parseFloat(current.t20s_bull_wei) / 1e18;
  const curr_bear = parseFloat(current.t20s_bear_wei) / 1e18;

  const prev = rounds[i-1];
  const prev_bull = parseFloat(prev.t20s_bull_wei || 0) / 1e18;
  const prev_bear = parseFloat(prev.t20s_bear_wei || 0) / 1e18;

  // Which side is growing faster?
  const bull_growth = curr_bull / Math.max(prev_bull, 0.001);
  const bear_growth = curr_bear / Math.max(prev_bear, 0.001);

  if (bull_growth > bear_growth * 1.5) return 'BULL';
  if (bear_growth > bull_growth * 1.5) return 'BEAR';
  return null;
};

// STRATEGY 9: TIME OF DAY
const timeOfDay = (rounds, i, current) => {
  const hour = new Date(current.lock_timestamp * 1000).getUTCHours();

  // Only trade during "good" hours (example: Asian/EU trading hours)
  if (hour < 6 || hour > 18) return null;

  // Use simple EMA for direction
  if (!current.ema_signal || current.ema_signal === 'NEUTRAL') return null;
  return current.ema_signal;
};

// STRATEGY 10: ALWAYS BULL (baseline test)
const alwaysBull = (rounds, i, current) => {
  return 'BULL';
};

// STRATEGY 11: ALWAYS BEAR (baseline test)
const alwaysBear = (rounds, i, current) => {
  return 'BEAR';
};

// STRATEGY 12: HIGH PAYOUT ONLY
const highPayoutOnly = (rounds, i, current) => {
  const bullAmount = parseFloat(current.t20s_bull_wei) / 1e18;
  const bearAmount = parseFloat(current.t20s_bear_wei) / 1e18;
  const totalAmount = bullAmount + bearAmount;

  const bullPayout = (totalAmount * 0.97) / bullAmount;
  const bearPayout = (totalAmount * 0.97) / bearAmount;

  // Only bet when payout is very high (underdog)
  if (bullPayout >= 2.5) return 'BULL';
  if (bearPayout >= 2.5) return 'BEAR';
  return null;
};

console.log('Testing all strategies...\n');

const strategies = [
  { name: 'REVERSE CROWD', func: reverseCrowd },
  { name: 'FOLLOW CROWD', func: followCrowd },
  { name: 'EMA ONLY', func: emaOnly },
  { name: 'PRICE MOMENTUM', func: priceMomentum },
  { name: 'CONTRARIAN', func: contrarian },
  { name: 'FADE WHALES', func: fadeWhales },
  { name: 'FOLLOW WHALES', func: followWhales },
  { name: 'BET MOMENTUM', func: betMomentum },
  { name: 'TIME OF DAY', func: timeOfDay },
  { name: 'HIGH PAYOUT ONLY', func: highPayoutOnly },
  { name: 'ALWAYS BULL (baseline)', func: alwaysBull },
  { name: 'ALWAYS BEAR (baseline)', func: alwaysBear }
];

const results = [];

for (const strategy of strategies) {
  console.log(`Testing ${strategy.name}...`);
  const result = runStrategy(strategy.name, strategy.func);
  results.push(result);
}

console.log('\n\n' + '═'.repeat(120));
console.log('📊 COMPREHENSIVE RESULTS - ALL STRATEGIES');
console.log('═'.repeat(120));
console.log('Strategy                    │  Final     │   DD   │ Trades │  W/L      │  WR   ');
console.log('─'.repeat(120));

// Sort by win rate
results.sort((a, b) => b.winRate - a.winRate);

for (const r of results) {
  const name = r.name.padEnd(27);
  const final = r.finalBankroll.toFixed(2).padStart(10);
  const dd = r.maxDrawdown.toFixed(1).padStart(5);
  const trades = r.totalTrades.toString().padStart(6);
  const wl = `${r.wins}/${r.losses}`.padStart(9);
  const wr = r.winRate.toFixed(1).padStart(5);

  console.log(`${name} │ ${final} │ ${dd}% │ ${trades} │ ${wl} │ ${wr}%`);
}

console.log('═'.repeat(120));

const best = results[0];
console.log(`\n🏆 BEST STRATEGY: ${best.name}`);
console.log(`   Win Rate: ${best.winRate.toFixed(1)}%`);
console.log(`   Total Trades: ${best.totalTrades}`);
console.log(`   Final Bankroll: ${best.finalBankroll.toFixed(2)} BNB`);
console.log(`   Max Drawdown: ${best.maxDrawdown.toFixed(1)}%`);

if (best.winRate > 60) {
  console.log('\n✅ FOUND A WORKING STRATEGY!');
} else if (best.winRate > 55) {
  console.log('\n⚠️  Marginal edge - might work but risky');
} else {
  console.log('\n❌ No strategy beats random (50%) by significant margin');
  console.log('   PancakeSwap predictions might be fundamentally unprofitable');
}

db.close();
