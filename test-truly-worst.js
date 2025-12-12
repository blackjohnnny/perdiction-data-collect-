import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

// TRULY WORST - bet WITH crowd when payouts are HIGH (close to 50/50 = most unpredictable)
function runTrulyWorstTest(rounds, crowdThreshold, minPayout) {
  let wins = 0;
  let losses = 0;
  let balance = 1.0;
  let lastTwoResults = [];
  let skipped = 0;

  for (const round of rounds) {
    const t20sBullWei = BigInt(round.t20s_bull_wei || '0');
    const t20sBearWei = BigInt(round.t20s_bear_wei || '0');
    const t20sTotalWei = t20sBullWei + t20sBearWei;

    if (t20sTotalWei === 0n) {
      skipped++;
      continue;
    }

    const bullPercent = Number(t20sBullWei * 10000n / t20sTotalWei) / 100;
    const bearPercent = Number(t20sBearWei * 10000n / t20sTotalWei) / 100;

    // Bet WITH the crowd at low threshold
    let betSide = null;
    if (bullPercent >= crowdThreshold) {
      betSide = 'BULL'; // WITH crowd
    } else if (bearPercent >= crowdThreshold) {
      betSide = 'BEAR'; // WITH crowd
    } else {
      skipped++;
      continue;
    }

    // FILTER for HIGH payouts (close to 50/50 = most random/unpredictable)
    if (round.winner_payout_multiple < minPayout) {
      skipped++;
      continue;
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
    } else {
      balance -= betSize;
      losses++;
      lastTwoResults.unshift('loss');
    }

    if (lastTwoResults.length > 2) lastTwoResults.pop();
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = ((balance - 1) * 100);

  return {
    crowdThreshold,
    minPayout,
    totalTrades,
    wins,
    losses,
    skipped,
    winRate: winRate.toFixed(2),
    roi: roi.toFixed(2),
    finalBalance: balance.toFixed(4)
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

  console.log(`\n☠️☠️☠️  TRULY WORST STRATEGY - Bet WITH Crowd on HIGH Payout Rounds (50/50 coin flips)\n`);
  console.log(`Goal: LOWEST win rate by betting random outcomes\n`);
  console.log(`Testing on ${rounds.length} rounds\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const results = [];
  const crowdThresholds = [50, 52, 55];
  const minPayouts = [1.80, 1.90, 2.00]; // Only bet on close matches (most random)

  for (const crowdThreshold of crowdThresholds) {
    for (const minPayout of minPayouts) {
      const result = runTrulyWorstTest(rounds, crowdThreshold, minPayout);
      if (result.totalTrades > 10) { // Need enough trades to be meaningful
        results.push(result);
      }
    }
  }

  // Sort by WORST win rate (lowest)
  results.sort((a, b) => parseFloat(a.winRate) - parseFloat(b.winRate));

  console.log(`Crowd% | MinPay | Trades | Wins | Losses | Win%   | ROI         | Final Balance | Trade%`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  results.forEach(r => {
    const tradePercent = ((r.totalTrades / rounds.length) * 100).toFixed(1);
    console.log(`${r.crowdThreshold}%    | ${r.minPayout.toFixed(2)}x  | ${r.totalTrades.toString().padEnd(6)} | ${r.wins.toString().padEnd(4)} | ${r.losses.toString().padEnd(6)} | ${r.winRate.padStart(6)}% | ${r.roi.padStart(11)}% | ${r.finalBalance} BNB | ${tradePercent}%`);
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (results.length > 0) {
    console.log(`\n💀 LOWEST WIN RATE FOUND:\n`);
    const worstWinRate = results[0];
    console.log(`Strategy: Bet WITH crowd ${worstWinRate.crowdThreshold}%, only when payout > ${worstWinRate.minPayout}x (coin flip rounds)`);
    console.log(`Total Trades: ${worstWinRate.totalTrades} (${((worstWinRate.totalTrades/rounds.length)*100).toFixed(1)}% of rounds)`);
    console.log(`Win Rate: ${worstWinRate.winRate}% 💀 (LOWEST!)`);
    console.log(`ROI: ${worstWinRate.roi}%`);
    console.log(`Final Balance: ${worstWinRate.finalBalance} BNB`);

    // Find worst ROI
    const worstROI = results.sort((a, b) => parseFloat(a.roi) - parseFloat(b.roi))[0];

    console.log(`\n💀 BIGGEST MONEY LOSS:\n`);
    console.log(`Strategy: Bet WITH crowd ${worstROI.crowdThreshold}%, only when payout > ${worstROI.minPayout}x`);
    console.log(`Total Trades: ${worstROI.totalTrades}`);
    console.log(`Win Rate: ${worstROI.winRate}%`);
    console.log(`ROI: ${worstROI.roi}% 💀 (DESTROYED!)`);
    console.log(`Final Balance: ${worstROI.finalBalance} BNB`);
    console.log(`Money Lost: ${(1 - parseFloat(worstROI.finalBalance)).toFixed(4)} BNB`);
  }

  console.log(`\n📊 ULTIMATE RANKING:\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Strategy                                          | Trades | Win%   | ROI`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🏆 BEST: Contrarian 65%                            | 184    | 54.89% | +196.38%`);
  console.log(`💀 Bad: With Crowd 52%                             | 248    | 48.79% |  -80.99%`);
  if (results.length > 0) {
    const worst = results.sort((a, b) => parseFloat(a.winRate) - parseFloat(b.winRate))[0];
    console.log(`☠️  WORST: With Crowd ${worst.crowdThreshold}% + Payout>${worst.minPayout}x (coin flips) | ${worst.totalTrades.toString().padEnd(6)} | ${worst.winRate}% | ${worst.roi.padStart(9)}%`);
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

test().catch(console.error);
