import { initDatabase } from './db-init.js';

const db = initDatabase();

function calculateBollingerBands(prices, period = 10) {
  if (prices.length < period) return null;
  const recentPrices = prices.slice(-period);
  const avg = recentPrices.reduce((a, b) => a + b, 0) / period;
  const variance = recentPrices.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = avg + (2 * stdDev);
  const lower = avg - (2 * stdDev);
  const currentPrice = prices[prices.length - 1];
  const position = ((currentPrice - lower) / (upper - lower)) * 100;
  return { upper, lower, avg, position, currentPrice, stdDev };
}

const config = {
  EMA_GAP: 0.05,
  MAX_PAYOUT: 1.55,
  MOMENTUM_MULT: 2.2,
  RECOVERY_MULT: 1.5,
  CB_THRESHOLD: 3,
  CB_COOLDOWN_MIN: 45,
  HYBRID_ENABLED: true,
  HYBRID_MIN_PAYOUT: 1.65,
};

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

let consecutiveLosses = 0;
let cooldownUntilTimestamp = 0;
let allPrices = rounds.map(r => r.close_price);

const hybridTrades = [];

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];
  const inCooldown = r.lock_timestamp < cooldownUntilTimestamp;

  if (!inCooldown) {
    // Track normal trades for circuit breaker
    const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
    const totalAmount = bullAmount + bearAmount;

    if (totalAmount === 0) continue;

    const bullPayout = totalAmount / bullAmount;
    const bearPayout = totalAmount / bearAmount;

    const emaSignal = r.ema_signal;
    let signal = null;

    if (emaSignal === 'BULL' && bullPayout >= config.MAX_PAYOUT) {
      signal = 'BULL';
    } else if (emaSignal === 'BEAR' && bearPayout >= config.MAX_PAYOUT) {
      signal = 'BEAR';
    }

    if (signal) {
      const won = (signal === 'BULL' && r.winner === 'bull') || (signal === 'BEAR' && r.winner === 'bear');

      if (!won) {
        consecutiveLosses++;
        if (consecutiveLosses >= config.CB_THRESHOLD) {
          cooldownUntilTimestamp = r.lock_timestamp + (config.CB_COOLDOWN_MIN * 60);
          consecutiveLosses = 0;
        }
      } else {
        consecutiveLosses = 0;
      }
    }
    continue;
  }

  // HYBRID TRADE ANALYSIS
  const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
  const totalAmount = bullAmount + bearAmount;

  if (totalAmount === 0) continue;

  const bullPayout = totalAmount / bullAmount;
  const bearPayout = totalAmount / bearAmount;

  const pricesForCalc = allPrices.slice(Math.max(0, i - 20), i + 1);
  const bb = calculateBollingerBands(pricesForCalc, 10);

  if (!bb) continue;

  let signal = null;
  let reason = '';

  if (bb.position < 35 && bullPayout >= config.HYBRID_MIN_PAYOUT) {
    signal = 'BULL';
    reason = `BB oversold (${bb.position.toFixed(1)}%)`;
  } else if (bb.position > 65 && bearPayout >= config.HYBRID_MIN_PAYOUT) {
    signal = 'BEAR';
    reason = `BB overbought (${bb.position.toFixed(1)}%)`;
  }

  if (!signal) continue;

  const payout = signal === 'BULL' ? bullPayout : bearPayout;
  const won = (signal === 'BULL' && r.winner === 'bull') || (signal === 'BEAR' && r.winner === 'bear');

  const priceMove = ((r.close_price - r.lock_price) / r.lock_price * 100);

  hybridTrades.push({
    epoch: r.epoch,
    signal,
    won,
    reason,
    bbPosition: bb.position.toFixed(1),
    payout: payout.toFixed(3),
    priceMove: priceMove.toFixed(3),
    lockPrice: (r.lock_price / 1e8).toFixed(2),
    closePrice: (r.close_price / 1e8).toFixed(2),
  });
}

console.log('🔬 HYBRID TRADE ANALYSIS\n');
console.log(`Total Hybrid Trades: ${hybridTrades.length}`);
console.log(`Wins: ${hybridTrades.filter(t => t.won).length}`);
console.log(`Losses: ${hybridTrades.filter(t => !t.won).length}`);
console.log(`Win Rate: ${(hybridTrades.filter(t => t.won).length / hybridTrades.length * 100).toFixed(1)}%\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('📊 ALL HYBRID TRADES:\n');
console.log('Epoch   │ Signal │ BB Pos │ Payout │ Lock → Close │ Move   │ Result │ Reason');
console.log('────────┼────────┼────────┼────────┼──────────────┼────────┼────────┼───────');

hybridTrades.forEach(t => {
  const result = t.won ? '✅ WIN ' : '❌ LOSS';
  const priceChange = `${t.lockPrice} → ${t.closePrice}`;
  console.log(
    `${String(t.epoch).padStart(7)} │ ${t.signal.padEnd(6)} │ ${String(t.bbPosition + '%').padStart(6)} │ ${t.payout.padStart(6)} │ ${priceChange.padEnd(12)} │ ${(t.priceMove + '%').padStart(6)} │ ${result} │ ${t.reason}`
  );
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

// Analyze why losses happen
const losses = hybridTrades.filter(t => !t.won);
console.log('❌ LOSS ANALYSIS:\n');

const bullLosses = losses.filter(t => t.signal === 'BULL');
const bearLosses = losses.filter(t => t.signal === 'BEAR');

console.log(`Bull losses: ${bullLosses.length}/${hybridTrades.filter(t => t.signal === 'BULL').length} (${(bullLosses.length / hybridTrades.filter(t => t.signal === 'BULL').length * 100).toFixed(1)}% loss rate)`);
console.log(`Bear losses: ${bearLosses.length}/${hybridTrades.filter(t => t.signal === 'BEAR').length} (${(bearLosses.length / hybridTrades.filter(t => t.signal === 'BEAR').length * 100).toFixed(1)}% loss rate)\n`);

// Check if BB mean reversion is actually working
const avgBBPositionBullWin = hybridTrades.filter(t => t.signal === 'BULL' && t.won).reduce((sum, t) => sum + parseFloat(t.bbPosition), 0) / hybridTrades.filter(t => t.signal === 'BULL' && t.won).length;
const avgBBPositionBullLoss = hybridTrades.filter(t => t.signal === 'BULL' && !t.won).reduce((sum, t) => sum + parseFloat(t.bbPosition), 0) / hybridTrades.filter(t => t.signal === 'BULL' && !t.won).length || 0;

console.log('BB Position Analysis:');
console.log(`  Bull WINS avg BB position: ${avgBBPositionBullWin.toFixed(1)}% (should be <35 for oversold)`);
console.log(`  Bull LOSSES avg BB position: ${avgBBPositionBullLoss.toFixed(1)}%\n`);

console.log('💡 CONCLUSION:');
console.log(`If win rate is <50%, the problem is: BB mean reversion doesn't work during losing streaks.`);
console.log(`The circuit breaker triggers BECAUSE we're in a bad market condition, so adding ANY`);
console.log(`strategy during cooldown (even mean reversion) is still trading in bad conditions.`);
