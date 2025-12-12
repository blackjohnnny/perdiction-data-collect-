import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🔍 ANALYZING EMA LAG PROBLEM\n');
console.log('═'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Analyzing ${rounds.length} complete rounds\n`);
console.log('─'.repeat(100) + '\n');

// Get price at a round
function getPrice(r) {
  const lock = parseFloat(r.lock_price);
  return lock > 1000000 ? lock / 1e8 : lock;
}

// Check if price is about to reverse (next candle goes opposite direction)
function detectReversal(rounds, index, betSide) {
  if (index >= rounds.length - 1) return { isReversal: false };

  const current = rounds[index];
  const next = rounds[index + 1];

  const currentPrice = getPrice(current);
  const nextPrice = getPrice(next);
  const priceChange = ((nextPrice - currentPrice) / currentPrice) * 100;

  // If we bet BULL but price drops next candle = reversal
  // If we bet BEAR but price rises next candle = reversal
  const isReversal =
    (betSide === 'BULL' && priceChange < -0.1) ||
    (betSide === 'BEAR' && priceChange > 0.1);

  return {
    isReversal,
    priceChange,
    currentPrice,
    nextPrice
  };
}

// Check price momentum (last N candles trend)
function getPriceMomentum(rounds, index, lookback = 3) {
  const startIdx = Math.max(0, index - lookback);
  const priceWindow = rounds.slice(startIdx, index + 1).map(r => getPrice(r));

  if (priceWindow.length < 2) return { momentum: 0, direction: 'NEUTRAL' };

  const firstPrice = priceWindow[0];
  const lastPrice = priceWindow[priceWindow.length - 1];
  const momentum = ((lastPrice - firstPrice) / firstPrice) * 100;

  let direction = 'NEUTRAL';
  if (momentum > 0.15) direction = 'BULLISH';
  else if (momentum < -0.15) direction = 'BEARISH';

  return { momentum, direction };
}

// Check if EMA signal JUST flipped (within last 2 candles)
function recentEMAFlip(rounds, index, currentSignal) {
  if (index < 2) return false;

  const prev1 = rounds[index - 1];
  const prev2 = rounds[index - 2];

  // Check if signal flipped in last 2 candles
  const flipped1 = prev1.ema_signal && prev1.ema_signal !== currentSignal;
  const flipped2 = prev2.ema_signal && prev2.ema_signal !== currentSignal;

  return flipped1 || flipped2;
}

// Simulate baseline strategy and analyze losses
const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0
};

let bankroll = BASE_CONFIG.STARTING_BANKROLL;
let lastTwoResults = [];
const losses = [];
const wins = [];

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];
  const emaSignal = r.ema_signal;
  const emaGap = parseFloat(r.ema_gap);

  if (!emaSignal || emaSignal === 'NEUTRAL') continue;

  const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;
  if (total === 0) continue;

  const bullPayout = (total * 0.97) / bullWei;
  const bearPayout = (total * 0.97) / bearWei;

  let betSide = null;
  if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
    betSide = 'BULL';
  } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
    betSide = 'BEAR';
  }

  if (!betSide) continue;

  // Calculate position size
  let sizeMultiplier = 1.0;
  const hasStrongSignal = Math.abs(emaGap) >= 0.15;
  if (hasStrongSignal) {
    sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
  }

  const hasRecovery = lastTwoResults.length === 2 && lastTwoResults.every(r => !r);
  if (hasRecovery) {
    sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
  }

  const betSize = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
  if (betSize > bankroll) continue;

  const actualPayout = betSide === 'BULL' ? bullPayout : bearPayout;
  const won = r.winner.toLowerCase() === betSide.toLowerCase();

  const profit = won ? betSize * (actualPayout - 1) : -betSize;
  bankroll += profit;

  lastTwoResults.push(won);
  if (lastTwoResults.length > 2) lastTwoResults.shift();

  // Analyze the trade
  const reversal = detectReversal(rounds, i, betSide);
  const priceMomentum = getPriceMomentum(rounds, i, 3);
  const emaFlipped = recentEMAFlip(rounds, i, emaSignal);

  const trade = {
    epoch: r.epoch,
    timestamp: r.lock_timestamp,
    betSide,
    emaSignal,
    emaGap,
    won,
    reversal: reversal.isReversal,
    priceChange: reversal.priceChange,
    priceMomentum: priceMomentum.momentum,
    priceDirection: priceMomentum.direction,
    emaFlipped,
    betSize,
    bankroll
  };

  if (won) {
    wins.push(trade);
  } else {
    losses.push(trade);
  }
}

console.log('📊 LOSS ANALYSIS\n');
console.log('═'.repeat(100) + '\n');

// Analyze reversal pattern
const lossesWithReversal = losses.filter(t => t.reversal);
const winsWithReversal = wins.filter(t => t.reversal);

console.log('REVERSAL DETECTION (price goes opposite direction next candle):\n');
console.log(`  Losses with reversal: ${lossesWithReversal.length}/${losses.length} (${(lossesWithReversal.length/losses.length*100).toFixed(1)}%)`);
console.log(`  Wins with reversal: ${winsWithReversal.length}/${wins.length} (${(winsWithReversal.length/wins.length*100).toFixed(1)}%)\n`);

// Analyze EMA vs price momentum mismatch
const lossesMismatch = losses.filter(t =>
  (t.betSide === 'BULL' && t.priceDirection === 'BEARISH') ||
  (t.betSide === 'BEAR' && t.priceDirection === 'BULLISH')
);
const winsMismatch = wins.filter(t =>
  (t.betSide === 'BULL' && t.priceDirection === 'BEARISH') ||
  (t.betSide === 'BEAR' && t.priceDirection === 'BULLISH')
);

console.log('EMA vs PRICE MOMENTUM MISMATCH (EMA says BULL but recent price trend is BEARISH):\n');
console.log(`  Losses with mismatch: ${lossesMismatch.length}/${losses.length} (${(lossesMismatch.length/losses.length*100).toFixed(1)}%)`);
console.log(`  Wins with mismatch: ${winsMismatch.length}/${wins.length} (${(winsMismatch.length/wins.length*100).toFixed(1)}%)\n`);

// Analyze recent EMA flip
const lossesAfterFlip = losses.filter(t => t.emaFlipped);
const winsAfterFlip = wins.filter(t => t.emaFlipped);

console.log('RECENT EMA FLIP (signal changed in last 2 candles):\n');
console.log(`  Losses after flip: ${lossesAfterFlip.length}/${losses.length} (${(lossesAfterFlip.length/losses.length*100).toFixed(1)}%)`);
console.log(`  Wins after flip: ${winsAfterFlip.length}/${wins.length} (${(winsAfterFlip.length/wins.length*100).toFixed(1)}%)\n`);

console.log('─'.repeat(100) + '\n');

// Analyze BULL vs BEAR performance with mismatch
const bullLossesMismatch = losses.filter(t => t.betSide === 'BULL' && t.priceDirection === 'BEARISH');
const bearLossesMismatch = losses.filter(t => t.betSide === 'BEAR' && t.priceDirection === 'BULLISH');

console.log('DIRECTIONAL ANALYSIS:\n');
console.log(`  BULL bets when price momentum is BEARISH: ${bullLossesMismatch.length} losses`);
console.log(`  BEAR bets when price momentum is BULLISH: ${bearLossesMismatch.length} losses\n`);

// Find the 13-loss streak
console.log('═'.repeat(100) + '\n');
console.log('🔍 ANALYZING 13-LOSS STREAK (Epochs 434815-434832)\n');
console.log('─'.repeat(100) + '\n');

const streakLosses = losses.filter(t => t.epoch >= 434815 && t.epoch <= 434832);

console.log(`Found ${streakLosses.length} losses in this period:\n`);

for (const loss of streakLosses) {
  console.log(`Epoch ${loss.epoch}:`);
  console.log(`  Bet: ${loss.betSide} | EMA: ${loss.emaSignal} (${loss.emaGap.toFixed(3)}%)`);
  console.log(`  Price momentum (3 candles): ${loss.priceMomentum.toFixed(2)}% (${loss.priceDirection})`);
  console.log(`  Reversal next candle: ${loss.reversal ? 'YES' : 'NO'} ${loss.priceChange ? `(${loss.priceChange.toFixed(2)}%)` : ''}`);
  console.log(`  EMA flipped recently: ${loss.emaFlipped ? 'YES' : 'NO'}`);
  console.log(`  ⚠️  MISMATCH: ${(loss.betSide === 'BULL' && loss.priceDirection === 'BEARISH') || (loss.betSide === 'BEAR' && loss.priceDirection === 'BULLISH') ? 'YES' : 'NO'}\n`);
}

console.log('═'.repeat(100) + '\n');
console.log('💡 POTENTIAL SOLUTIONS\n');
console.log('─'.repeat(100) + '\n');

// Test filtering strategies
console.log('Testing filter: Skip when EMA and price momentum MISMATCH\n');

let testBankroll = 1.0;
let testLastTwo = [];
let skipped = 0;
let testWins = 0;
let testLosses = 0;

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];
  const emaSignal = r.ema_signal;
  const emaGap = parseFloat(r.ema_gap);

  if (!emaSignal || emaSignal === 'NEUTRAL') continue;

  const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;
  if (total === 0) continue;

  const bullPayout = (total * 0.97) / bullWei;
  const bearPayout = (total * 0.97) / bearWei;

  let betSide = null;
  if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
    betSide = 'BULL';
  } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
    betSide = 'BEAR';
  }

  if (!betSide) continue;

  // FILTER: Check price momentum
  const priceMomentum = getPriceMomentum(rounds, i, 3);
  const hasMismatch =
    (betSide === 'BULL' && priceMomentum.direction === 'BEARISH') ||
    (betSide === 'BEAR' && priceMomentum.direction === 'BULLISH');

  if (hasMismatch) {
    skipped++;
    continue;
  }

  // Calculate position size
  let sizeMultiplier = 1.0;
  const hasStrongSignal = Math.abs(emaGap) >= 0.15;
  if (hasStrongSignal) {
    sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
  }

  const hasRecovery = testLastTwo.length === 2 && testLastTwo.every(r => !r);
  if (hasRecovery) {
    sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
  }

  const betSize = testBankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
  if (betSize > testBankroll) continue;

  const actualPayout = betSide === 'BULL' ? bullPayout : bearPayout;
  const won = r.winner.toLowerCase() === betSide.toLowerCase();

  const profit = won ? betSize * (actualPayout - 1) : -betSize;
  testBankroll += profit;

  testLastTwo.push(won);
  if (testLastTwo.length > 2) testLastTwo.shift();

  if (won) testWins++;
  else testLosses++;
}

const testTrades = testWins + testLosses;
const testWR = (testWins / testTrades) * 100;
const testROI = ((testBankroll - 1.0) / 1.0) * 100;

console.log(`Results: ${testTrades} trades | ${testWR.toFixed(1)}% WR | ${testROI.toFixed(2)}% ROI`);
console.log(`Skipped: ${skipped} trades with EMA/price mismatch`);
console.log(`Final bankroll: ${testBankroll.toFixed(3)} BNB\n`);

console.log('═'.repeat(100));

db.close();
