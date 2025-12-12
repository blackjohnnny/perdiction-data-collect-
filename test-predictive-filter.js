import Database from 'better-sqlite3';

const db = new Database('./prediction.db');

const rounds = db.prepare(`
  SELECT epoch, lock_timestamp, lock_price, close_price, winner, winner_payout_multiple,
         ema_signal, ema_gap, lock_bull_wei, lock_bear_wei, lock_total_wei
  FROM rounds
  WHERE is_complete = 1
    AND lock_price > 0
    AND close_price > 0
    AND ema_signal IS NOT NULL
  ORDER BY epoch
`).all();

console.log('🧠 PREDICTIVE FILTER: Avoid Trades During High-Risk Times\n');
console.log('═'.repeat(70));

// STRATEGY 1: Baseline (no filter)
function testBaseline() {
  let bankroll = 100;
  let wins = 0, losses = 0, skipped = 0;

  rounds.forEach((r) => {
    if (!r.ema_signal || r.ema_signal === 'NEUTRAL') {
      skipped++;
      return;
    }

    const bullWei = BigInt(r.lock_bull_wei);
    const bearWei = BigInt(r.lock_bear_wei);
    const totalWei = BigInt(r.lock_total_wei);

    const bullPayout = totalWei > 0n ? Number(totalWei * 10000n / bullWei) / 10000 : 0;
    const bearPayout = totalWei > 0n ? Number(totalWei * 10000n / bearWei) / 10000 : 0;

    let signal = null;
    if (r.ema_signal === 'BULL') {
      if (bullPayout > bearPayout && bullPayout >= 1.55) signal = 'BULL';
    } else if (r.ema_signal === 'BEAR') {
      if (bearPayout > bullPayout && bearPayout >= 1.55) signal = 'BEAR';
    }

    if (!signal) {
      skipped++;
      return;
    }

    const betSize = bankroll * 0.045;
    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = r.winner.toUpperCase() === signal;

    if (won) {
      bankroll += betSize * (actualPayout - 1);
      wins++;
    } else {
      bankroll -= betSize;
      losses++;
    }
  });

  return { bankroll, wins, losses, skipped, trades: wins + losses };
}

// STRATEGY 2: Avoid HIGH-RISK hours (15-23 UTC, especially Monday/Friday)
function testTimeFilter() {
  let bankroll = 100;
  let wins = 0, losses = 0, skipped = 0;
  let timeFiltered = 0;

  rounds.forEach((r) => {
    if (!r.ema_signal || r.ema_signal === 'NEUTRAL') {
      skipped++;
      return;
    }

    const date = new Date(r.lock_timestamp * 1000);
    const hour = date.getUTCHours();
    const dayOfWeek = date.getUTCDay();

    // HIGH-RISK FILTER: Avoid 15-23 UTC on Monday (1) and Friday (5)
    if ((dayOfWeek === 1 || dayOfWeek === 5) && (hour >= 15 && hour <= 23)) {
      timeFiltered++;
      skipped++;
      return;
    }

    const bullWei = BigInt(r.lock_bull_wei);
    const bearWei = BigInt(r.lock_bear_wei);
    const totalWei = BigInt(r.lock_total_wei);

    const bullPayout = totalWei > 0n ? Number(totalWei * 10000n / bullWei) / 10000 : 0;
    const bearPayout = totalWei > 0n ? Number(totalWei * 10000n / bearWei) / 10000 : 0;

    let signal = null;
    if (r.ema_signal === 'BULL') {
      if (bullPayout > bearPayout && bullPayout >= 1.55) signal = 'BULL';
    } else if (r.ema_signal === 'BEAR') {
      if (bearPayout > bullPayout && bearPayout >= 1.55) signal = 'BEAR';
    }

    if (!signal) {
      skipped++;
      return;
    }

    const betSize = bankroll * 0.045;
    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = r.winner.toUpperCase() === signal;

    if (won) {
      bankroll += betSize * (actualPayout - 1);
      wins++;
    } else {
      bankroll -= betSize;
      losses++;
    }
  });

  return { bankroll, wins, losses, skipped, trades: wins + losses, timeFiltered };
}

// STRATEGY 3: Avoid trades after 2 consecutive losses
function testLossStreakFilter() {
  let bankroll = 100;
  let wins = 0, losses = 0, skipped = 0;
  let consecLosses = 0;
  let streakFiltered = 0;

  rounds.forEach((r) => {
    if (!r.ema_signal || r.ema_signal === 'NEUTRAL') {
      skipped++;
      return;
    }

    // LOSS STREAK FILTER: Skip if we just had 2 consecutive losses
    if (consecLosses >= 2) {
      streakFiltered++;
      skipped++;
      consecLosses = 0; // Reset after skipping
      return;
    }

    const bullWei = BigInt(r.lock_bull_wei);
    const bearWei = BigInt(r.lock_bear_wei);
    const totalWei = BigInt(r.lock_total_wei);

    const bullPayout = totalWei > 0n ? Number(totalWei * 10000n / bullWei) / 10000 : 0;
    const bearPayout = totalWei > 0n ? Number(totalWei * 10000n / bearWei) / 10000 : 0;

    let signal = null;
    if (r.ema_signal === 'BULL') {
      if (bullPayout > bearPayout && bullPayout >= 1.55) signal = 'BULL';
    } else if (r.ema_signal === 'BEAR') {
      if (bearPayout > bullPayout && bearPayout >= 1.55) signal = 'BEAR';
    }

    if (!signal) {
      skipped++;
      return;
    }

    const betSize = bankroll * 0.045;
    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = r.winner.toUpperCase() === signal;

    if (won) {
      bankroll += betSize * (actualPayout - 1);
      wins++;
      consecLosses = 0;
    } else {
      bankroll -= betSize;
      losses++;
      consecLosses++;
    }
  });

  return { bankroll, wins, losses, skipped, trades: wins + losses, streakFiltered };
}

// STRATEGY 4: Combined filters
function testCombinedFilter() {
  let bankroll = 100;
  let wins = 0, losses = 0, skipped = 0;
  let consecLosses = 0;
  let timeFiltered = 0, streakFiltered = 0;

  rounds.forEach((r) => {
    if (!r.ema_signal || r.ema_signal === 'NEUTRAL') {
      skipped++;
      return;
    }

    const date = new Date(r.lock_timestamp * 1000);
    const hour = date.getUTCHours();
    const dayOfWeek = date.getUTCDay();

    // Time filter
    if ((dayOfWeek === 1 || dayOfWeek === 5) && (hour >= 15 && hour <= 23)) {
      timeFiltered++;
      skipped++;
      return;
    }

    // Loss streak filter
    if (consecLosses >= 2) {
      streakFiltered++;
      skipped++;
      consecLosses = 0;
      return;
    }

    const bullWei = BigInt(r.lock_bull_wei);
    const bearWei = BigInt(r.lock_bear_wei);
    const totalWei = BigInt(r.lock_total_wei);

    const bullPayout = totalWei > 0n ? Number(totalWei * 10000n / bullWei) / 10000 : 0;
    const bearPayout = totalWei > 0n ? Number(totalWei * 10000n / bearWei) / 10000 : 0;

    let signal = null;
    if (r.ema_signal === 'BULL') {
      if (bullPayout > bearPayout && bullPayout >= 1.55) signal = 'BULL';
    } else if (r.ema_signal === 'BEAR') {
      if (bearPayout > bullPayout && bearPayout >= 1.55) signal = 'BEAR';
    }

    if (!signal) {
      skipped++;
      return;
    }

    const betSize = bankroll * 0.045;
    const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
    const won = r.winner.toUpperCase() === signal;

    if (won) {
      bankroll += betSize * (actualPayout - 1);
      wins++;
      consecLosses = 0;
    } else {
      bankroll -= betSize;
      losses++;
      consecLosses++;
    }
  });

  return { bankroll, wins, losses, skipped, trades: wins + losses, timeFiltered, streakFiltered };
}

console.log('\n📊 TESTING PREDICTIVE FILTERS:\n');

const baseline = testBaseline();
console.log('1️⃣ BASELINE (No Filter):');
console.log(`   Trades: ${baseline.trades}`);
console.log(`   Win Rate: ${(baseline.wins / baseline.trades * 100).toFixed(1)}%`);
console.log(`   Final: ${baseline.bankroll.toFixed(2)} BNB`);
console.log(`   Profit: ${(baseline.bankroll - 100).toFixed(2)} BNB\n`);

const timeFilter = testTimeFilter();
console.log('2️⃣ TIME FILTER (Avoid Mon/Fri 15-23 UTC):');
console.log(`   Trades: ${timeFilter.trades} (filtered ${timeFilter.timeFiltered} by time)`);
console.log(`   Win Rate: ${(timeFilter.wins / timeFilter.trades * 100).toFixed(1)}%`);
console.log(`   Final: ${timeFilter.bankroll.toFixed(2)} BNB`);
console.log(`   Profit: ${(timeFilter.bankroll - 100).toFixed(2)} BNB`);
console.log(`   vs Baseline: ${((timeFilter.bankroll - baseline.bankroll) / Math.abs(baseline.bankroll - 100) * 100).toFixed(1)}% ${timeFilter.bankroll > baseline.bankroll ? 'better ✅' : 'worse ❌'}\n`);

const streakFilter = testLossStreakFilter();
console.log('3️⃣ LOSS STREAK FILTER (Skip after 2 losses):');
console.log(`   Trades: ${streakFilter.trades} (filtered ${streakFilter.streakFiltered} by streak)`);
console.log(`   Win Rate: ${(streakFilter.wins / streakFilter.trades * 100).toFixed(1)}%`);
console.log(`   Final: ${streakFilter.bankroll.toFixed(2)} BNB`);
console.log(`   Profit: ${(streakFilter.bankroll - 100).toFixed(2)} BNB`);
console.log(`   vs Baseline: ${((streakFilter.bankroll - baseline.bankroll) / Math.abs(baseline.bankroll - 100) * 100).toFixed(1)}% ${streakFilter.bankroll > baseline.bankroll ? 'better ✅' : 'worse ❌'}\n`);

const combined = testCombinedFilter();
console.log('4️⃣ COMBINED FILTERS (Time + Loss Streak):');
console.log(`   Trades: ${combined.trades}`);
console.log(`   Filtered by time: ${combined.timeFiltered}`);
console.log(`   Filtered by streak: ${combined.streakFiltered}`);
console.log(`   Win Rate: ${(combined.wins / combined.trades * 100).toFixed(1)}%`);
console.log(`   Final: ${combined.bankroll.toFixed(2)} BNB`);
console.log(`   Profit: ${(combined.bankroll - 100).toFixed(2)} BNB`);
console.log(`   vs Baseline: ${((combined.bankroll - baseline.bankroll) / Math.abs(baseline.bankroll - 100) * 100).toFixed(1)}% ${combined.bankroll > baseline.bankroll ? 'better ✅' : 'worse ❌'}\n`);

console.log('═'.repeat(70));
console.log('\n🏆 BEST STRATEGY:');
const results = [
  { name: 'Baseline', profit: baseline.bankroll - 100 },
  { name: 'Time Filter', profit: timeFilter.bankroll - 100 },
  { name: 'Loss Streak Filter', profit: streakFilter.bankroll - 100 },
  { name: 'Combined', profit: combined.bankroll - 100 }
];
const best = results.sort((a, b) => b.profit - a.profit)[0];
console.log(`   ${best.name}: +${best.profit.toFixed(2)} BNB`);

db.close();
