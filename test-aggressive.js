import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

// Simple aggressive strategy - NO EMA, just contrarian betting on crowd
function runAggressiveTest(rounds, crowdThreshold) {
  let wins = 0;
  let losses = 0;
  let balance = 1.0;
  let lastTwoResults = [];

  for (const round of rounds) {
    const t20sBullWei = BigInt(round.t20s_bull_wei || '0');
    const t20sBearWei = BigInt(round.t20s_bear_wei || '0');
    const t20sTotalWei = t20sBullWei + t20sBearWei;

    if (t20sTotalWei === 0n) continue;

    const bullPercent = Number(t20sBullWei * 10000n / t20sTotalWei) / 100;
    const bearPercent = Number(t20sBearWei * 10000n / t20sTotalWei) / 100;

    // Simple contrarian: bet against the crowd if ≥ threshold
    let betSide = null;
    if (bullPercent >= crowdThreshold) {
      betSide = 'BEAR'; // Crowd bullish → bet bear
    } else if (bearPercent >= crowdThreshold) {
      betSide = 'BULL'; // Crowd bearish → bet bull
    } else {
      continue; // Skip if not enough crowd
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
    totalTrades,
    wins,
    losses,
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

  console.log(`\n🚀 AGGRESSIVE STRATEGY TEST (NO EMA Filter)\n`);
  console.log(`Testing pure contrarian betting on ${rounds.length} rounds\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const results = [];
  const thresholds = [50, 55, 60, 65, 70];

  for (const threshold of thresholds) {
    const result = runAggressiveTest(rounds, threshold);
    results.push(result);
  }

  results.sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi));

  console.log(`Crowd% | Trades | Wins | Losses | Win%   | ROI       | Final Balance`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  results.forEach(r => {
    console.log(`${r.crowdThreshold}%    | ${r.totalTrades.toString().padEnd(6)} | ${r.wins.toString().padEnd(4)} | ${r.losses.toString().padEnd(6)} | ${r.winRate.padStart(6)}% | ${r.roi.padStart(9)}% | ${r.finalBalance} BNB`);
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`\n🏆 Best Result:\n`);
  const best = results[0];
  console.log(`Crowd Threshold: ${best.crowdThreshold}%`);
  console.log(`Total Trades: ${best.totalTrades}`);
  console.log(`Win Rate: ${best.winRate}%`);
  console.log(`ROI: ${best.roi}%`);
  console.log(`Final Balance: ${best.finalBalance} BNB`);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

test().catch(console.error);
