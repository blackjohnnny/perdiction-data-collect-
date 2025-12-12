import { initDatabase } from './db-init.js';
import fs from 'fs';

const db = initDatabase();

const config = {
  EMA_GAP: 0.05,
  MAX_PAYOUT: 1.55,
  CB_THRESHOLD: 3,
  CB_COOLDOWN_MIN: 45,
};

const rounds = db.prepare(`
  SELECT epoch, lock_timestamp, ema_signal, ema_gap,
         t20s_bull_wei, t20s_bear_wei, winner, close_price, lock_price
  FROM rounds
  WHERE t20s_bull_wei IS NOT NULL
    AND t20s_bear_wei IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
    AND close_price IS NOT NULL
    AND lock_price IS NOT NULL
  ORDER BY epoch ASC
`).all();

console.log('🔬 Extracting all rounds that occurred during cooldowns...\n');

let consecutiveLosses = 0;
let cooldownUntilTimestamp = 0;
const cooldownRounds = [];
const normalRounds = [];
let cooldownPeriods = [];
let currentCooldownStart = null;

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];
  const inCooldown = r.lock_timestamp < cooldownUntilTimestamp;

  const bullAmount = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearAmount = parseFloat(r.t20s_bear_wei) / 1e18;
  const totalAmount = bullAmount + bearAmount;

  if (totalAmount === 0) continue;

  const bullPayout = totalAmount / bullAmount;
  const bearPayout = totalAmount / bearAmount;

  // Track if this round is in cooldown
  if (inCooldown) {
    if (!currentCooldownStart) {
      currentCooldownStart = r.epoch;
    }

    cooldownRounds.push({
      epoch: r.epoch,
      lock_timestamp: r.lock_timestamp,
      lock_price: r.lock_price,
      close_price: r.close_price,
      winner: r.winner,
      bull_payout: bullPayout.toFixed(4),
      bear_payout: bearPayout.toFixed(4),
      price_change_pct: (((r.close_price - r.lock_price) / r.lock_price) * 100).toFixed(4),
      cooldown_start: currentCooldownStart
    });
  } else {
    if (currentCooldownStart) {
      cooldownPeriods.push({
        start: currentCooldownStart,
        end: rounds[i - 1].epoch,
        rounds_count: cooldownRounds.filter(cr => cr.cooldown_start === currentCooldownStart).length
      });
      currentCooldownStart = null;
    }

    normalRounds.push({
      epoch: r.epoch,
      lock_timestamp: r.lock_timestamp,
      lock_price: r.lock_price,
      close_price: r.close_price,
      winner: r.winner,
      bull_payout: bullPayout.toFixed(4),
      bear_payout: bearPayout.toFixed(4),
      price_change_pct: (((r.close_price - r.lock_price) / r.lock_price) * 100).toFixed(4)
    });
  }

  // Check if we SHOULD trade this round (normal trading)
  if (!inCooldown) {
    const emaSignal = r.ema_signal;
    let signal = null;

    if (emaSignal === 'BULL' && bullPayout >= config.MAX_PAYOUT) {
      signal = 'BULL';
    } else if (emaSignal === 'BEAR' && bearPayout >= config.MAX_PAYOUT) {
      signal = 'BEAR';
    }

    if (signal) {
      const won = (signal === 'BULL' && r.winner === 'bull') || (signal === 'BEAR' && r.winner === 'bear');

      if (!won) {
        consecutiveLosses++;
        if (consecutiveLosses >= config.CB_THRESHOLD) {
          cooldownUntilTimestamp = r.lock_timestamp + (config.CB_COOLDOWN_MIN * 60);
          consecutiveLosses = 0;
        }
      } else {
        consecutiveLosses = 0;
      }
    }
  }
}

// Write cooldown data to CSV
const cooldownCSV = [
  'epoch,lock_timestamp,lock_price,close_price,winner,bull_payout,bear_payout,price_change_pct,cooldown_start'
];

cooldownRounds.forEach(r => {
  cooldownCSV.push(
    `${r.epoch},${r.lock_timestamp},${r.lock_price},${r.close_price},${r.winner},${r.bull_payout},${r.bear_payout},${r.price_change_pct},${r.cooldown_start}`
  );
});

fs.writeFileSync('cooldown-rounds.csv', cooldownCSV.join('\n'));

// Write cooldown periods summary
const cooldownPeriodsCSV = [
  'cooldown_number,start_epoch,end_epoch,rounds_in_cooldown'
];

cooldownPeriods.forEach((p, i) => {
  cooldownPeriodsCSV.push(`${i + 1},${p.start},${p.end},${p.rounds_count}`);
});

fs.writeFileSync('cooldown-periods.csv', cooldownPeriodsCSV.join('\n'));

// Stats
console.log('📊 EXTRACTION COMPLETE:\n');
console.log(`Total rounds analyzed: ${rounds.length}`);
console.log(`Normal rounds: ${normalRounds.length}`);
console.log(`Cooldown rounds: ${cooldownRounds.length}`);
console.log(`Cooldown periods: ${cooldownPeriods.length}\n`);

console.log('Files created:');
console.log('  - cooldown-rounds.csv (all rounds during cooldowns)');
console.log('  - cooldown-periods.csv (summary of each cooldown period)\n');

// Analyze cooldown characteristics
const bullWins = cooldownRounds.filter(r => r.winner === 'bull').length;
const bearWins = cooldownRounds.filter(r => r.winner === 'bear').length;
const avgPriceChange = cooldownRounds.reduce((sum, r) => sum + Math.abs(parseFloat(r.price_change_pct)), 0) / cooldownRounds.length;

console.log('📈 COOLDOWN CHARACTERISTICS:\n');
console.log(`Bull wins: ${bullWins} (${(bullWins / cooldownRounds.length * 100).toFixed(1)}%)`);
console.log(`Bear wins: ${bearWins} (${(bearWins / cooldownRounds.length * 100).toFixed(1)}%)`);
console.log(`Avg absolute price change: ${avgPriceChange.toFixed(4)}%\n`);

// Show sample cooldown periods
console.log('📋 SAMPLE COOLDOWN PERIODS:\n');
cooldownPeriods.slice(0, 5).forEach((p, i) => {
  const roundsInPeriod = cooldownRounds.filter(r => r.cooldown_start === p.start);
  const bulls = roundsInPeriod.filter(r => r.winner === 'bull').length;
  const bears = roundsInPeriod.filter(r => r.winner === 'bear').length;
  console.log(`${i + 1}. Epochs ${p.start}-${p.end}: ${p.rounds_count} rounds (${bulls}B/${bears}B)`);
});

console.log('\n✅ Use cooldown-rounds.csv to analyze what strategies work during cooldowns!');
