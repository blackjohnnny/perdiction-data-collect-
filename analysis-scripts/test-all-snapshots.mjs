import { readFileSync } from 'fs';
import initSqlJs from 'sql.js';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('🔬 Complete Snapshot Comparison - T-20s vs T-8s vs T-4s\n');

// Get all rounds with ALL three snapshot types
const rounds = db.exec(`
  SELECT
    epoch,
    lock_ts,
    winner,
    winner_multiple,
    t20s_bull_wei,
    t20s_bear_wei,
    t20s_total_wei,
    t8s_bull_wei,
    t8s_bear_wei,
    t8s_total_wei,
    t4s_bull_wei,
    t4s_bear_wei,
    t4s_total_wei
  FROM rounds
  WHERE t20s_total_wei IS NOT NULL
    AND t8s_total_wei IS NOT NULL
    AND t4s_total_wei IS NOT NULL
    AND winner != 'UNKNOWN'
  ORDER BY epoch
`)[0];

if (!rounds || rounds.values.length === 0) {
  console.log('❌ No rounds found with all snapshot types');
  db.close();
  process.exit(1);
}

const roundsData = rounds.values.map(row => ({
  epoch: row[0],
  lock_ts: row[1],
  winner: row[2],
  winner_multiple: row[3],
  t20s_bull: row[4],
  t20s_bear: row[5],
  t20s_total: row[6],
  t8s_bull: row[7],
  t8s_bear: row[8],
  t8s_total: row[9],
  t4s_bull: row[10],
  t4s_bear: row[11],
  t4s_total: row[12]
}));

console.log(`📊 Total Rounds with ALL snapshots (T-20s, T-8s, T-4s): ${roundsData.length}`);
console.log(`📅 Epoch Range: ${roundsData[0].epoch} to ${roundsData[roundsData.length - 1].epoch}\n`);

db.close();

// Fetch TradingView candle data
console.log('📡 Fetching BNB/USD 5-minute candles from TradingView/Pyth API...');
const lockTimestamps = roundsData.map(r => r.lock_ts);
const minLockTs = Math.min(...lockTimestamps);
const maxLockTs = Math.max(...lockTimestamps);
const startTime = minLockTs - 7200;
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

// Create EMA 3/7 maps
const closes = candles.c;
const ema3 = calculateEMA(closes, 3);
const ema7 = calculateEMA(closes, 7);

const ema3Map = new Map();
const ema7Map = new Map();

for (let i = 0; i < candles.t.length; i++) {
  ema3Map.set(candles.t[i], ema3[i]);
  ema7Map.set(candles.t[i], ema7[i]);
}

// Test strategy with specified snapshot type
function testStrategy(snapshotType, crowdThreshold, minGap, name) {
  let bankroll = 1.0;
  const POSITION_SIZE = 0.02;
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  let upTrades = 0;
  let downTrades = 0;

  for (let i = 0; i < roundsData.length; i++) {
    const round = roundsData[i];

    // Round lock timestamp to nearest 5-minute interval
    const roundedLockTs = Math.floor(round.lock_ts / 300) * 300;

    // Get EMA values at lock time
    const currentEma3 = ema3Map.get(roundedLockTs);
    const currentEma7 = ema7Map.get(roundedLockTs);

    if (!currentEma3 || !currentEma7) {
      skipped++;
      continue;
    }

    const emaGap = Math.abs(currentEma3 - currentEma7) / currentEma7;

    let emaSignal = null;
    if (currentEma3 > currentEma7) {
      emaSignal = 'UP';
    } else if (currentEma3 < currentEma7) {
      emaSignal = 'DOWN';
    }

    // Calculate crowd based on snapshot type
    let bullPct, bearPct;
    if (snapshotType === 't20s') {
      bullPct = parseFloat(round.t20s_bull) / parseFloat(round.t20s_total);
      bearPct = parseFloat(round.t20s_bear) / parseFloat(round.t20s_total);
    } else if (snapshotType === 't8s') {
      bullPct = parseFloat(round.t8s_bull) / parseFloat(round.t8s_total);
      bearPct = parseFloat(round.t8s_bear) / parseFloat(round.t8s_total);
    } else {
      bullPct = parseFloat(round.t4s_bull) / parseFloat(round.t4s_total);
      bearPct = parseFloat(round.t4s_bear) / parseFloat(round.t4s_total);
    }

    let crowdSignal = null;
    if (bullPct >= crowdThreshold) {
      crowdSignal = 'UP';
    } else if (bearPct >= crowdThreshold) {
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

  return {
    name,
    snapshotType,
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
    tradeFreq: ((totalTrades / roundsData.length) * 100).toFixed(1) + '%',
    profit: (bankroll - 1.0).toFixed(4)
  };
}

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('🎯 COMPREHENSIVE COMPARISON: ALL SNAPSHOT TYPES');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

const results = [];

// Test optimal configurations for all three snapshot types
const configs = [
  { gap: 0.0000, crowd: 0.55, name: 'No Gap + 55% Crowd' },
  { gap: 0.0005, crowd: 0.55, name: '0.05% Gap + 55% Crowd' },
  { gap: 0.0005, crowd: 0.60, name: '0.05% Gap + 60% Crowd' },
  { gap: 0.0005, crowd: 0.65, name: '0.05% Gap + 65% Crowd' },
  { gap: 0.0010, crowd: 0.60, name: '0.10% Gap + 60% Crowd' },
  { gap: 0.0010, crowd: 0.65, name: '0.10% Gap + 65% Crowd' },
];

for (const config of configs) {
  results.push({
    ...testStrategy('t20s', config.crowd, config.gap, `T-20s: ${config.name}`),
    config
  });
  results.push({
    ...testStrategy('t8s', config.crowd, config.gap, `T-8s: ${config.name}`),
    config
  });
  results.push({
    ...testStrategy('t4s', config.crowd, config.gap, `T-4s: ${config.name}`),
    config
  });
}

// Print comparison table
console.log('Snapshot | Configuration                | Trades | Wins | Losses | Win Rate | ROI      | Profit   | Bankroll');
console.log('───────────────────────────────────────────────────────────────────────────────────────────────────────────────');

for (const result of results) {
  const snapshot = result.snapshotType.toUpperCase().padEnd(8);
  const config = result.config.name.padEnd(28);
  const trades = result.totalTrades.toString().padStart(6);
  const wins = result.wins.toString().padStart(4);
  const losses = result.losses.toString().padStart(6);
  const winRate = result.winRate.padStart(8);
  const roi = result.roi.padStart(8);
  const profit = result.profit.padStart(8);
  const bankroll = result.finalBankroll.padStart(8);

  console.log(`${snapshot} | ${config} | ${trades} | ${wins} | ${losses} | ${winRate} | ${roi} | ${profit} | ${bankroll}`);
}

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('🏆 BEST PERFORMERS BY SNAPSHOT TYPE');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

// Find best for each snapshot type
const t20sResults = results.filter(r => r.snapshotType === 't20s');
const t8sResults = results.filter(r => r.snapshotType === 't8s');
const t4sResults = results.filter(r => r.snapshotType === 't4s');

const bestT20s = [...t20sResults].sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi))[0];
const bestT8s = [...t8sResults].sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi))[0];
const bestT4s = [...t4sResults].sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi))[0];

console.log(`🥇 Best T-20s: ${bestT20s.config.name}`);
console.log(`   Win Rate: ${bestT20s.winRate} | ROI: ${bestT20s.roi} | Trades: ${bestT20s.totalTrades} | Profit: +${bestT20s.profit} BNB\n`);

console.log(`🥈 Best T-8s: ${bestT8s.config.name}`);
console.log(`   Win Rate: ${bestT8s.winRate} | ROI: ${bestT8s.roi} | Trades: ${bestT8s.totalTrades} | Profit: +${bestT8s.profit} BNB\n`);

console.log(`🥉 Best T-4s: ${bestT4s.config.name}`);
console.log(`   Win Rate: ${bestT4s.winRate} | ROI: ${bestT4s.roi} | Trades: ${bestT4s.totalTrades} | Profit: +${bestT4s.profit} BNB\n`);

// Find overall best
const allBest = [bestT20s, bestT8s, bestT4s];
const overallBest = [...allBest].sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi))[0];

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('👑 OVERALL WINNER');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

console.log(`🏆 ${overallBest.snapshotType.toUpperCase()} with ${overallBest.config.name}`);
console.log(`   ├─ Win Rate: ${overallBest.winRate}`);
console.log(`   ├─ ROI: ${overallBest.roi}`);
console.log(`   ├─ Trades: ${overallBest.totalTrades}`);
console.log(`   ├─ Profit: +${overallBest.profit} BNB`);
console.log(`   └─ Final Bankroll: ${overallBest.finalBankroll} BNB\n`);

// Rankings
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('📊 RANKINGS BY ROI');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

const sorted = [...allBest].sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi));
sorted.forEach((result, i) => {
  const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
  console.log(`${medal} #${i + 1}: ${result.snapshotType.toUpperCase()} - ROI: ${result.roi}, Win Rate: ${result.winRate}, Trades: ${result.totalTrades}`);
});

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('💡 INSIGHTS & ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

// Analyze crowd behavior changes
let t20sToT8sFlips = 0;
let t8sToT4sFlips = 0;
let t20sToT4sFlips = 0;

for (const round of roundsData) {
  const t20sBullPct = parseFloat(round.t20s_bull) / parseFloat(round.t20s_total);
  const t8sBullPct = parseFloat(round.t8s_bull) / parseFloat(round.t8s_total);
  const t4sBullPct = parseFloat(round.t4s_bull) / parseFloat(round.t4s_total);

  const t20sCrowd = t20sBullPct >= 0.5 ? 'UP' : 'DOWN';
  const t8sCrowd = t8sBullPct >= 0.5 ? 'UP' : 'DOWN';
  const t4sCrowd = t4sBullPct >= 0.5 ? 'UP' : 'DOWN';

  if (t20sCrowd !== t8sCrowd) t20sToT8sFlips++;
  if (t8sCrowd !== t4sCrowd) t8sToT4sFlips++;
  if (t20sCrowd !== t4sCrowd) t20sToT4sFlips++;
}

console.log(`📈 Crowd Stability Analysis:`);
console.log(`   ├─ T-20s → T-8s crowd flips: ${t20sToT8sFlips} (${(t20sToT8sFlips/roundsData.length*100).toFixed(1)}%)`);
console.log(`   ├─ T-8s → T-4s crowd flips: ${t8sToT4sFlips} (${(t8sToT4sFlips/roundsData.length*100).toFixed(1)}%)`);
console.log(`   └─ T-20s → T-4s crowd flips: ${t20sToT4sFlips} (${(t20sToT4sFlips/roundsData.length*100).toFixed(1)}%)\n`);

console.log(`⏱️  Execution Window Analysis:`);
console.log(`   ├─ T-20s: 20 seconds to decide & execute`);
console.log(`   ├─ T-8s:  8 seconds to decide & execute`);
console.log(`   └─ T-4s:  4 seconds to decide & execute\n`);

const roiDiff20to8 = parseFloat(bestT20s.roi) - parseFloat(bestT8s.roi);
const roiDiff8to4 = parseFloat(bestT8s.roi) - parseFloat(bestT4s.roi);

console.log(`💰 ROI Comparison:`);
console.log(`   ├─ T-20s vs T-8s: ${roiDiff20to8 >= 0 ? '+' : ''}${roiDiff20to8.toFixed(2)}% (T-20s ${roiDiff20to8 >= 0 ? 'better' : 'worse'})`);
console.log(`   └─ T-8s vs T-4s: ${roiDiff8to4 >= 0 ? '+' : ''}${roiDiff8to4.toFixed(2)}% (T-8s ${roiDiff8to4 >= 0 ? 'better' : 'worse'})\n`);

console.log(`✅ Recommendation:`);
if (overallBest.snapshotType === 't20s') {
  console.log(`   Use T-20s for best balance of profitability and execution time.`);
} else if (overallBest.snapshotType === 't8s') {
  console.log(`   Use T-8s for optimal performance if you can handle tighter execution.`);
} else {
  console.log(`   Use T-4s if you need highest accuracy and can execute very quickly.`);
}

console.log(`\nDataset: ${roundsData.length} rounds with all three snapshot types\n`);
