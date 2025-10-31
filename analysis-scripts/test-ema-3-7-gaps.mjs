import { readFileSync } from 'fs';
import initSqlJs from 'sql.js';

const SQL = await initSqlJs();
const buffer = readFileSync('./data/live-monitor.db');
const db = new SQL.Database(buffer);

console.log('🔬 EMA 3/7 Gap Optimization - Finding Best Gap Threshold\n');

// Get all rounds with T-20s data
const rounds = db.exec(`
  SELECT
    epoch,
    lock_ts,
    winner,
    winner_multiple,
    t20s_bull_wei,
    t20s_bear_wei,
    t20s_total_wei
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
  winner: row[2],
  winner_multiple: row[3],
  t20s_bull: row[4],
  t20s_bear: row[5],
  t20s_total: row[6]
}));

console.log(`📊 Total Rounds: ${roundsData.length}`);
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

// Test strategy with given parameters
function testStrategy(crowdThreshold, minGap, name) {
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

  return {
    name,
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
    skipped
  };
}

console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('🎯 TESTING EMA 3/7 WITH DIFFERENT GAP THRESHOLDS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

const results = [];

// Test different gap thresholds with 55% crowd
console.log('📋 Gap Variations (55% Crowd Threshold):\n');

const gapThresholds = [
  0.0000,  // No gap
  0.0005,  // 0.05%
  0.0010,  // 0.10%
  0.0015,  // 0.15%
  0.0020,  // 0.20%
  0.0025,  // 0.25%
  0.0030,  // 0.30%
  0.0050,  // 0.50%
  0.0075,  // 0.75%
  0.0100,  // 1.00%
  0.0150,  // 1.50%
  0.0200,  // 2.00%
];

for (const gap of gapThresholds) {
  const gapPct = (gap * 100).toFixed(2);
  results.push(testStrategy(0.55, gap, `Gap ${gapPct}%`));
}

// Print results table
console.log('Gap      | Crowd | Trades | Wins | Losses | UP  | DOWN | Win Rate | ROI      | Bankroll | Freq  ');
console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────');

for (const result of results) {
  const gap = result.minGap.padEnd(8);
  const crowd = result.crowdThreshold.padEnd(5);
  const trades = result.totalTrades.toString().padStart(6);
  const wins = result.wins.toString().padStart(4);
  const losses = result.losses.toString().padStart(6);
  const up = result.upTrades.toString().padStart(3);
  const down = result.downTrades.toString().padStart(4);
  const winRate = result.winRate.padStart(8);
  const roi = result.roi.padStart(8);
  const bankroll = result.finalBankroll.padStart(8);
  const freq = result.tradeFreq.padStart(5);

  console.log(`${gap} | ${crowd} | ${trades} | ${wins} | ${losses} | ${up} | ${down} | ${winRate} | ${roi} | ${bankroll} | ${freq}`);
}

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('🏆 BEST PERFORMERS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

// Find best by win rate
const bestWinRate = [...results].sort((a, b) => parseFloat(b.winRate) - parseFloat(a.winRate))[0];
console.log(`🎯 Highest Win Rate: ${bestWinRate.name} (Gap: ${bestWinRate.minGap})`);
console.log(`   Win Rate: ${bestWinRate.winRate} | ROI: ${bestWinRate.roi} | Trades: ${bestWinRate.totalTrades}\n`);

// Find best by ROI
const bestROI = [...results].sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi))[0];
console.log(`💰 Highest ROI: ${bestROI.name} (Gap: ${bestROI.minGap})`);
console.log(`   ROI: ${bestROI.roi} | Win Rate: ${bestROI.winRate} | Trades: ${bestROI.totalTrades}\n`);

// Find best balance (win rate >= 55% and ROI > 20%)
const topPerformers = results
  .filter(r => parseFloat(r.winRate) >= 55.0 && parseFloat(r.roi) >= 20.0)
  .sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi));

if (topPerformers.length > 0) {
  console.log(`⚖️  Best Balanced (Win Rate ≥55%, ROI ≥20%):`);
  topPerformers.slice(0, 3).forEach((r, i) => {
    console.log(`   ${i + 1}. ${r.name} - Win Rate: ${r.winRate}, ROI: ${r.roi}, Trades: ${r.totalTrades}`);
  });
} else {
  console.log(`⚠️  No configuration achieved ≥55% win rate with ≥20% ROI\n`);
}

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('📊 ADDITIONAL TESTS - DIFFERENT CROWD THRESHOLDS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

// Test best gap with different crowd thresholds
const bestGap = parseFloat(bestROI.minGap) / 100;
const crowdResults = [];

console.log(`Testing Gap ${(bestGap * 100).toFixed(2)}% with different crowd thresholds:\n`);

const crowdThresholds = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80];

for (const crowd of crowdThresholds) {
  crowdResults.push(testStrategy(crowd, bestGap, `Crowd ${(crowd * 100).toFixed(0)}%`));
}

console.log('Crowd | Gap      | Trades | Wins | Win Rate | ROI      | Bankroll');
console.log('────────────────────────────────────────────────────────────────────');

for (const result of crowdResults) {
  const crowd = result.crowdThreshold.padEnd(5);
  const gap = result.minGap.padEnd(8);
  const trades = result.totalTrades.toString().padStart(6);
  const wins = result.wins.toString().padStart(4);
  const winRate = result.winRate.padStart(8);
  const roi = result.roi.padStart(8);
  const bankroll = result.finalBankroll.padStart(8);

  console.log(`${crowd} | ${gap} | ${trades} | ${wins} | ${winRate} | ${roi} | ${bankroll}`);
}

const bestCrowd = [...crowdResults].sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi))[0];

console.log('\n═══════════════════════════════════════════════════════════════════════════════');
console.log('🎖️  OPTIMAL CONFIGURATION');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

console.log(`🏆 Best Overall Setup: EMA 3/7`);
console.log(`   Gap Threshold: ${bestCrowd.minGap}`);
console.log(`   Crowd Threshold: ${bestCrowd.crowdThreshold}`);
console.log(`   Win Rate: ${bestCrowd.winRate}`);
console.log(`   ROI: ${bestCrowd.roi}`);
console.log(`   Total Trades: ${bestCrowd.totalTrades}`);
console.log(`   Trade Frequency: ${bestCrowd.tradeFreq}`);
console.log(`   Final Bankroll: ${bestCrowd.finalBankroll} BNB (from 1.0000 BNB)\n`);

console.log(`📝 Summary:`);
console.log(`   - Using TradingView/Pyth 5-minute BNB/USD candles`);
console.log(`   - EMA 3 crosses above/below EMA 7 for trend signal`);
console.log(`   - Bet WITH crowd when EMA and crowd agree`);
console.log(`   - Gap filter ensures strong trend conviction`);
console.log(`   - 2% position sizing for compound growth\n`);
