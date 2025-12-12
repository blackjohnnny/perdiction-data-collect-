import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

// EVEN WORSE - bet WITH crowd AND filter for LOW payouts (worst combo)
function runEvenWorseTest(rounds, crowdThreshold, maxPayout) {
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

    // WORST: bet WITH the crowd (terrible payouts)
    let betSide = null;
    if (bullPercent >= crowdThreshold) {
      betSide = 'BULL'; // WITH crowd
    } else if (bearPercent >= crowdThreshold) {
      betSide = 'BEAR'; // WITH crowd
    } else {
      skipped++;
      continue;
    }

    // FILTER for LOW payouts only (worst odds)
    if (round.winner_payout_multiple > maxPayout) {
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
    maxPayout,
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

  console.log(`\n💩💩💩 EVEN WORSE STRATEGY - Bet WITH Crowd + Filter for LOW Payouts\n`);
  console.log(`Goal: Absolute LOWEST win rate possible\n`);
  console.log(`Testing on ${rounds.length} rounds\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const results = [];
  const crowdThresholds = [50, 55, 60];
  const maxPayouts = [1.50, 1.60, 1.70]; // Only bet when payouts are TERRIBLE

  for (const crowdThreshold of crowdThresholds) {
    for (const maxPayout of maxPayouts) {
      const result = runEvenWorseTest(rounds, crowdThreshold, maxPayout);
      if (result.totalTrades > 0) {
        results.push(result);
      }
    }
  }

  // Sort by WORST win rate (lowest)
  results.sort((a, b) => parseFloat(a.winRate) - parseFloat(b.winRate));

  console.log(`Crowd% | MaxPay | Trades | Wins | Losses | Win%   | ROI         | Final Balance | Trade%`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  results.forEach(r => {
    const tradePercent = ((r.totalTrades / rounds.length) * 100).toFixed(1);
    console.log(`${r.crowdThreshold}%    | ${r.maxPayout.toFixed(2)}x  | ${r.totalTrades.toString().padEnd(6)} | ${r.wins.toString().padEnd(4)} | ${r.losses.toString().padEnd(6)} | ${r.winRate.padStart(6)}% | ${r.roi.padStart(11)}% | ${r.finalBalance} BNB | ${tradePercent}%`);
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (results.length > 0) {
    console.log(`\n☠️  ABSOLUTE WORST Win Rate:\n`);
    const worstWinRate = results[0];
    console.log(`Strategy: Bet WITH crowd ${worstWinRate.crowdThreshold}%, only when payout < ${worstWinRate.maxPayout}x`);
    console.log(`Total Trades: ${worstWinRate.totalTrades} (${((worstWinRate.totalTrades/rounds.length)*100).toFixed(1)}% of rounds)`);
    console.log(`Win Rate: ${worstWinRate.winRate}% ☠️  (LOWEST POSSIBLE!)`);
    console.log(`ROI: ${worstWinRate.roi}%`);
    console.log(`Final Balance: ${worstWinRate.finalBalance} BNB`);

    // Find worst ROI
    const worstROI = results.sort((a, b) => parseFloat(a.roi) - parseFloat(b.roi))[0];

    console.log(`\n☠️  ABSOLUTE WORST ROI:\n`);
    console.log(`Strategy: Bet WITH crowd ${worstROI.crowdThreshold}%, only when payout < ${worstROI.maxPayout}x`);
    console.log(`Total Trades: ${worstROI.totalTrades}`);
    console.log(`Win Rate: ${worstROI.winRate}%`);
    console.log(`ROI: ${worstROI.roi}% ☠️  (BIGGEST LOSS!)`);
    console.log(`Final Balance: ${worstROI.finalBalance} BNB`);
    console.log(`Money Lost: ${(1 - parseFloat(worstROI.finalBalance)).toFixed(4)} BNB (${(100 - parseFloat(worstROI.finalBalance) * 100).toFixed(1)}% destroyed!)`);
  }

  console.log(`\n📊 ULTIMATE COMPARISON:\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Strategy                                    | Trades | Win%   | ROI`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🏆 BEST: Contrarian 65%                      | 184    | 54.89% | +196.38%`);
  console.log(`💀 Bad: With Crowd 52%                       | 248    | 48.79% |  -80.99%`);
  if (results.length > 0) {
    const worst = results.sort((a, b) => parseFloat(a.winRate) - parseFloat(b.winRate))[0];
    console.log(`☠️  WORST: With Crowd ${worst.crowdThreshold}% + Payout<${worst.maxPayout}x | ${worst.totalTrades.toString().padEnd(6)} | ${worst.winRate}% | ${worst.roi.padStart(8)}%`);
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

test().catch(console.error);
