import { initDatabase, getCompleteRounds, getSampleCount } from './db-init.js';
import { ethers } from 'ethers';

/**
 * Display database statistics and recent rounds
 */

function displayStats() {
  console.log('📊 Database Statistics\n');
  console.log('━'.repeat(60) + '\n');

  const db = initDatabase('./prediction.db');

  // Total samples
  const totalSamples = getSampleCount(db);
  console.log(`Total Samples: ${totalSamples}`);

  // Complete rounds
  const completeRounds = getCompleteRounds(db);
  console.log(`Complete Rounds: ${completeRounds.length}`);

  // Incomplete rounds
  const incompleteQuery = db.prepare('SELECT COUNT(*) as count FROM rounds WHERE is_complete = 0');
  const incomplete = incompleteQuery.get().count;
  console.log(`Incomplete Rounds: ${incomplete}`);

  // Rounds with T-20s data
  const t20sQuery = db.prepare('SELECT COUNT(*) as count FROM rounds WHERE t20s_bull_wei IS NOT NULL');
  const withT20s = t20sQuery.get().count;
  console.log(`Rounds with T-20s Data: ${withT20s}`);

  console.log('\n' + '━'.repeat(60));

  // Recent rounds
  if (completeRounds.length > 0) {
    console.log('\n📈 Last 5 Complete Rounds:\n');

    const recent = completeRounds.slice(-5);

    for (const round of recent) {
      const lockDate = new Date(round.lock_timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19);
      const lockPrice = round.lock_price ? `$${(Number(round.lock_price) / 1e8).toFixed(2)}` : 'N/A';
      const closePrice = round.close_price ? `$${(Number(round.close_price) / 1e8).toFixed(2)}` : 'N/A';

      console.log(`Sample #${round.sample_id} - Epoch ${round.epoch}`);
      console.log(`   Time: ${lockDate}`);
      console.log(`   Price: ${lockPrice} → ${closePrice}`);
      console.log(`   Winner: ${round.winner ? round.winner.toUpperCase() : 'N/A'}`);

      if (round.winner_payout_multiple) {
        console.log(`   Payout: ${round.winner_payout_multiple.toFixed(4)}x`);
      }

      // Calculate crowd sentiment at T-20s
      if (round.t20s_bull_wei && round.t20s_bear_wei) {
        const bullWei = BigInt(round.t20s_bull_wei);
        const bearWei = BigInt(round.t20s_bear_wei);
        const total = bullWei + bearWei;

        if (total > 0n) {
          const bullPct = Number((bullWei * 10000n) / total) / 100;
          const bearPct = Number((bearWei * 10000n) / total) / 100;
          const totalBNB = ethers.formatEther(total.toString());

          console.log(`   T-20s: Bull ${bullPct.toFixed(2)}% | Bear ${bearPct.toFixed(2)}% | ${parseFloat(totalBNB).toFixed(2)} BNB`);
        }
      }

      console.log('');
    }
  }

  console.log('━'.repeat(60) + '\n');

  // Win rate stats
  if (completeRounds.length > 0) {
    const bulls = completeRounds.filter(r => r.winner === 'bull').length;
    const bears = completeRounds.filter(r => r.winner === 'bear').length;
    const draws = completeRounds.filter(r => r.winner === 'draw').length;

    console.log('🎲 Win Distribution:\n');
    console.log(`   Bull Wins: ${bulls} (${(bulls / completeRounds.length * 100).toFixed(1)}%)`);
    console.log(`   Bear Wins: ${bears} (${(bears / completeRounds.length * 100).toFixed(1)}%)`);
    console.log(`   Draws: ${draws} (${(draws / completeRounds.length * 100).toFixed(1)}%)`);

    // Average payout
    const avgPayout = completeRounds.reduce((sum, r) => sum + (r.winner_payout_multiple || 0), 0) / completeRounds.length;
    console.log(`\n   Average Payout: ${avgPayout.toFixed(4)}x`);

    console.log('\n' + '━'.repeat(60) + '\n');
  }

  db.close();
}

displayStats();
