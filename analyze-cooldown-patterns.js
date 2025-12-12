import { initDatabase } from './db-init.js';
import fs from 'fs';

const db = initDatabase();

// Read cooldown rounds
const cooldownCSV = fs.readFileSync('cooldown-rounds.csv', 'utf-8').split('\n').slice(1);
const cooldownData = cooldownCSV.filter(line => line.trim()).map(line => {
  const [epoch, lock_timestamp, lock_price, close_price, winner, bull_payout, bear_payout, price_change_pct, cooldown_start] = line.split(',');
  return {
    epoch: parseInt(epoch),
    lock_timestamp: parseInt(lock_timestamp),
    lock_price: parseFloat(lock_price),
    close_price: parseFloat(close_price),
    winner,
    bull_payout: parseFloat(bull_payout),
    bear_payout: parseFloat(bear_payout),
    price_change_pct: parseFloat(price_change_pct),
    cooldown_start: parseInt(cooldown_start)
  };
});

console.log('🔬 ANALYZING COOLDOWN PATTERNS\n');
console.log(`Total cooldown rounds: ${cooldownData.length}\n`);

// Group by cooldown period
const cooldownPeriods = {};
cooldownData.forEach(r => {
  if (!cooldownPeriods[r.cooldown_start]) {
    cooldownPeriods[r.cooldown_start] = [];
  }
  cooldownPeriods[r.cooldown_start].push(r);
});

console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('📊 PATTERN ANALYSIS: What happens during cooldowns?\n');

// Analyze each cooldown period
let strongTrends = 0;
let consolidations = 0;
let reversals = 0;

Object.keys(cooldownPeriods).forEach(start => {
  const rounds = cooldownPeriods[start];
  const bulls = rounds.filter(r => r.winner === 'bull').length;
  const bears = rounds.filter(r => r.winner === 'bear').length;
  const ratio = Math.max(bulls, bears) / rounds.length;

  if (ratio >= 0.75) {
    strongTrends++;
  } else if (ratio >= 0.60) {
    reversals++;
  } else {
    consolidations++;
  }
});

console.log(`Strong trends (≥75% one direction): ${strongTrends} periods (${(strongTrends / Object.keys(cooldownPeriods).length * 100).toFixed(1)}%)`);
console.log(`Moderate trends (60-75%): ${reversals} periods (${(reversals / Object.keys(cooldownPeriods).length * 100).toFixed(1)}%)`);
console.log(`Consolidation (<60%): ${consolidations} periods (${(consolidations / Object.keys(cooldownPeriods).length * 100).toFixed(1)}%)\n`);

console.log('════════════════════════════════════════════════════════════════════════════\n');
console.log('💡 STRATEGY TESTING ON COOLDOWN DATA ONLY:\n');

// Test different strategies on cooldown rounds ONLY
function testStrategy(name, strategyFn) {
  let wins = 0, total = 0;

  Object.keys(cooldownPeriods).forEach(start => {
    const rounds = cooldownPeriods[start];

    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];
      const signal = strategyFn(rounds, i, r);

      if (signal) {
        const payout = signal === 'BULL' ? r.bull_payout : r.bear_payout;
        if (payout < 1.5) continue; // Min payout filter

        const won = (signal === 'BULL' && r.winner === 'bull') || (signal === 'BEAR' && r.winner === 'bear');
        if (won) wins++;
        total++;
      }
    }
  });

  const wr = total > 0 ? (wins / total * 100) : 0;
  return { name, total, wins, wr };
}

const strategies = [
  // 1. Fade the trend (bet AGAINST recent direction)
  testStrategy('Fade recent 3-round trend', (rounds, i, r) => {
    if (i < 3) return null;
    const recent3 = rounds.slice(i - 3, i);
    const bulls = recent3.filter(r => r.winner === 'bull').length;
    if (bulls >= 2) return 'BEAR';
    if (bulls <= 1) return 'BULL';
    return null;
  }),

  // 2. Follow the cooldown trend (continuation)
  testStrategy('Follow cooldown trend', (rounds, i, r) => {
    if (i < 2) return null;
    const recent2 = rounds.slice(i - 2, i);
    const bulls = recent2.filter(r => r.winner === 'bull').length;
    if (bulls === 2) return 'BULL';
    if (bulls === 0) return 'BEAR';
    return null;
  }),

  // 3. Bet on higher payout (crowd fade)
  testStrategy('Always bet higher payout', (rounds, i, r) => {
    if (r.bull_payout > r.bear_payout && r.bull_payout >= 1.5) return 'BULL';
    if (r.bear_payout > r.bull_payout && r.bear_payout >= 1.5) return 'BEAR';
    return null;
  }),

  // 4. Bet on lower payout (follow crowd)
  testStrategy('Always bet lower payout (crowd)', (rounds, i, r) => {
    if (r.bull_payout < r.bear_payout && r.bear_payout >= 1.5) return 'BULL';
    if (r.bear_payout < r.bull_payout && r.bull_payout >= 1.5) return 'BEAR';
    return null;
  }),

  // 5. Fade ONLY when payout gap is large
  testStrategy('Fade when gap ≥0.3x', (rounds, i, r) => {
    const gap = Math.abs(r.bull_payout - r.bear_payout);
    if (gap < 0.3) return null;
    if (r.bull_payout > r.bear_payout) return 'BULL';
    if (r.bear_payout > r.bull_payout) return 'BEAR';
    return null;
  }),

  // 6. Mean reversion after 2 same direction
  testStrategy('Mean reversion after 2 same', (rounds, i, r) => {
    if (i < 2) return null;
    const prev2 = rounds.slice(i - 2, i);
    const bulls = prev2.filter(r => r.winner === 'bull').length;
    if (bulls === 2 && r.bear_payout >= 1.5) return 'BEAR';
    if (bulls === 0 && r.bull_payout >= 1.5) return 'BULL';
    return null;
  }),

  // 7. Scalping: bet opposite of LAST round
  testStrategy('Bet opposite of last round', (rounds, i, r) => {
    if (i === 0) return null;
    const prev = rounds[i - 1];
    if (prev.winner === 'bull' && r.bear_payout >= 1.5) return 'BEAR';
    if (prev.winner === 'bear' && r.bull_payout >= 1.5) return 'BULL';
    return null;
  }),

  // 8. Only trade at start of cooldown (first 3 rounds)
  testStrategy('Only first 3 rounds of cooldown', (rounds, i, r) => {
    if (i >= 3) return null;
    if (r.bull_payout > r.bear_payout && r.bull_payout >= 1.5) return 'BULL';
    if (r.bear_payout > r.bull_payout && r.bear_payout >= 1.5) return 'BEAR';
    return null;
  }),

  // 9. Only trade at END of cooldown (last 3 rounds)
  testStrategy('Only last 3 rounds of cooldown', (rounds, i, r) => {
    if (i < rounds.length - 3) return null;
    if (r.bull_payout > r.bear_payout && r.bull_payout >= 1.5) return 'BULL';
    if (r.bear_payout > r.bull_payout && r.bear_payout >= 1.5) return 'BEAR';
    return null;
  }),
];

strategies.sort((a, b) => b.wr - a.wr);

console.log('Strategy                           │ Trades │ Wins │  WR  ');
console.log('───────────────────────────────────┼────────┼──────┼──────');

strategies.forEach(s => {
  const mark = s.wr >= 55 ? ' ✅' : s.wr >= 50 ? ' ⚠️' : '';
  console.log(
    `${s.name.padEnd(34)} │ ${String(s.total).padStart(6)} │ ${String(s.wins).padStart(4)} │ ${s.wr.toFixed(1).padStart(5)}%${mark}`
  );
});

console.log('\n════════════════════════════════════════════════════════════════════════════\n');

const best = strategies[0];
if (best.wr >= 55 && best.total >= 30) {
  console.log(`✅ FOUND WINNING STRATEGY: ${best.name}`);
  console.log(`   ${best.total} trades, ${best.wr.toFixed(1)}% WR\n`);
  console.log(`This strategy works during cooldowns!`);
} else {
  console.log(`⚠️ Best strategy: ${best.name} (${best.wr.toFixed(1)}% WR, ${best.total} trades)`);
  console.log(`\nNo strong edge found in cooldown periods.`);
  console.log(`Recommendation: SKIP cooldowns or use conservative approach.`);
}
