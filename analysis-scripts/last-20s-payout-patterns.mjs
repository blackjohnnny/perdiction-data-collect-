import initSqlJs from 'sql.js';
import fs from 'fs';

console.log('=== LAST 20 SECONDS PAYOUT PATTERN ANALYSIS ===\n');
console.log('Detecting arbitrage snipers, bots, and manipulation patterns\n');

const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync('prediction-data.db'));

// Get all snapshots with their T-20s data and final round data
const data = db.exec(`
  SELECT
    s.epoch,
    s.bull_amount_wei as snap_bull,
    s.bear_amount_wei as snap_bear,
    s.total_amount_wei as snap_total,
    s.implied_up_multiple as snap_implied_up,
    s.implied_down_multiple as snap_implied_down,
    r.bull_amount_wei as final_bull,
    r.bear_amount_wei as final_bear,
    r.total_amount_wei as final_total,
    r.winner,
    r.winner_multiple as final_payout
  FROM snapshots s
  JOIN rounds r ON s.epoch = r.epoch
  WHERE r.winner IN ('UP', 'DOWN')
  ORDER BY s.epoch ASC
`);

const rounds = data[0].values.map(row => ({
  epoch: row[0],
  snapBull: BigInt(row[1]),
  snapBear: BigInt(row[2]),
  snapTotal: BigInt(row[3]),
  snapImpliedUp: row[4],
  snapImpliedDown: row[5],
  finalBull: BigInt(row[6]),
  finalBear: BigInt(row[7]),
  finalTotal: BigInt(row[8]),
  winner: row[9],
  finalPayout: row[10]
}));

console.log(`Analyzing ${rounds.length} rounds\n`);
console.log('='.repeat(80));

// Analyze payout changes
const patterns = {
  favoriteGetsStronger: { count: 0, rounds: [], description: 'Lower payout gets even lower (more money piles on favorite)' },
  favoriteGetsWeaker: { count: 0, rounds: [], description: 'Lower payout increases (money shifts away from favorite)' },
  underdogGetsStronger: { count: 0, rounds: [], description: 'Higher payout decreases (money comes to underdog)' },
  crowdFlip: { count: 0, rounds: [], description: 'Complete flip - underdog becomes favorite' },
  balanced: { count: 0, rounds: [], description: 'Both sides get equal money (stays balanced)' },
  massiveBet: { count: 0, rounds: [], description: 'Last-second bet >50% of final pool' }
};

const payoutChanges = [];

for (const round of rounds) {
  const snapBullPct = Number((round.snapBull * 10000n) / round.snapTotal) / 100;
  const snapBearPct = 100 - snapBullPct;

  const finalBullPct = Number((round.finalBull * 10000n) / round.finalTotal) / 100;
  const finalBearPct = 100 - finalBullPct;

  // Calculate final implied payouts
  const finalImpliedUp = round.finalBull > 0n
    ? Number((round.finalTotal * 97n * 1000n) / (round.finalBull * 100n)) / 1000
    : 999;
  const finalImpliedDown = round.finalBear > 0n
    ? Number((round.finalTotal * 97n * 1000n) / (round.finalBear * 100n)) / 1000
    : 999;

  // Determine favorite at T-20s
  const snapFavorite = round.snapImpliedUp < round.snapImpliedDown ? 'UP' : 'DOWN';
  const snapFavoritePayout = Math.min(round.snapImpliedUp, round.snapImpliedDown);
  const snapUnderdogPayout = Math.max(round.snapImpliedUp, round.snapImpliedDown);

  // Determine favorite at final
  const finalFavorite = finalImpliedUp < finalImpliedDown ? 'UP' : 'DOWN';
  const finalFavoritePayout = Math.min(finalImpliedUp, finalImpliedDown);
  const finalUnderdogPayout = Math.max(finalImpliedUp, finalImpliedDown);

  // Calculate changes
  const lastSecondBull = round.finalBull - round.snapBull;
  const lastSecondBear = round.finalBear - round.snapBear;
  const lastSecondTotal = round.finalTotal - round.snapTotal;
  const lastSecondBNB = Number(lastSecondTotal) / 1e18;
  const lastSecondPct = Number((lastSecondTotal * 10000n) / round.finalTotal) / 100;

  const payoutChange = finalFavoritePayout - snapFavoritePayout;
  const payoutChangePct = ((finalFavoritePayout - snapFavoritePayout) / snapFavoritePayout) * 100;

  const poolShift = Math.abs(finalBullPct - snapBullPct);

  // Detect which side got the last-second money
  const lastSecondBullPct = lastSecondTotal > 0n
    ? Number((lastSecondBull * 10000n) / lastSecondTotal) / 100
    : 0;

  payoutChanges.push({
    epoch: round.epoch,
    snapFavorite,
    finalFavorite,
    snapFavoritePayout,
    finalFavoritePayout,
    payoutChange,
    payoutChangePct,
    lastSecondBNB,
    lastSecondPct,
    lastSecondBullPct,
    poolShift,
    winner: round.winner,
    flipped: snapFavorite !== finalFavorite
  });

  // Categorize pattern
  if (snapFavorite !== finalFavorite) {
    patterns.crowdFlip.count++;
    patterns.crowdFlip.rounds.push(round.epoch);
  } else if (finalFavoritePayout < snapFavoritePayout) {
    // Favorite got stronger (payout decreased)
    patterns.favoriteGetsStronger.count++;
    patterns.favoriteGetsStronger.rounds.push(round.epoch);
  } else if (finalFavoritePayout > snapFavoritePayout) {
    // Favorite got weaker (payout increased)
    patterns.favoriteGetsWeaker.count++;
    patterns.favoriteGetsWeaker.rounds.push(round.epoch);
  } else {
    patterns.balanced.count++;
    patterns.balanced.rounds.push(round.epoch);
  }

  if (lastSecondPct > 50) {
    patterns.massiveBet.count++;
    patterns.massiveBet.rounds.push(round.epoch);
  }
}

console.log('\nPATTERN DISTRIBUTION:\n');

const patternResults = Object.entries(patterns)
  .filter(([key, p]) => p.count > 0)
  .sort((a, b) => b[1].count - a[1].count);

patternResults.forEach(([key, pattern]) => {
  const pct = (pattern.count * 100 / rounds.length).toFixed(1);
  console.log(`${pattern.description}`);
  console.log(`  Count: ${pattern.count}/${rounds.length} (${pct}%)`);
  console.log('');
});

console.log('='.repeat(80));
console.log('\nPAYOUT CHANGE ANALYSIS:\n');

// Analyze payout changes
const avgPayoutChange = payoutChanges.reduce((sum, p) => sum + p.payoutChange, 0) / payoutChanges.length;
const avgPayoutChangePct = payoutChanges.reduce((sum, p) => sum + p.payoutChangePct, 0) / payoutChanges.length;
const avgLastSecondBNB = payoutChanges.reduce((sum, p) => sum + p.lastSecondBNB, 0) / payoutChanges.length;
const avgLastSecondPct = payoutChanges.reduce((sum, p) => sum + p.lastSecondPct, 0) / payoutChanges.length;

console.log(`Average payout change: ${avgPayoutChange > 0 ? '+' : ''}${avgPayoutChange.toFixed(3)}x (${avgPayoutChangePct > 0 ? '+' : ''}${avgPayoutChangePct.toFixed(1)}%)`);
console.log(`Average last-second bet: ${avgLastSecondBNB.toFixed(2)} BNB (${avgLastSecondPct.toFixed(1)}% of final pool)`);

console.log('\n' + '='.repeat(80));
console.log('\nSNIPER/BOT DETECTION:\n');

// Detect suspicious patterns
console.log('1. MASSIVE LAST-SECOND BETS (>50% of final pool):');
console.log(`   Count: ${patterns.massiveBet.count} rounds\n`);

if (patterns.massiveBet.count > 0) {
  const massiveBets = payoutChanges
    .filter(p => p.lastSecondPct > 50)
    .sort((a, b) => b.lastSecondPct - a.lastSecondPct)
    .slice(0, 10);

  console.log('   Top 10 biggest snipers:\n');
  console.log('   Epoch   | BNB   | % Pool | Sniper Bet | Favorite | Result');
  console.log('   --------|-------|--------|------------|----------|--------');

  massiveBets.forEach(m => {
    const sniperBet = m.lastSecondBullPct > 60 ? 'UP' : (m.lastSecondBullPct < 40 ? 'DOWN' : 'BOTH');
    const favoriteWon = m.winner === m.finalFavorite ? 'WIN' : 'LOSS';
    console.log(`   ${m.epoch} | ${m.lastSecondBNB.toFixed(2).padStart(5)} | ${m.lastSecondPct.toFixed(1).padStart(5)}% | ${sniperBet.padEnd(10)} | ${m.finalFavorite.padEnd(8)} | ${favoriteWon}`);
  });
}

console.log('\n2. CROWD FLIPS (underdog becomes favorite):');
console.log(`   Count: ${patterns.crowdFlip.count} rounds (${(patterns.crowdFlip.count*100/rounds.length).toFixed(1)}%)\n`);

if (patterns.crowdFlip.count > 0) {
  const flips = payoutChanges
    .filter(p => p.flipped)
    .sort((a, b) => b.poolShift - a.poolShift)
    .slice(0, 10);

  console.log('   Top 10 biggest flips:\n');
  console.log('   Epoch   | Pool Shift | T20→Final | Last-Sec | Winner');
  console.log('   --------|------------|-----------|----------|--------');

  flips.forEach(f => {
    const flip = `${f.snapFavorite}→${f.finalFavorite}`;
    console.log(`   ${f.epoch} | ${f.poolShift.toFixed(1).padStart(9)}% | ${flip.padEnd(9)} | ${f.lastSecondBNB.toFixed(2).padStart(8)} | ${f.winner.padEnd(6)}`);
  });
}

console.log('\n3. STRATEGIC PATTERNS:\n');

// Analyze if snipers target specific situations
const sniperWhenFavoriteWins = payoutChanges.filter(p => p.lastSecondPct > 50 && p.winner === p.finalFavorite).length;
const sniperWhenUnderdogWins = payoutChanges.filter(p => p.lastSecondPct > 50 && p.winner !== p.finalFavorite).length;

console.log(`   Massive bets when favorite wins: ${sniperWhenFavoriteWins}/${patterns.massiveBet.count} (${(sniperWhenFavoriteWins*100/patterns.massiveBet.count).toFixed(1)}%)`);
console.log(`   Massive bets when underdog wins: ${sniperWhenUnderdogWins}/${patterns.massiveBet.count} (${(sniperWhenUnderdogWins*100/patterns.massiveBet.count).toFixed(1)}%)\n`);

// Analyze betting direction
const sniperOnFavorite = payoutChanges.filter(p =>
  p.lastSecondPct > 50 &&
  ((p.finalFavorite === 'UP' && p.lastSecondBullPct > 60) ||
   (p.finalFavorite === 'DOWN' && p.lastSecondBullPct < 40))
).length;

const sniperOnUnderdog = payoutChanges.filter(p =>
  p.lastSecondPct > 50 &&
  ((p.finalFavorite === 'UP' && p.lastSecondBullPct < 40) ||
   (p.finalFavorite === 'DOWN' && p.lastSecondBullPct > 60))
).length;

console.log(`   Snipers betting ON favorite: ${sniperOnFavorite}/${patterns.massiveBet.count}`);
console.log(`   Snipers betting ON underdog: ${sniperOnUnderdog}/${patterns.massiveBet.count}`);

console.log('\n' + '='.repeat(80));
console.log('\nARBITRAGE BOT CONCLUSIONS:\n');

console.log(`1. Last-second activity is COMMON:`);
console.log(`   - Average: ${avgLastSecondBNB.toFixed(2)} BNB enters in final 20 seconds`);
console.log(`   - This is ${avgLastSecondPct.toFixed(1)}% of the final pool!`);
console.log(`   - ${patterns.massiveBet.count} rounds (${(patterns.massiveBet.count*100/rounds.length).toFixed(1)}%) had >50% of pool enter in last 20s\n`);

console.log(`2. Crowd flips happen frequently:`);
console.log(`   - ${patterns.crowdFlip.count} rounds (${(patterns.crowdFlip.count*100/rounds.length).toFixed(1)}%) completely flipped`);
console.log(`   - This makes T-20s data unreliable for ${(patterns.crowdFlip.count*100/rounds.length).toFixed(1)}% of bets\n`);

console.log(`3. Sniper behavior:`);
if (sniperOnFavorite > sniperOnUnderdog * 1.5) {
  console.log(`   - Snipers mostly bet WITH the crowd (${sniperOnFavorite} vs ${sniperOnUnderdog})`);
  console.log(`   - They are AMPLIFYING the favorite, not arbitraging`);
} else if (sniperOnUnderdog > sniperOnFavorite * 1.5) {
  console.log(`   - Snipers mostly bet AGAINST the crowd (${sniperOnUnderdog} vs ${sniperOnFavorite})`);
  console.log(`   - They are CONTRARIAN arbitrage bots`);
} else {
  console.log(`   - Snipers bet on both sides equally (${sniperOnFavorite} vs ${sniperOnUnderdog})`);
  console.log(`   - No clear directional bias`);
}

console.log('\n' + '='.repeat(80));
console.log('\nRECOMMENDATIONS:\n');

console.log(`1. ${patterns.favoriteGetsStronger.count > patterns.favoriteGetsWeaker.count ? '✓' : '✗'} Favorite usually gets STRONGER in last 20s`);
console.log(`   (${patterns.favoriteGetsStronger.count} vs ${patterns.favoriteGetsWeaker.count} rounds)\n`);

console.log(`2. ${patterns.crowdFlip.count < rounds.length * 0.3 ? '✓' : '✗'} T-20s is relatively reliable`);
console.log(`   Only ${(patterns.crowdFlip.count*100/rounds.length).toFixed(1)}% flip completely\n`);

console.log(`3. For your strategy:`);
if (patterns.favoriteGetsStronger.count > patterns.favoriteGetsWeaker.count) {
  console.log(`   ✓ Betting at T-20s on favorite is GOOD`);
  console.log(`   ✓ Last-second bets will likely strengthen your position`);
} else {
  console.log(`   ⚠ Betting at T-20s on favorite is RISKY`);
  console.log(`   ⚠ Last-second bets may weaken your position`);
}

console.log(`\n4. Watch out for rounds with >70% pool at T-20s:`);
const strongFavoriteFlips = payoutChanges.filter(p =>
  p.flipped &&
  (p.snapFavoritePayout < 1.39)
).length;
console.log(`   Only ${strongFavoriteFlips} out of ${patterns.crowdFlip.count} flips had strong favorite (>70%)`);
console.log(`   Strong favorites rarely flip! (${(strongFavoriteFlips*100/rounds.length).toFixed(1)}%)`);

db.close();
