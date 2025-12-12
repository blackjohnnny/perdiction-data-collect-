import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

// REVERSE of WORST - bet AGAINST crowd on HIGH payout rounds (coin flips)
function runReverseWorstTest(rounds, crowdThreshold, minPayout) {
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

    // REVERSE: Bet AGAINST the crowd (contrarian)
    let betSide = null;
    if (bullPercent >= crowdThreshold) {
      betSide = 'BEAR'; // AGAINST crowd (contrarian)
    } else if (bearPercent >= crowdThreshold) {
      betSide = 'BULL'; // AGAINST crowd (contrarian)
    } else {
      skipped++;
      continue;
    }

    // FILTER for HIGH payouts (close to 50/50 = better odds on minority side)
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

  console.log(`\n🔄 REVERSE THE WORST STRATEGY - Bet AGAINST Crowd on HIGH Payout Rounds\n`);
  console.log(`Theory: If worst strategy loses with 39% win rate, reverse should win!\n`);
  console.log(`Testing on ${rounds.length} rounds\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const results = [];
  const crowdThresholds = [50, 52, 55];
  const minPayouts = [1.80, 1.90, 2.00];

  for (const crowdThreshold of crowdThresholds) {
    for (const minPayout of minPayouts) {
      const result = runReverseWorstTest(rounds, crowdThreshold, minPayout);
      if (result.totalTrades > 10) {
        results.push(result);
      }
    }
  }

  // Sort by BEST ROI
  results.sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi));

  console.log(`Crowd% | MinPay | Trades | Wins | Losses | Win%   | ROI         | Final Balance | Trade%`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  results.forEach(r => {
    const tradePercent = ((r.totalTrades / rounds.length) * 100).toFixed(1);
    console.log(`${r.crowdThreshold}%    | ${r.minPayout.toFixed(2)}x  | ${r.totalTrades.toString().padEnd(6)} | ${r.wins.toString().padEnd(4)} | ${r.losses.toString().padEnd(6)} | ${r.winRate.padStart(6)}% | ${r.roi.padStart(11)}% | ${r.finalBalance} BNB | ${tradePercent}%`);
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (results.length > 0) {
    console.log(`\n🏆 BEST REVERSE-WORST STRATEGY:\n`);
    const best = results[0];
    console.log(`Strategy: Bet AGAINST crowd ${best.crowdThreshold}%, only when payout > ${best.minPayout}x`);
    console.log(`Total Trades: ${best.totalTrades} (${((best.totalTrades/rounds.length)*100).toFixed(1)}% of rounds)`);
    console.log(`Win Rate: ${best.winRate}%`);
    console.log(`ROI: ${best.roi}% 🚀`);
    console.log(`Final Balance: ${best.finalBalance} BNB`);
    console.log(`Profit: ${(parseFloat(best.finalBalance) - 1).toFixed(4)} BNB`);

    // Find best win rate
    const bestWinRate = results.sort((a, b) => parseFloat(b.winRate) - parseFloat(a.winRate))[0];
    console.log(`\n🎯 HIGHEST WIN RATE:\n`);
    console.log(`Strategy: Bet AGAINST crowd ${bestWinRate.crowdThreshold}%, payout > ${bestWinRate.minPayout}x`);
    console.log(`Win Rate: ${bestWinRate.winRate}% (${bestWinRate.wins} wins / ${bestWinRate.totalTrades} trades)`);
    console.log(`ROI: ${bestWinRate.roi}%`);
  }

  console.log(`\n📊 FULL COMPARISON:\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Strategy                                             | Trades | Win%   | ROI`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🏆 Contrarian 65% (all rounds)                        | 184    | 54.89% | +196.38%`);
  if (results.length > 0) {
    const best = results.sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi))[0];
    console.log(`🔥 Contrarian ${best.crowdThreshold}% (high payout only > ${best.minPayout}x)  | ${best.totalTrades.toString().padEnd(6)} | ${best.winRate}% | ${best.roi.padStart(8)}%`);
  }
  console.log(`☠️  WITH Crowd 55% (high payout > 2x)                 | 97     | 39.18% |  -73.90%`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

test().catch(console.error);
