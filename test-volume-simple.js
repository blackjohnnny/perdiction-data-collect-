import { initDatabase } from './db-init.js';
import fetch from 'node-fetch';

const DB_PATH = './prediction.db';
const BINANCE_API = 'https://api.binance.com/api/v3/klines';

async function fetchCandles(timestamp, count = 10) {
  try {
    const endTime = timestamp * 1000;
    const startTime = endTime - (count * 5 * 60 * 1000);
    const url = `${BINANCE_API}?symbol=BNBUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=${count}`;
    const response = await fetch(url);
    const data = await response.json();
    const candles = data.map(candle => ({
      volume: parseFloat(candle[5])
    }));
    return candles;
  } catch (error) {
    return null;
  }
}

async function getVolumeCondition(lockTimestamp) {
  const candles = await fetchCandles(lockTimestamp, 10);
  if (!candles || candles.length < 10) return null;

  const volumes = candles.map(c => c.volume);
  const recentVolume = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const volumeRatio = recentVolume / avgVolume;

  return {
    isHighVolume: volumeRatio > 1.2,
    isLowVolume: volumeRatio < 0.8,
    volumeRatio: volumeRatio.toFixed(2)
  };
}

async function runStrategy(rounds, useVolumeFilter = false) {
  let wins = 0;
  let losses = 0;
  let balance = 1.0;
  let lastTwoResults = [];

  let lowVolumeTrades = 0;
  let highVolumeTrades = 0;
  let lowVolumeWins = 0;
  let highVolumeWins = 0;

  for (const round of rounds) {
    const t20sBullWei = BigInt(round.t20s_bull_wei || '0');
    const t20sBearWei = BigInt(round.t20s_bear_wei || '0');
    const t20sTotalWei = t20sBullWei + t20sBearWei;

    if (t20sTotalWei === 0n) continue;

    const bullPercent = Number(t20sBullWei * 10000n / t20sTotalWei) / 100;
    const bearPercent = Number(t20sBearWei * 10000n / t20sTotalWei) / 100;

    // Determine which side the crowd is on
    let crowdSide = null;
    if (bullPercent >= 65) {
      crowdSide = 'BULL';
    } else if (bearPercent >= 65) {
      crowdSide = 'BEAR';
    } else {
      continue; // Skip if crowd not strong enough
    }

    let betSide = null;
    let isLowVolume = false;

    if (useVolumeFilter) {
      // Get volume condition
      const volumeCondition = await getVolumeCondition(round.lock_timestamp);
      if (!volumeCondition) continue;

      if (volumeCondition.isLowVolume) {
        // LOW VOLUME (consolidation) → Bet WITH crowd (REVERSED)
        betSide = crowdSide;
        isLowVolume = true;
      } else if (volumeCondition.isHighVolume) {
        // HIGH VOLUME (trending) → Bet AGAINST crowd (CONTRARIAN)
        betSide = crowdSide === 'BULL' ? 'BEAR' : 'BULL';
        isLowVolume = false;
      } else {
        continue; // Medium volume, skip
      }
    } else {
      // NO FILTER - Always contrarian
      betSide = crowdSide === 'BULL' ? 'BEAR' : 'BULL';
    }

    // Dynamic sizing
    const basePercent = 6.5;
    let multiplier = 1.0;

    if (lastTwoResults.length >= 2) {
      const [prev1, prev2] = lastTwoResults;
      if (prev1 === 'loss' && prev2 === 'win') multiplier = 1.5;
      if (prev1 === 'win' && prev2 === 'win') multiplier = 0.75;
    }

    const betSize = balance * (basePercent / 100) * multiplier;
    const won = (betSide === round.winner.toUpperCase());

    if (won) {
      balance += betSize * (round.winner_payout_multiple - 1);
      wins++;
      lastTwoResults.unshift('win');
      if (useVolumeFilter) {
        if (isLowVolume) lowVolumeWins++;
        else highVolumeWins++;
      }
    } else {
      balance -= betSize;
      losses++;
      lastTwoResults.unshift('loss');
    }

    if (useVolumeFilter) {
      if (isLowVolume) lowVolumeTrades++;
      else highVolumeTrades++;
    }

    if (lastTwoResults.length > 2) lastTwoResults.pop();

    if (useVolumeFilter) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = ((balance - 1) * 100);

  const lowVolumeWinRate = lowVolumeTrades > 0 ? (lowVolumeWins / lowVolumeTrades) * 100 : 0;
  const highVolumeWinRate = highVolumeTrades > 0 ? (highVolumeWins / highVolumeTrades) * 100 : 0;

  return {
    totalTrades,
    wins,
    losses,
    winRate: winRate.toFixed(2),
    roi: roi.toFixed(2),
    finalBalance: balance.toFixed(4),
    lowVolumeTrades,
    highVolumeTrades,
    lowVolumeWins,
    highVolumeWins,
    lowVolumeWinRate: lowVolumeWinRate.toFixed(2),
    highVolumeWinRate: highVolumeWinRate.toFixed(2)
  };
}

async function test() {
  const db = initDatabase(DB_PATH);
  const rounds = db.prepare(`
    SELECT * FROM rounds
    WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND close_price IS NOT NULL
    ORDER BY sample_id ASC
  `).all();
  db.close();

  console.log(`\n📊 VOLUME-ADAPTIVE CONTRARIAN STRATEGY TEST\n`);
  console.log(`Testing on ${rounds.length} rounds\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  console.log(`Running ORIGINAL contrarian (no volume filter)...`);
  const original = await runStrategy(rounds, false);

  console.log(`Running VOLUME-ADAPTIVE contrarian...\n`);
  const adaptive = await runStrategy(rounds, true);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  console.log(`\n📊 RESULTS:\n`);
  console.log(`Strategy                              | Trades | Wins | Losses | Win%   | ROI       | Final Balance`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`ORIGINAL (always contrarian)          | ${original.totalTrades.toString().padEnd(6)} | ${original.wins.toString().padEnd(4)} | ${original.losses.toString().padEnd(6)} | ${original.winRate.padStart(6)}% | ${original.roi.padStart(9)}% | ${original.finalBalance} BNB`);
  console.log(`VOLUME-ADAPTIVE                       | ${adaptive.totalTrades.toString().padEnd(6)} | ${adaptive.wins.toString().padEnd(4)} | ${adaptive.losses.toString().padEnd(6)} | ${adaptive.winRate.padStart(6)}% | ${adaptive.roi.padStart(9)}% | ${adaptive.finalBalance} BNB`);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  console.log(`\n📈 VOLUME-ADAPTIVE BREAKDOWN:\n`);
  console.log(`Low Volume (consolidation):  ${adaptive.lowVolumeTrades} trades (${adaptive.lowVolumeWins} wins, ${adaptive.lowVolumeWinRate}% win rate)`);
  console.log(`  → Bet WITH crowd (reversed)\n`);
  console.log(`High Volume (trending):      ${adaptive.highVolumeTrades} trades (${adaptive.highVolumeWins} wins, ${adaptive.highVolumeWinRate}% win rate)`);
  console.log(`  → Bet AGAINST crowd (contrarian)\n`);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  console.log(`\n🏆 WINNER:\n`);
  const originalROI = parseFloat(original.roi);
  const adaptiveROI = parseFloat(adaptive.roi);

  if (adaptiveROI > originalROI) {
    console.log(`VOLUME-ADAPTIVE wins: ${adaptive.roi}% vs ${original.roi}%`);
    console.log(`Improvement: ${(adaptiveROI - originalROI).toFixed(2)} percentage points\n`);
  } else {
    console.log(`ORIGINAL wins: ${original.roi}% vs ${adaptive.roi}%`);
    console.log(`Volume filter made it worse by ${(originalROI - adaptiveROI).toFixed(2)} percentage points\n`);
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

test().catch(console.error);
