import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🔍 PREDICTING BAD PERFORMANCE PERIODS\n');
console.log('═'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

// Get all complete rounds with EMA data
const rounds = db.prepare(`
  SELECT
    sample_id,
    epoch,
    lock_timestamp,
    lock_price,
    close_price,
    t20s_bull_wei,
    t20s_bear_wei,
    lock_bull_wei,
    lock_bear_wei,
    winner,
    winner_payout_multiple,
    ema_signal,
    ema_gap,
    ema3,
    ema7
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Analyzing ${rounds.length} complete rounds\n`);
console.log('─'.repeat(100) + '\n');

// Configuration
const CONFIG = {
  CROWD_THRESHOLD: 0.65,
  EMA_GAP_THRESHOLD: 0.05,
  MAX_PAYOUT: 1.45,
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  STARTING_BANKROLL: 1.0
};

// Multi-factor fakeout detection
function detectFakeout(rounds, index, signal) {
  if (index < 2 || index >= rounds.length - 1) return false;

  const current = rounds[index];
  const prev = rounds[index - 1];

  const currentGap = Math.abs(parseFloat(current.ema_gap));
  const prevGap = Math.abs(parseFloat(prev.ema_gap));

  const bullWei = parseFloat(current.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(current.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;
  if (total === 0) return false;

  const bullPct = (bullWei / total) * 100;
  const bearPct = (bearWei / total) * 100;

  const lookback = 14;
  const startIdx = Math.max(0, index - lookback);
  const priceWindow = rounds.slice(startIdx, index + 1);
  const prices = priceWindow.map(r => Number(r.lock_price) / 1e8);
  const highest = Math.max(...prices);
  const lowest = Math.min(...prices);
  const range = highest - lowest;
  if (range === 0) return false;

  const currentPrice = Number(current.lock_price) / 1e8;
  const pricePosition = (currentPrice - lowest) / range;

  let fakeoutScore = 0;

  if (currentGap < prevGap * 0.8) fakeoutScore += 1;
  if (signal === 'BULL' && bullPct > 80) fakeoutScore += 1;
  else if (signal === 'BEAR' && bearPct > 80) fakeoutScore += 1;
  if (signal === 'BULL' && pricePosition > 0.8) fakeoutScore += 1;
  else if (signal === 'BEAR' && pricePosition < 0.2) fakeoutScore += 1;

  return fakeoutScore >= 2;
}

// Trading state
let bankroll = CONFIG.STARTING_BANKROLL;
let lastTwoResults = [];
let totalTrades = 0;

const allTrades = [];

// Process rounds and execute trades
for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];

  const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;

  if (total === 0) continue;

  const bullPercent = (bullWei / total) * 100;
  const bearPercent = (bearWei / total) * 100;

  const estimatedPayout = bullPercent > bearPercent
    ? total / bullWei
    : total / bearWei;

  const emaSignal = r.ema_signal;
  const emaGap = parseFloat(r.ema_gap);

  if (!emaSignal || emaSignal === 'NEUTRAL') continue;
  if (estimatedPayout < CONFIG.MAX_PAYOUT) continue;

  const isFakeout = detectFakeout(rounds, i, emaSignal);
  if (isFakeout) continue;

  const betSide = emaSignal === 'BULL' ? 'BULL' : 'BEAR';

  let sizeMultiplier = 1.0;
  if (Math.abs(emaGap) >= 0.15) {
    sizeMultiplier = CONFIG.MOMENTUM_MULTIPLIER;
  }
  if (lastTwoResults[0] === 'LOSS') {
    sizeMultiplier *= CONFIG.RECOVERY_MULTIPLIER;
  }

  const betSize = bankroll * CONFIG.BASE_POSITION_SIZE * sizeMultiplier;

  totalTrades++;
  const won = betSide.toLowerCase() === r.winner.toLowerCase();
  const actualPayout = parseFloat(r.winner_payout_multiple);

  let tradePnL;
  let newBankroll;

  if (won) {
    tradePnL = betSize * (actualPayout - 1);
    newBankroll = bankroll + tradePnL;
    lastTwoResults.unshift('WIN');
  } else {
    tradePnL = -betSize;
    newBankroll = bankroll - betSize;
    lastTwoResults.unshift('LOSS');
  }

  if (lastTwoResults.length > 2) lastTwoResults.pop();

  const oldBankroll = bankroll;
  bankroll = newBankroll;

  allTrades.push({
    tradeNum: totalTrades,
    epoch: r.epoch,
    timestamp: r.lock_timestamp,
    betSide,
    betSize,
    won,
    actualPayout,
    tradePnL,
    oldBankroll,
    newBankroll,
    emaGap,
    estimatedPayout
  });
}

console.log(`✅ Executed ${allTrades.length} trades total\n`);
console.log('═'.repeat(100) + '\n');

// Now analyze what indicators precede bad periods
console.log('🔮 TESTING PREDICTIVE INDICATORS FOR BAD PERIODS:\n');
console.log('─'.repeat(100) + '\n');

// Test different indicators
const indicators = [
  {
    name: 'Recent Win Rate',
    description: 'Win rate over last 5 trades',
    calculate: (trades, index) => {
      if (index < 5) return null;
      const last5 = trades.slice(index - 5, index);
      const wins = last5.filter(t => t.won).length;
      return (wins / 5) * 100;
    },
    threshold: 40, // Less than 40% win rate
    direction: 'below'
  },
  {
    name: 'Recent Losses',
    description: 'Number of losses in last 5 trades',
    calculate: (trades, index) => {
      if (index < 5) return null;
      const last5 = trades.slice(index - 5, index);
      return last5.filter(t => !t.won).length;
    },
    threshold: 3, // 3 or more losses in last 5
    direction: 'above'
  },
  {
    name: 'Consecutive Losses',
    description: 'Current losing streak length',
    calculate: (trades, index) => {
      let streak = 0;
      for (let i = index - 1; i >= 0; i--) {
        if (!trades[i].won) {
          streak++;
        } else {
          break;
        }
      }
      return streak;
    },
    threshold: 2, // 2+ consecutive losses
    direction: 'above'
  },
  {
    name: 'Bankroll Drawdown',
    description: 'Drawdown from recent peak (last 10 trades)',
    calculate: (trades, index) => {
      if (index < 10) return null;
      const last10 = trades.slice(index - 10, index);
      const peak = Math.max(...last10.map(t => t.newBankroll));
      const current = trades[index - 1].newBankroll;
      return ((peak - current) / peak) * 100;
    },
    threshold: 20, // 20%+ drawdown from recent peak
    direction: 'above'
  },
  {
    name: 'Average Payout Quality',
    description: 'Average payout in last 5 trades',
    calculate: (trades, index) => {
      if (index < 5) return null;
      const last5 = trades.slice(index - 5, index);
      const avgPayout = last5.reduce((sum, t) => sum + t.estimatedPayout, 0) / 5;
      return avgPayout;
    },
    threshold: 1.6, // Average payout below 1.6x
    direction: 'below'
  },
  {
    name: 'EMA Gap Volatility',
    description: 'Std dev of EMA gaps in last 5 trades',
    calculate: (trades, index) => {
      if (index < 5) return null;
      const last5 = trades.slice(index - 5, index);
      const gaps = last5.map(t => Math.abs(t.emaGap));
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const variance = gaps.reduce((sum, gap) => sum + Math.pow(gap - avg, 2), 0) / gaps.length;
      return Math.sqrt(variance);
    },
    threshold: 0.15, // High volatility in EMA gaps
    direction: 'above'
  },
  {
    name: 'Low EMA Strength',
    description: 'Average EMA gap strength in last 5 trades',
    calculate: (trades, index) => {
      if (index < 5) return null;
      const last5 = trades.slice(index - 5, index);
      return last5.reduce((sum, t) => sum + Math.abs(t.emaGap), 0) / 5;
    },
    threshold: 0.10, // Weak average EMA signals
    direction: 'below'
  }
];

// For each indicator, test if it predicts next trade will lose
for (const indicator of indicators) {
  const results = {
    signalCount: 0,
    correctPredictions: 0,
    falsePredictions: 0,
    missedLosses: 0,
    correctlyIgnoredWins: 0
  };

  for (let i = 0; i < allTrades.length - 1; i++) {
    const value = indicator.calculate(allTrades, i + 1);

    if (value === null) continue;

    const signal = indicator.direction === 'below'
      ? value < indicator.threshold
      : value > indicator.threshold;

    const nextTradeLost = !allTrades[i + 1].won;

    if (signal) {
      results.signalCount++;
      if (nextTradeLost) {
        results.correctPredictions++;
      } else {
        results.falsePredictions++;
      }
    } else {
      if (nextTradeLost) {
        results.missedLosses++;
      } else {
        results.correctlyIgnoredWins++;
      }
    }
  }

  const accuracy = results.signalCount > 0
    ? (results.correctPredictions / results.signalCount) * 100
    : 0;

  const precision = results.signalCount > 0
    ? (results.correctPredictions / results.signalCount) * 100
    : 0;

  const totalLosses = results.correctPredictions + results.missedLosses;
  const recall = totalLosses > 0
    ? (results.correctPredictions / totalLosses) * 100
    : 0;

  console.log(`📊 ${indicator.name}:`);
  console.log(`   ${indicator.description}`);
  console.log(`   Threshold: ${indicator.direction} ${indicator.threshold}\n`);
  console.log(`   Signals triggered: ${results.signalCount}`);
  console.log(`   Correct predictions: ${results.correctPredictions} (predicted loss, got loss)`);
  console.log(`   False alarms: ${results.falsePredictions} (predicted loss, got win)`);
  console.log(`   Missed losses: ${results.missedLosses} (no signal, but lost)`);
  console.log(`   \n   Accuracy: ${accuracy.toFixed(1)}% (when signal fires, how often is next trade a loss?)`);
  console.log(`   Recall: ${recall.toFixed(1)}% (what % of all losses did we predict?)\n`);
  console.log('─'.repeat(100) + '\n');
}

// Test combined indicators
console.log('🎯 COMBINED INDICATOR TEST:\n');
console.log('   Skip trade if 2+ of these conditions are true:\n');
console.log('   1. Win rate < 40% in last 5 trades');
console.log('   2. 2+ consecutive losses');
console.log('   3. Drawdown > 20% from recent peak');
console.log('   4. Average payout < 1.6x in last 5\n');

let combinedResults = {
  skippedTrades: 0,
  skippedWouldLose: 0,
  skippedWouldWin: 0,
  tradedAndWon: 0,
  tradedAndLost: 0
};

for (let i = 0; i < allTrades.length; i++) {
  let conditionsMet = 0;

  // Condition 1: Win rate < 40%
  if (i >= 5) {
    const last5 = allTrades.slice(i - 5, i);
    const wins = last5.filter(t => t.won).length;
    const winRate = (wins / 5) * 100;
    if (winRate < 40) conditionsMet++;
  }

  // Condition 2: 2+ consecutive losses
  let streak = 0;
  for (let j = i - 1; j >= 0; j--) {
    if (!allTrades[j].won) {
      streak++;
    } else {
      break;
    }
  }
  if (streak >= 2) conditionsMet++;

  // Condition 3: 20%+ drawdown
  if (i >= 10) {
    const last10 = allTrades.slice(i - 10, i);
    const peak = Math.max(...last10.map(t => t.newBankroll));
    const current = allTrades[i - 1].newBankroll;
    const drawdown = ((peak - current) / peak) * 100;
    if (drawdown > 20) conditionsMet++;
  }

  // Condition 4: Avg payout < 1.6x
  if (i >= 5) {
    const last5 = allTrades.slice(i - 5, i);
    const avgPayout = last5.reduce((sum, t) => sum + t.estimatedPayout, 0) / 5;
    if (avgPayout < 1.6) conditionsMet++;
  }

  if (conditionsMet >= 2) {
    combinedResults.skippedTrades++;
    if (allTrades[i].won) {
      combinedResults.skippedWouldWin++;
    } else {
      combinedResults.skippedWouldLose++;
    }
  } else {
    if (allTrades[i].won) {
      combinedResults.tradedAndWon++;
    } else {
      combinedResults.tradedAndLost++;
    }
  }
}

console.log(`   Results:\n`);
console.log(`   Total trades: ${allTrades.length}`);
console.log(`   Skipped: ${combinedResults.skippedTrades}`);
console.log(`   Traded: ${combinedResults.tradedAndWon + combinedResults.tradedAndLost}\n`);

console.log(`   Skipped trades breakdown:`);
console.log(`     Would have won: ${combinedResults.skippedWouldWin} (missed profit)`);
console.log(`     Would have lost: ${combinedResults.skippedWouldLose} (avoided loss) ✅\n`);

console.log(`   Traded breakdown:`);
console.log(`     Won: ${combinedResults.tradedAndWon}`);
console.log(`     Lost: ${combinedResults.tradedAndLost}\n`);

const skippedWinRate = combinedResults.skippedTrades > 0
  ? (combinedResults.skippedWouldWin / combinedResults.skippedTrades) * 100
  : 0;

const tradedWinRate = (combinedResults.tradedAndWon + combinedResults.tradedAndLost) > 0
  ? (combinedResults.tradedAndWon / (combinedResults.tradedAndWon + combinedResults.tradedAndLost)) * 100
  : 0;

console.log(`   Win rate of skipped trades: ${skippedWinRate.toFixed(1)}%`);
console.log(`   Win rate of traded trades: ${tradedWinRate.toFixed(1)}%\n`);

if (skippedWinRate < tradedWinRate) {
  console.log(`   ✅ Filter works! Skipped trades had LOWER win rate than traded ones.\n`);
} else {
  console.log(`   ❌ Filter doesn't help. Skipped trades had HIGHER win rate.\n`);
}

console.log('═'.repeat(100) + '\n');

db.close();
