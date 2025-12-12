import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🔍 MARKET CONDITION ANALYSIS - WHAT CHANGED?\n');
console.log('═'.repeat(100) + '\n');
console.log('Analyzing: What market conditions changed that caused massive losses?\n');
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

console.log(`📊 Analyzing ${rounds.length} rounds\n\n`);

function getPrice(r) {
  const lock = parseFloat(r.lock_price);
  return lock > 1000000 ? lock / 1e8 : lock;
}

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0
};

// Run strategy and track bankroll over time
let bankroll = BASE_CONFIG.STARTING_BANKROLL;
let lastTwoResults = [];
const timeline = [];

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
  if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
    signal = 'BULL';
  } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
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
  if (betSize > bankroll || betSize <= 0) continue;

  const actualPayout = parseFloat(r.winner_payout_multiple);
  const won = signal.toLowerCase() === r.winner.toLowerCase();

  const prevBankroll = bankroll;

  if (won) {
    const profit = betSize * (actualPayout - 1);
    bankroll += profit;
  } else {
    bankroll -= betSize;
  }

  lastTwoResults.push(won);
  if (lastTwoResults.length > 2) lastTwoResults.shift();

  // Calculate market metrics
  const price = getPrice(r);
  const crowdBullPct = (bullWei / total) * 100;

  timeline.push({
    epoch: r.epoch,
    timestamp: r.lock_timestamp,
    date: new Date(r.lock_timestamp * 1000),
    bankroll,
    prevBankroll,
    change: bankroll - prevBankroll,
    changePercent: ((bankroll - prevBankroll) / prevBankroll) * 100,
    won,
    signal,
    emaSignal,
    emaGap,
    price,
    crowdBullPct,
    poolSize: total
  });
}

console.log('═'.repeat(100) + '\n');
console.log('📈 BANKROLL JOURNEY\n');
console.log('═'.repeat(100) + '\n\n');

// Find key events
const peak = timeline.reduce((max, t) => t.bankroll > max.bankroll ? t : max);
const bottom = timeline.slice(timeline.indexOf(peak)).reduce((min, t) => t.bankroll < min.bankroll ? t : min);

console.log(`PEAK: ${peak.bankroll.toFixed(3)} BNB`);
console.log(`  Date: ${peak.date.toLocaleDateString()} ${peak.date.toLocaleTimeString()}`);
console.log(`  Epoch: ${peak.epoch}\n`);

console.log(`BOTTOM (after peak): ${bottom.bankroll.toFixed(3)} BNB`);
console.log(`  Date: ${bottom.date.toLocaleDateString()} ${bottom.date.toLocaleTimeString()}`);
console.log(`  Epoch: ${bottom.epoch}`);
console.log(`  Drawdown from peak: ${((bottom.bankroll - peak.bankroll) / peak.bankroll * 100).toFixed(1)}%\n`);

console.log('═'.repeat(100) + '\n');
console.log('🔍 MARKET CONDITION COMPARISON\n');
console.log('═'.repeat(100) + '\n\n');

// Compare periods
const peakIndex = timeline.indexOf(peak);
const beforePeak = timeline.slice(Math.max(0, peakIndex - 50), peakIndex); // 50 trades before peak
const afterPeak = timeline.slice(peakIndex, Math.min(timeline.length, peakIndex + 50)); // 50 trades after peak

function analyzeWindow(window, label) {
  const wins = window.filter(t => t.won).length;
  const losses = window.filter(t => !t.won).length;
  const winRate = wins / (wins + losses) * 100;

  const avgEmaGap = window.reduce((sum, t) => sum + Math.abs(t.emaGap), 0) / window.length;
  const avgCrowdBullPct = window.reduce((sum, t) => sum + t.crowdBullPct, 0) / window.length;
  const avgPoolSize = window.reduce((sum, t) => sum + t.poolSize, 0) / window.length;

  // Price volatility
  const prices = window.map(t => t.price).filter(p => p > 0);
  const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length;
  const priceStdDev = Math.sqrt(prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length);
  const volatility = (priceStdDev / avgPrice) * 100;

  // EMA signal stability (how often it flips)
  let emaFlips = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i].emaSignal !== window[i - 1].emaSignal) {
      emaFlips++;
    }
  }

  // Contrarian opportunities (payout >= 1.45)
  const contrarian = window.length;

  console.log(`${label}:`);
  console.log(`  Period: ${window[0].date.toLocaleDateString()} - ${window[window.length - 1].date.toLocaleDateString()}`);
  console.log(`  Win Rate: ${winRate.toFixed(1)}% (${wins}W / ${losses}L)`);
  console.log(`  Avg EMA Gap: ${avgEmaGap.toFixed(3)}%`);
  console.log(`  Avg Crowd Bull%: ${avgCrowdBullPct.toFixed(1)}%`);
  console.log(`  Avg Pool Size: ${avgPoolSize.toFixed(2)} BNB`);
  console.log(`  Price Volatility: ${volatility.toFixed(2)}%`);
  console.log(`  EMA Flips: ${emaFlips} (${(emaFlips / window.length * 100).toFixed(1)}% of trades)`);
  console.log(`  Avg Price: $${avgPrice.toFixed(2)}\n`);

  return { winRate, avgEmaGap, avgCrowdBullPct, volatility, emaFlips, avgPrice };
}

const beforeStats = analyzeWindow(beforePeak, 'BEFORE PEAK (Good Performance)');
const afterStats = analyzeWindow(afterPeak, 'AFTER PEAK (Bad Performance)');

console.log('─'.repeat(100) + '\n');
console.log('📊 WHAT CHANGED?\n\n');

const wrChange = afterStats.winRate - beforeStats.winRate;
const emaGapChange = afterStats.avgEmaGap - beforeStats.avgEmaGap;
const volatilityChange = afterStats.volatility - beforeStats.volatility;
const emaFlipChange = afterStats.emaFlips - beforeStats.emaFlips;
const priceChange = ((afterStats.avgPrice - beforeStats.avgPrice) / beforeStats.avgPrice) * 100;

console.log(`Win Rate: ${beforeStats.winRate.toFixed(1)}% → ${afterStats.winRate.toFixed(1)}% (${wrChange >= 0 ? '+' : ''}${wrChange.toFixed(1)}%)`);
console.log(`  ${wrChange < -10 ? '🔴 MAJOR DETERIORATION' : wrChange < 0 ? '⚠️  Worse' : '✅ Better'}\n`);

console.log(`Avg EMA Gap: ${beforeStats.avgEmaGap.toFixed(3)}% → ${afterStats.avgEmaGap.toFixed(3)}% (${emaGapChange >= 0 ? '+' : ''}${emaGapChange.toFixed(3)}%)`);
console.log(`  ${Math.abs(emaGapChange) > 0.05 ? '🔴 Signals got ' + (emaGapChange > 0 ? 'STRONGER' : 'WEAKER') : '✅ Similar strength'}\n`);

console.log(`Price Volatility: ${beforeStats.volatility.toFixed(2)}% → ${afterStats.volatility.toFixed(2)}% (${volatilityChange >= 0 ? '+' : ''}${volatilityChange.toFixed(2)}%)`);
console.log(`  ${Math.abs(volatilityChange) > 0.5 ? '🔴 Market became ' + (volatilityChange > 0 ? 'MORE CHOPPY' : 'LESS VOLATILE') : '✅ Similar volatility'}\n`);

console.log(`EMA Flips: ${beforeStats.emaFlips} → ${afterStats.emaFlips} (${emaFlipChange >= 0 ? '+' : ''}${emaFlipChange})`);
console.log(`  ${Math.abs(emaFlipChange) > 5 ? '🔴 Market ' + (emaFlipChange > 0 ? 'got CHOPPIER (more flips)' : 'became more TRENDING') : '✅ Similar trend'}\n`);

console.log(`Avg Price: $${beforeStats.avgPrice.toFixed(2)} → $${afterStats.avgPrice.toFixed(2)} (${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(1)}%)`);
console.log(`  ${Math.abs(priceChange) > 5 ? '🔴 Price ' + (priceChange > 0 ? 'PUMPED' : 'DUMPED') : '✅ Stable'}\n`);

console.log('═'.repeat(100) + '\n');
console.log('💡 ROOT CAUSE ANALYSIS\n');
console.log('═'.repeat(100) + '\n\n');

// Find the 13-loss streak
let maxLossStreak = 0;
let currentStreak = 0;
let streakStart = -1;
let maxStreakStart = -1;
let maxStreakEnd = -1;

for (let i = 0; i < timeline.length; i++) {
  if (!timeline[i].won) {
    if (currentStreak === 0) streakStart = i;
    currentStreak++;
    if (currentStreak > maxLossStreak) {
      maxLossStreak = currentStreak;
      maxStreakStart = streakStart;
      maxStreakEnd = i;
    }
  } else {
    currentStreak = 0;
  }
}

console.log(`Longest loss streak: ${maxLossStreak} consecutive losses`);
console.log(`  Period: ${timeline[maxStreakStart].date.toLocaleDateString()} - ${timeline[maxStreakEnd].date.toLocaleDateString()}`);
console.log(`  Epochs: ${timeline[maxStreakStart].epoch} - ${timeline[maxStreakEnd].epoch}\n`);

const lossStreakPeriod = timeline.slice(maxStreakStart, maxStreakEnd + 1);
const lossStreakStats = {
  avgEmaGap: lossStreakPeriod.reduce((sum, t) => sum + Math.abs(t.emaGap), 0) / lossStreakPeriod.length,
  avgCrowdBullPct: lossStreakPeriod.reduce((sum, t) => sum + t.crowdBullPct, 0) / lossStreakPeriod.length,
  bullSignals: lossStreakPeriod.filter(t => t.signal === 'BULL').length,
  bearSignals: lossStreakPeriod.filter(t => t.signal === 'BEAR').length
};

console.log(`During ${maxLossStreak}-loss streak:`);
console.log(`  Avg EMA Gap: ${lossStreakStats.avgEmaGap.toFixed(3)}% (${lossStreakStats.avgEmaGap < 0.1 ? '🔴 VERY WEAK SIGNALS' : 'Normal'})`);
console.log(`  Bet BULL: ${lossStreakStats.bullSignals} times, Bet BEAR: ${lossStreakStats.bearSignals} times`);
console.log(`  Crowd Bull%: ${lossStreakStats.avgCrowdBullPct.toFixed(1)}%\n`);

console.log('─'.repeat(100) + '\n');
console.log('🎯 CONCLUSION:\n\n');

if (wrChange < -10) {
  console.log('The market fundamentally changed after peak:\n');
  if (emaFlipChange > 5) {
    console.log('  🔴 CHOPPY MARKET: EMA flipping back and forth rapidly');
    console.log('     → Contrarian strategy enters on weak signals that immediately reverse\n');
  }
  if (volatilityChange > 0.5) {
    console.log('  🔴 INCREASED VOLATILITY: Market became more erratic');
    console.log('     → Price swings cause EMA lag to be more pronounced\n');
  }
  if (lossStreakStats.avgEmaGap < 0.15) {
    console.log('  🔴 WEAK SIGNALS: EMA gaps got smaller during loss streak');
    console.log('     → Entering on barely-bullish/bearish signals that have no conviction\n');
  }
  if (Math.abs(priceChange) > 5) {
    console.log(`  🔴 PRICE ${priceChange > 0 ? 'PUMP' : 'DUMP'}: ${Math.abs(priceChange).toFixed(1)}% move`);
    console.log('     → Trend change that contrarian strategy fought against\n');
  }
} else {
  console.log('Market conditions remained similar - just bad luck with variance.\n');
}

console.log('Circuit breaker would prevent compounding losses during these bad periods.\n');

console.log('═'.repeat(100));

db.close();
