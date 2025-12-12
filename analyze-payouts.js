import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

async function analyzePayouts() {
  const db = initDatabase(DB_PATH);
  const rounds = db.prepare(`
    SELECT * FROM rounds
    WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND close_price IS NOT NULL
    ORDER BY sample_id ASC
  `).all();
  db.close();

  console.log(`\n📊 PAYOUT ANALYSIS FOR CONTRARIAN STRATEGY\n`);
  console.log(`Analyzing ${rounds.length} rounds with T-20s data\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // Analyze different crowd thresholds
  const thresholds = [60, 65, 70];

  for (const crowdThreshold of thresholds) {
    let payouts = [];
    let tradeCount = 0;

    for (const round of rounds) {
      const t20sBullWei = BigInt(round.t20s_bull_wei || '0');
      const t20sBearWei = BigInt(round.t20s_bear_wei || '0');
      const t20sTotalWei = t20sBullWei + t20sBearWei;

      if (t20sTotalWei === 0n) continue;

      const bullPercent = Number(t20sBullWei * 10000n / t20sTotalWei) / 100;
      const bearPercent = Number(t20sBearWei * 10000n / t20sTotalWei) / 100;

      // Contrarian: bet against crowd
      let betSide = null;
      if (bullPercent >= crowdThreshold) {
        betSide = 'BEAR';
      } else if (bearPercent >= crowdThreshold) {
        betSide = 'BULL';
      } else {
        continue;
      }

      tradeCount++;

      // Calculate what payout we GET when we win
      const ourPayout = round.winner_payout_multiple;
      payouts.push(ourPayout);
    }

    if (payouts.length === 0) continue;

    // Calculate statistics
    payouts.sort((a, b) => a - b);
    const avgPayout = payouts.reduce((a, b) => a + b, 0) / payouts.length;
    const minPayout = payouts[0];
    const maxPayout = payouts[payouts.length - 1];
    const medianPayout = payouts[Math.floor(payouts.length / 2)];

    // Count payouts by range
    const below150 = payouts.filter(p => p < 1.50).length;
    const between150_185 = payouts.filter(p => p >= 1.50 && p < 1.85).length;
    const between185_220 = payouts.filter(p => p >= 1.85 && p < 2.20).length;
    const above220 = payouts.filter(p => p >= 2.20).length;

    console.log(`Crowd Threshold: ${crowdThreshold}% (${tradeCount} trades)\n`);
    console.log(`  Average Payout:    ${avgPayout.toFixed(2)}x`);
    console.log(`  Median Payout:     ${medianPayout.toFixed(2)}x`);
    console.log(`  Min Payout:        ${minPayout.toFixed(2)}x`);
    console.log(`  Max Payout:        ${maxPayout.toFixed(2)}x`);
    console.log(`\n  Payout Distribution:`);
    console.log(`    < 1.50x:         ${below150} trades (${(below150/tradeCount*100).toFixed(1)}%)`);
    console.log(`    1.50x - 1.85x:   ${between150_185} trades (${(between150_185/tradeCount*100).toFixed(1)}%)`);
    console.log(`    1.85x - 2.20x:   ${between185_220} trades (${(between185_220/tradeCount*100).toFixed(1)}%)`);
    console.log(`    > 2.20x:         ${above220} trades (${(above220/tradeCount*100).toFixed(1)}%)`);
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  }

  // Now analyze what 65% crowd typically means in pool split
  console.log(`\n💡 UNDERSTANDING CROWD % → PAYOUT RELATIONSHIP:\n`);
  console.log(`When betting CONTRARIAN (against majority):\n`);
  console.log(`Crowd %  | Your Side % | Theoretical Payout`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`60%      | 40%         | ~2.50x`);
  console.log(`65%      | 35%         | ~2.86x`);
  console.log(`70%      | 30%         | ~3.33x`);
  console.log(`75%      | 25%         | ~4.00x`);
  console.log(`80%      | 20%         | ~5.00x`);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`Note: Actual payouts are lower due to 3% house fee\n`);
}

analyzePayouts().catch(console.error);
