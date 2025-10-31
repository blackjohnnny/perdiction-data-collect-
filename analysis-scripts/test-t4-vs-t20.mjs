import { readFileSync } from 'fs';
import initSqlJs from 'sql.js';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('🔬 T-4s vs T-20s Comparison - EMA 3/7 Strategy\n');

// Get all rounds with BOTH T-20s and T-4s data
const rounds = db.exec(`
  SELECT
    epoch,
    lock_ts,
    winner,
    winner_multiple,
    t20s_bull_wei,
    t20s_bear_wei,
    t20s_total_wei,
    t4s_bull_wei,
    t4s_bear_wei,
    t4s_total_wei
  FROM rounds
  WHERE t20s_total_wei IS NOT NULL
    AND t4s_total_wei IS NOT NULL
    AND winner != 'UNKNOWN'
  ORDER BY epoch
`)[0];

if (!rounds || rounds.values.length === 0) {
  console.log('❌ No rounds found with both T-20s and T-4s data');
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
  t4s_bull: row[7],
  t4s_bear: row[8],
  t4s_total: row[9]
}));

console.log(`📊 Total Rounds with BOTH T-20s and T-4s: ${roundsData.length}`);
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

// Test strategy with T-20s or T-4s snapshot
function testStrategy(snapshotType, crowdThreshold, minGap, name) {
  let bankroll = 1.0;
  const POSITION_SIZE = 0.02;
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  let upTrades = 0;
  let downTrades = 0;
  let trades = [];

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

      trades.push({
        epoch: round.epoch,
        signal: emaSignal,
        crowdPct: emaSignal === 'UP' ? bullPct : bearPct,
        won: won,
        bankroll: bankroll
      });
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
    skipped,
    trades
  };
}

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('🎯 COMPARISON: T-20s vs T-4s Snapshots');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

const results = [];

// Test optimal configuration with T-20s
console.log('📋 Testing Optimal EMA 3/7 Configuration:\n');

// Test with different gap thresholds for both T-20s and T-4s
const configs = [
  { gap: 0.0000, crowd: 0.55, name: 'No Gap (55% crowd)' },
  { gap: 0.0005, crowd: 0.55, name: '0.05% Gap (55% crowd)' },
  { gap: 0.0005, crowd: 0.60, name: '0.05% Gap (60% crowd)' },
  { gap: 0.0005, crowd: 0.65, name: '0.05% Gap (65% crowd)' },
  { gap: 0.0010, crowd: 0.60, name: '0.10% Gap (60% crowd)' },
  { gap: 0.0010, crowd: 0.65, name: '0.10% Gap (65% crowd)' },
];

for (const config of configs) {
  results.push({
    ...testStrategy('t20s', config.crowd, config.gap, `T-20s: ${config.name}`),
    config
  });
  results.push({
    ...testStrategy('t4s', config.crowd, config.gap, `T-4s: ${config.name}`),
    config
  });
}

// Print comparison table
console.log('Snapshot | Configuration              | Trades | Wins | Losses | Win Rate | ROI      | Bankroll');
console.log('─────────────────────────────────────────────────────────────────────────────────────────────────');

for (const result of results) {
  const snapshot = result.snapshotType.toUpperCase().padEnd(8);
  const config = result.config.name.padEnd(26);
  const trades = result.totalTrades.toString().padStart(6);
  const wins = result.wins.toString().padStart(4);
  const losses = result.losses.toString().padStart(6);
  const winRate = result.winRate.padStart(8);
  const roi = result.roi.padStart(8);
  const bankroll = result.finalBankroll.padStart(8);

  console.log(`${snapshot} | ${config} | ${trades} | ${wins} | ${losses} | ${winRate} | ${roi} | ${bankroll}`);
}

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('🏆 BEST PERFORMERS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

// Find best T-20s configuration
const t20sResults = results.filter(r => r.snapshotType === 't20s');
const bestT20s = [...t20sResults].sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi))[0];

console.log(`📍 Best T-20s Configuration: ${bestT20s.config.name}`);
console.log(`   Win Rate: ${bestT20s.winRate} | ROI: ${bestT20s.roi} | Trades: ${bestT20s.totalTrades}`);
console.log(`   Final Bankroll: ${bestT20s.finalBankroll} BNB\n`);

// Find best T-4s configuration
const t4sResults = results.filter(r => r.snapshotType === 't4s');
const bestT4s = [...t4sResults].sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi))[0];

console.log(`📍 Best T-4s Configuration: ${bestT4s.config.name}`);
console.log(`   Win Rate: ${bestT4s.winRate} | ROI: ${bestT4s.roi} | Trades: ${bestT4s.totalTrades}`);
console.log(`   Final Bankroll: ${bestT4s.finalBankroll} BNB\n`);

// Calculate difference
const t20sROI = parseFloat(bestT20s.roi);
const t4sROI = parseFloat(bestT4s.roi);
const difference = t4sROI - t20sROI;

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('📊 COMPARISON SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

console.log(`T-20s Strategy:`);
console.log(`   ├─ ROI: ${bestT20s.roi}`);
console.log(`   ├─ Win Rate: ${bestT20s.winRate}`);
console.log(`   ├─ Trades: ${bestT20s.totalTrades}`);
console.log(`   └─ Bankroll: ${bestT20s.finalBankroll} BNB\n`);

console.log(`T-4s Strategy:`);
console.log(`   ├─ ROI: ${bestT4s.roi}`);
console.log(`   ├─ Win Rate: ${bestT4s.winRate}`);
console.log(`   ├─ Trades: ${bestT4s.totalTrades}`);
console.log(`   └─ Bankroll: ${bestT4s.finalBankroll} BNB\n`);

if (difference > 0) {
  console.log(`🏆 WINNER: T-4s is MORE profitable!`);
  console.log(`   Improvement: +${difference.toFixed(2)}% ROI\n`);
} else if (difference < 0) {
  console.log(`🏆 WINNER: T-20s is MORE profitable!`);
  console.log(`   Improvement: +${Math.abs(difference).toFixed(2)}% ROI\n`);
} else {
  console.log(`⚖️  TIE: Both strategies perform equally\n`);
}

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('💡 INSIGHTS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

// Check if crowd flips between T-20s and T-4s
let crowdFlips = 0;
let significantFlips = 0; // Flips > 5%

for (const round of roundsData) {
  const t20sBullPct = parseFloat(round.t20s_bull) / parseFloat(round.t20s_total);
  const t4sBullPct = parseFloat(round.t4s_bull) / parseFloat(round.t4s_total);

  const t20sCrowd = t20sBullPct >= 0.5 ? 'UP' : 'DOWN';
  const t4sCrowd = t4sBullPct >= 0.5 ? 'UP' : 'DOWN';

  if (t20sCrowd !== t4sCrowd) {
    crowdFlips++;
  }

  if (Math.abs(t20sBullPct - t4sBullPct) > 0.05) {
    significantFlips++;
  }
}

console.log(`Crowd Behavior Analysis:`);
console.log(`   ├─ Crowd flips between T-20s and T-4s: ${crowdFlips} (${(crowdFlips/roundsData.length*100).toFixed(1)}%)`);
console.log(`   ├─ Significant pool changes (>5%): ${significantFlips} (${(significantFlips/roundsData.length*100).toFixed(1)}%)`);
console.log(`   └─ Stable rounds: ${roundsData.length - significantFlips}\n`);

if (t4sROI > t20sROI) {
  console.log(`✅ T-4s Advantage:`);
  console.log(`   - More accurate crowd sentiment (closer to lock)`);
  console.log(`   - Less time for late manipulation`);
  console.log(`   - Better final pool alignment\n`);
} else {
  console.log(`✅ T-20s Advantage:`);
  console.log(`   - More time to execute bet (20s vs 4s)`);
  console.log(`   - Less prone to last-second panic moves`);
  console.log(`   - Better for automated execution\n`);
}

console.log(`⚠️  Trade-offs:`);
console.log(`   T-20s: More execution time, less accuracy`);
console.log(`   T-4s: Higher accuracy, VERY tight execution window (4 seconds!)\n`);

console.log(`Dataset: ${roundsData.length} rounds with both T-20s and T-4s snapshots\n`);
