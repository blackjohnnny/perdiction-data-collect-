import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';

console.log('\n🔍 TESTING DIFFERENT EMA PERIODS - LAST 2 HOURS\n');
console.log('═'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

const now = Math.floor(Date.now() / 1000);
const twoHoursAgo = now - (2 * 60 * 60);

const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE lock_timestamp >= ?
    AND t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all(twoHoursAgo);

console.log(`📊 Found ${rounds.length} complete rounds\n`);

// Fetch candles for EMA calculation
async function getCandles(timestamp, lookback) {
  try {
    const endTime = timestamp * 1000;
    const startTime = endTime - (lookback * 5 * 60 * 1000);
    const url = `https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=${lookback}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const candles = await response.json();
    if (!Array.isArray(candles) || candles.length < lookback) return null;
    return candles.map(c => parseFloat(c[4]));
  } catch (err) {
    return null;
  }
}

// Calculate EMA variations
const EMA_CONFIGS = [
  { short: 3, long: 7, name: 'EMA 3/7' },
  { short: 5, long: 13, name: 'EMA 5/13' },
  { short: 3, long: 10, name: 'EMA 3/10' },
  { short: 5, long: 21, name: 'EMA 5/21' },
  { short: 8, long: 21, name: 'EMA 8/21' },
  { short: 2, long: 5, name: 'EMA 2/5' }
];

console.log('🔄 Fetching price data from Binance...\n');

// Get max lookback needed
const maxLookback = Math.max(...EMA_CONFIGS.map(c => c.long));

// Fetch candles for each round
for (let i = 0; i < rounds.length; i++) {
  const candles = await getCandles(rounds[i].lock_timestamp, maxLookback);
  if (candles) {
    rounds[i].candles = candles;
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}

console.log('✅ Price data ready\n');
console.log('─'.repeat(100) + '\n');

function calculateEMA(closes, shortPeriod, longPeriod, gapThreshold = 0.05) {
  if (closes.length < longPeriod) return null;

  const emaShort = closes.slice(-shortPeriod).reduce((a, b) => a + b) / shortPeriod;
  const emaLong = closes.slice(-longPeriod).reduce((a, b) => a + b) / longPeriod;
  const gap = ((emaShort - emaLong) / emaLong) * 100;
  const signal = gap > gapThreshold ? 'BULL' : gap < -gapThreshold ? 'BEAR' : 'NEUTRAL';

  return { signal, gap, emaShort, emaLong };
}

function runStrategy(rounds, emaConfig, contrarian = true) {
  const CONFIG = {
    BASE_POSITION_SIZE: 0.045,
    MOMENTUM_MULTIPLIER: 1.889,
    RECOVERY_MULTIPLIER: 1.5,
    MIN_PAYOUT: 1.45,
    STARTING_BANKROLL: 1.0
  };

  let bankroll = CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let wins = 0;
  let losses = 0;
  let totalProfit = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    if (!r.candles) continue;

    const ema = calculateEMA(r.candles, emaConfig.short, emaConfig.long);
    if (!ema || ema.signal === 'NEUTRAL') continue;

    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPercent = (bullWei / total) * 100;
    const bearPercent = (bearWei / total) * 100;
    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    let betSide = null;

    if (contrarian) {
      // CONTRARIAN: EMA + Against Crowd (payout filter)
      if (ema.signal === 'BULL' && bearPayout >= CONFIG.MIN_PAYOUT) {
        betSide = 'BULL';
      } else if (ema.signal === 'BEAR' && bullPayout >= CONFIG.MIN_PAYOUT) {
        betSide = 'BEAR';
      }
    } else {
      // CONSENSUS: EMA + With Crowd
      const crowdFavorite = bullPercent > bearPercent ? 'BULL' : 'BEAR';
      if (ema.signal === crowdFavorite) {
        betSide = ema.signal;
      }
    }

    if (!betSide) continue;

    // Position sizing
    let sizeMultiplier = 1.0;
    if (Math.abs(ema.gap) >= 0.15) {
      sizeMultiplier = CONFIG.MOMENTUM_MULTIPLIER;
    }
    if (lastTwoResults[0] === 'LOSS') {
      sizeMultiplier *= CONFIG.RECOVERY_MULTIPLIER;
    }

    const betSize = bankroll * CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    const won = betSide.toLowerCase() === r.winner.toLowerCase();
    const actualPayout = parseFloat(r.winner_payout_multiple);

    if (won) {
      const profit = betSize * (actualPayout - 1);
      bankroll += profit;
      totalProfit += profit;
      wins++;
      lastTwoResults.unshift('WIN');
    } else {
      bankroll -= betSize;
      totalProfit -= betSize;
      losses++;
      lastTwoResults.unshift('LOSS');
    }

    if (lastTwoResults.length > 2) lastTwoResults.pop();
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = (totalProfit / CONFIG.STARTING_BANKROLL) * 100;

  return {
    trades: totalTrades,
    wins,
    losses,
    winRate,
    roi,
    finalBankroll: bankroll,
    profit: totalProfit
  };
}

console.log('📊 CONTRARIAN STRATEGY (EMA + Against Crowd, Payout ≥1.45x)\n');
console.log('─'.repeat(100) + '\n');

const contrarianResults = [];
for (const config of EMA_CONFIGS) {
  const result = runStrategy(rounds, config, true);
  contrarianResults.push({ ...config, ...result });

  const roiStr = result.roi >= 0 ? `+${result.roi.toFixed(2)}%` : `${result.roi.toFixed(2)}%`;
  const roiColor = result.roi >= 0 ? '✅' : '❌';

  console.log(`${config.name.padEnd(15)} | Trades: ${result.trades.toString().padStart(2)} | WR: ${result.winRate.toFixed(1).padStart(5)}% | ROI: ${roiColor} ${roiStr.padStart(9)}`);
}

console.log('\n' + '─'.repeat(100) + '\n');

console.log('📊 CONSENSUS STRATEGY (EMA + With Crowd)\n');
console.log('─'.repeat(100) + '\n');

const consensusResults = [];
for (const config of EMA_CONFIGS) {
  const result = runStrategy(rounds, config, false);
  consensusResults.push({ ...config, ...result });

  const roiStr = result.roi >= 0 ? `+${result.roi.toFixed(2)}%` : `${result.roi.toFixed(2)}%`;
  const roiColor = result.roi >= 0 ? '✅' : '❌';

  console.log(`${config.name.padEnd(15)} | Trades: ${result.trades.toString().padStart(2)} | WR: ${result.winRate.toFixed(1).padStart(5)}% | ROI: ${roiColor} ${roiStr.padStart(9)}`);
}

console.log('\n' + '═'.repeat(100) + '\n');

// Best performers
console.log('🏆 BEST PERFORMERS (Last 2 Hours):\n');

const bestContrarian = contrarianResults.reduce((best, curr) => curr.roi > best.roi ? curr : best);
const bestConsensus = consensusResults.reduce((best, curr) => curr.roi > best.roi ? curr : best);

console.log('Contrarian:');
console.log(`  ${bestContrarian.name} - ${bestContrarian.trades} trades, ${bestContrarian.winRate.toFixed(1)}% WR, ${bestContrarian.roi >= 0 ? '+' : ''}${bestContrarian.roi.toFixed(2)}% ROI\n`);

console.log('Consensus:');
console.log(`  ${bestConsensus.name} - ${bestConsensus.trades} trades, ${bestConsensus.winRate.toFixed(1)}% WR, ${bestConsensus.roi >= 0 ? '+' : ''}${bestConsensus.roi.toFixed(2)}% ROI\n`);

const overallBest = bestContrarian.roi > bestConsensus.roi ? bestContrarian : bestConsensus;
const strategyType = bestContrarian.roi > bestConsensus.roi ? 'Contrarian' : 'Consensus';

console.log('🥇 Overall Best:');
console.log(`  ${strategyType} with ${overallBest.name}`);
console.log(`  ${overallBest.trades} trades | ${overallBest.winRate.toFixed(1)}% WR | ${overallBest.roi >= 0 ? '+' : ''}${overallBest.roi.toFixed(2)}% ROI`);
console.log(`  Final Bankroll: ${overallBest.finalBankroll.toFixed(6)} BNB\n`);

console.log('═'.repeat(100) + '\n');

// Comparison to baseline (3/7)
const baseline = contrarianResults[0];
console.log('📈 IMPROVEMENT VS BASELINE (EMA 3/7 Contrarian):\n');
console.log(`  Baseline: ${baseline.trades} trades, ${baseline.winRate.toFixed(1)}% WR, ${baseline.roi.toFixed(2)}% ROI\n`);

const improvements = [...contrarianResults, ...consensusResults]
  .filter(r => r.name !== 'EMA 3/7' || r !== baseline)
  .map(r => ({
    ...r,
    improvement: r.roi - baseline.roi,
    type: contrarianResults.includes(r) ? 'Contrarian' : 'Consensus'
  }))
  .sort((a, b) => b.improvement - a.improvement);

console.log('Top 3 Improvements:\n');
for (let i = 0; i < Math.min(3, improvements.length); i++) {
  const imp = improvements[i];
  const improvementStr = imp.improvement >= 0 ? `+${imp.improvement.toFixed(2)}%` : `${imp.improvement.toFixed(2)}%`;
  console.log(`  ${(i+1)}. ${imp.type} ${imp.name} - ${improvementStr} improvement`);
  console.log(`     ${imp.trades} trades | ${imp.winRate.toFixed(1)}% WR | ${imp.roi >= 0 ? '+' : ''}${imp.roi.toFixed(2)}% ROI\n`);
}

console.log('═'.repeat(100) + '\n');

db.close();
