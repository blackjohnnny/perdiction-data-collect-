import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

// SHITTIEST strategy - bet WITH crowd at LOW thresholds (worst possible)
function runShittiestTest(rounds, crowdThreshold) {
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

    // SHITTIEST: bet WITH the crowd at LOWEST threshold (bet every round basically)
    let betSide = null;
    if (bullPercent >= crowdThreshold) {
      betSide = 'BULL'; // WITH crowd (terrible payouts)
    } else if (bearPercent >= crowdThreshold) {
      betSide = 'BEAR'; // WITH crowd (terrible payouts)
    } else {
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

  console.log(`\n💩 SHITTIEST STRATEGY TEST - Bet WITH Crowd at LOWEST Thresholds\n`);
  console.log(`Goal: Maximum trades, lowest win rate, worst ROI possible\n`);
  console.log(`Testing on ${rounds.length} rounds\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const results = [];
  // Super low thresholds = trade almost every round
  const thresholds = [45, 50, 52, 55, 60];

  for (const threshold of thresholds) {
    const result = runShittiestTest(rounds, threshold);
    results.push(result);
  }

  // Sort by WORST ROI (most negative)
  results.sort((a, b) => parseFloat(a.roi) - parseFloat(b.roi));

  console.log(`Crowd% | Trades | Wins | Losses | Win%   | ROI        | Final Balance | Trade%`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  results.forEach(r => {
    const tradePercent = ((r.totalTrades / rounds.length) * 100).toFixed(1);
    console.log(`${r.crowdThreshold}%    | ${r.totalTrades.toString().padEnd(6)} | ${r.wins.toString().padEnd(4)} | ${r.losses.toString().padEnd(6)} | ${r.winRate.padStart(6)}% | ${r.roi.padStart(10)}% | ${r.finalBalance} BNB | ${tradePercent}%`);
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`\n💀 ABSOLUTE WORST Strategy:\n`);
  const worst = results[0];
  console.log(`Crowd Threshold: ${worst.crowdThreshold}%`);
  console.log(`Total Trades: ${worst.totalTrades} (${((worst.totalTrades/rounds.length)*100).toFixed(1)}% of rounds)`);
  console.log(`Win Rate: ${worst.winRate}% (terrible!)`);
  console.log(`ROI: ${worst.roi}% (destroyed!)`);
  console.log(`Final Balance: ${worst.finalBalance} BNB (from 1.0 BNB)`);
  console.log(`Money Lost: ${(1 - parseFloat(worst.finalBalance)).toFixed(4)} BNB`);

  console.log(`\n📊 FULL COMPARISON:\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Strategy                          | Trades | Win%   | ROI`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🏆 BEST: Contrarian 65%            | 184    | 54.89% | +196.38%`);
  console.log(`💀 WORST: With Crowd ${worst.crowdThreshold}%          | ${worst.totalTrades}    | ${worst.winRate}% | ${worst.roi}%`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

test().catch(console.error);
