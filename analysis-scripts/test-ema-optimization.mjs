import { readFileSync } from 'fs';
import initSqlJs from 'sql.js';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('🔬 EMA Strategy Optimization - Testing Multiple Configurations\n');

// Get all rounds with T-20s data
const rounds = db.exec(`
  SELECT
    epoch,
    lock_ts,
    lock_price,
    close_price,
    bull_amount_wei,
    bear_amount_wei,
    total_amount_wei,
    winner,
    winner_multiple,
    t20s_bull_wei,
    t20s_bear_wei,
    t20s_total_wei,
    t20s_implied_up_multiple,
    t20s_implied_down_multiple
  FROM rounds
  WHERE t20s_total_wei IS NOT NULL
    AND winner != 'UNKNOWN'
  ORDER BY epoch
`)[0];

if (!rounds || rounds.values.length === 0) {
  console.log('❌ No rounds found with T-20s data');
  db.close();
  process.exit(1);
}

const roundsData = rounds.values.map(row => ({
  epoch: row[0],
  lock_ts: row[1],
  lock_price: parseFloat(row[2]) / 1e8,
  close_price: parseFloat(row[3]) / 1e8,
  bull_amount: row[4],
  bear_amount: row[5],
  total_amount: row[6],
  winner: row[7],
  winner_multiple: row[8],
  t20s_bull: row[9],
  t20s_bear: row[10],
  t20s_total: row[11],
  t20s_up_multiple: row[12],
  t20s_down_multiple: row[13]
}));

console.log(`📊 Total Rounds: ${roundsData.length}`);
console.log(`📅 Epoch Range: ${roundsData[0].epoch} to ${roundsData[roundsData.length - 1].epoch}\n`);

db.close();

// Fetch TradingView candle data
console.log('📡 Fetching BNB/USD 5-minute candles from TradingView/Pyth API...');
const lockTimestamps = roundsData.map(r => r.lock_ts);
const minLockTs = Math.min(...lockTimestamps);
const maxLockTs = Math.max(...lockTimestamps);
const startTime = minLockTs - 7200; // Extra buffer for EMA calculation
const endTime = maxLockTs + 3600;

const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.BNB/USD&resolution=5&from=${startTime}&to=${endTime}`;
const response = await globalThis.fetch(url);
const candles = await response.json();

console.log(`✅ Fetched ${candles.t.length} 5-minute candles\n`);

// Calculate EMA
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const emas = [];
  let ema = prices[0];

  for (let i = 0; i < prices.length; i++) {
    if (i === 0) {
      ema = prices[i];
    } else {
      ema = prices[i] * k + ema * (1 - k);
    }
    emas.push(ema);
  }

  return emas;
}

// Create EMA map from TradingView candles
const emaFastMap = new Map();
const emaSlowMap = new Map();

function createEMAMaps(fastPeriod, slowPeriod) {
  const closes = candles.c;
  const emaFast = calculateEMA(closes, fastPeriod);
  const emaSlow = calculateEMA(closes, slowPeriod);

  const fastMap = new Map();
  const slowMap = new Map();

  for (let i = 0; i < candles.t.length; i++) {
    fastMap.set(candles.t[i], emaFast[i]);
    slowMap.set(candles.t[i], emaSlow[i]);
  }

  return { fastMap, slowMap };
}

// Test strategy with given parameters
function testStrategy(roundsData, fastPeriod, slowPeriod, crowdThreshold, minGap, name) {
  const { fastMap, slowMap } = createEMAMaps(fastPeriod, slowPeriod);

  let bankroll = 1.0;
  const POSITION_SIZE = 0.02;
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  let upTrades = 0;
  let downTrades = 0;

  // Test all rounds (no need to skip, we have enough TradingView data)
  for (let i = 0; i < roundsData.length; i++) {
    const round = roundsData[i];

    // Round lock timestamp to nearest 5-minute interval (300 seconds)
    const roundedLockTs = Math.floor(round.lock_ts / 300) * 300;

    // Get EMA values at lock time
    const currentEmaFast = fastMap.get(roundedLockTs);
    const currentEmaSlow = slowMap.get(roundedLockTs);

    if (!currentEmaFast || !currentEmaSlow) {
      skipped++;
      continue;
    }

    const emaGap = Math.abs(currentEmaFast - currentEmaSlow) / currentEmaSlow;

    let emaSignal = null;
    if (currentEmaFast > currentEmaSlow) {
      emaSignal = 'UP';
    } else if (currentEmaFast < currentEmaSlow) {
      emaSignal = 'DOWN';
    }

    // Calculate T-20s crowd
    const t20sBullPct = parseFloat(round.t20s_bull) / parseFloat(round.t20s_total);
    const t20sBearPct = parseFloat(round.t20s_bear) / parseFloat(round.t20s_total);

    let crowdSignal = null;
    if (t20sBullPct >= crowdThreshold) {
      crowdSignal = 'UP';
    } else if (t20sBearPct >= crowdThreshold) {
      crowdSignal = 'DOWN';
    }

    // Check if EMA and crowd agree + meets gap threshold
    if (emaSignal && crowdSignal && emaSignal === crowdSignal && emaGap >= minGap) {
      const betAmount = bankroll * POSITION_SIZE;
      const actualWinner = round.winner;
      const won = emaSignal === actualWinner;

      if (won) {
        const payout = betAmount * round.winner_multiple;
        wins++;
        bankroll = bankroll - betAmount + payout;
      } else {
        losses++;
        bankroll = bankroll - betAmount;
      }

      if (emaSignal === 'UP') upTrades++;
      if (emaSignal === 'DOWN') downTrades++;
    } else {
      skipped++;
    }
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const roi = ((bankroll - 1.0) / 1.0 * 100);
  const tradableRounds = roundsData.length;

  return {
    name,
    fastPeriod,
    slowPeriod,
    crowdThreshold: (crowdThreshold * 100).toFixed(0) + '%',
    minGap: (minGap * 100).toFixed(2) + '%',
    totalTrades,
    wins,
    losses,
    upTrades,
    downTrades,
    winRate: winRate.toFixed(2) + '%',
    roi: roi.toFixed(2) + '%',
    finalBankroll: bankroll.toFixed(4),
    tradeFreq: ((totalTrades / tradableRounds) * 100).toFixed(1) + '%',
    skipped,
    tradableRounds
  };
}

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('🎯 TESTING DIFFERENT CONFIGURATIONS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

const results = [];

// Test 1: Original strategy (EMA 5/13, 55% crowd, 0.10% gap)
results.push(testStrategy(roundsData, 5, 13, 0.55, 0.0010, 'Original (EMA 5/13, gap 0.10%)'));

// Test 2: Remove EMA gap requirement
results.push(testStrategy(roundsData, 5, 13, 0.55, 0.0000, 'No Gap (EMA 5/13)'));

// Test 3: Higher crowd threshold
results.push(testStrategy(roundsData, 5, 13, 0.65, 0.0000, 'No Gap + 65% Crowd'));

// Test 4: Different EMA combinations - Faster
results.push(testStrategy(roundsData, 3, 8, 0.55, 0.0000, 'Faster (EMA 3/8)'));
results.push(testStrategy(roundsData, 5, 10, 0.55, 0.0000, 'Fast (EMA 5/10)'));

// Test 5: Slower EMAs
results.push(testStrategy(roundsData, 8, 21, 0.55, 0.0000, 'Slower (EMA 8/21)'));
results.push(testStrategy(roundsData, 10, 20, 0.55, 0.0000, 'Slow (EMA 10/20)'));

// Test 6: Traditional combinations
results.push(testStrategy(roundsData, 9, 21, 0.55, 0.0000, 'Traditional (EMA 9/21)'));
results.push(testStrategy(roundsData, 12, 26, 0.55, 0.0000, 'MACD-like (EMA 12/26)'));

// Test 7: Very fast scalping
results.push(testStrategy(roundsData, 3, 7, 0.55, 0.0000, 'Scalping (EMA 3/7)'));

// Print results table
console.log('Configuration                  | Trades | Wins | Losses | UP  | DOWN | Win Rate | ROI      | Bankroll | Freq  ');
console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────────────────');

for (const result of results) {
  const name = result.name.padEnd(30);
  const trades = result.totalTrades.toString().padStart(6);
  const wins = result.wins.toString().padStart(4);
  const losses = result.losses.toString().padStart(6);
  const up = result.upTrades.toString().padStart(3);
  const down = result.downTrades.toString().padStart(4);
  const winRate = result.winRate.padStart(8);
  const roi = result.roi.padStart(8);
  const bankroll = result.finalBankroll.padStart(8);
  const freq = result.tradeFreq.padStart(5);

  console.log(`${name} | ${trades} | ${wins} | ${losses} | ${up} | ${down} | ${winRate} | ${roi} | ${bankroll} | ${freq}`);
}

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('🏆 BEST PERFORMERS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

// Find best by win rate
const bestWinRate = [...results].sort((a, b) => parseFloat(b.winRate) - parseFloat(a.winRate))[0];
console.log(`🎯 Highest Win Rate: ${bestWinRate.name}`);
console.log(`   Win Rate: ${bestWinRate.winRate} | ROI: ${bestWinRate.roi} | Trades: ${bestWinRate.totalTrades}\n`);

// Find best by ROI
const bestROI = [...results].sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi))[0];
console.log(`💰 Highest ROI: ${bestROI.name}`);
console.log(`   ROI: ${bestROI.roi} | Win Rate: ${bestROI.winRate} | Trades: ${bestROI.totalTrades}\n`);

// Find best balance (win rate >= 55% and most trades)
const balanced = results
  .filter(r => parseFloat(r.winRate) >= 55.0 && r.totalTrades >= 20)
  .sort((a, b) => b.totalTrades - a.totalTrades)[0];

if (balanced) {
  console.log(`⚖️  Best Balanced (Win Rate ≥55%, Most Trades): ${balanced.name}`);
  console.log(`   Win Rate: ${balanced.winRate} | ROI: ${balanced.roi} | Trades: ${balanced.totalTrades}\n`);
} else {
  console.log(`⚠️  No configuration achieved ≥55% win rate with ≥20 trades\n`);
}

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('📝 INSIGHTS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

// Count UP vs DOWN trades across all configs
const totalUp = results.reduce((sum, r) => sum + r.upTrades, 0);
const totalDown = results.reduce((sum, r) => sum + r.downTrades, 0);
const totalAllTrades = results.reduce((sum, r) => sum + r.totalTrades, 0);

console.log(`Signal Distribution (across all configs):`);
console.log(`   UP trades:   ${totalUp} (${(totalUp / totalAllTrades * 100).toFixed(1)}%)`);
console.log(`   DOWN trades: ${totalDown} (${(totalDown / totalAllTrades * 100).toFixed(1)}%)`);

if (totalDown > totalUp * 2) {
  console.log(`\n⚠️  Market was in strong DOWNTREND during this period`);
  console.log(`   This may not be representative of typical market conditions.`);
}

console.log(`\nDataset Size: ${roundsData.length} rounds`);
console.log(`Note: Small sample size - results may not be statistically significant.`);
console.log(`      Recommended: 200+ rounds for reliable validation.\n`);
