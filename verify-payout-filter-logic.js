import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('\n🔍 VERIFY PAYOUT FILTER LOGIC\n');
console.log('═'.repeat(80) + '\n');

const db = initDatabase(DB_PATH);

const rounds = db.prepare(`
  SELECT
    sample_id,
    epoch,
    t20s_bull_wei,
    t20s_bear_wei,
    winner,
    winner_payout_multiple,
    ema_gap
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_gap IS NOT NULL
  ORDER BY lock_timestamp ASC
  LIMIT 50
`).all();

console.log('📊 Analyzing first 50 rounds to verify logic:\n');
console.log('─'.repeat(80) + '\n');

const EMA_THRESHOLD = 0.05;
const PAYOUT_FILTER = 1.5;

let examplesShown = 0;

for (const r of rounds) {
  const emaGap = parseFloat(r.ema_gap);

  // Determine EMA side
  let emaSide = null;
  if (emaGap > EMA_THRESHOLD) emaSide = 'BULL';
  else if (emaGap < -EMA_THRESHOLD) emaSide = 'BEAR';

  if (!emaSide) continue;

  // Calculate T-20s pools
  const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;

  if (total === 0) continue;

  // Calculate crowd %
  const bullPercent = (bullWei / total) * 100;
  const bearPercent = (bearWei / total) * 100;

  // Determine crowd side (majority)
  const crowdSide = bullPercent > 50 ? 'BULL' : 'BEAR';

  // Calculate estimated payout for our EMA side
  const estimatedPayout = emaSide === 'BULL' ? (total / bullWei) : (total / bearWei);

  // Check if we'd take this trade with payout filter
  const passesPayoutFilter = estimatedPayout >= PAYOUT_FILTER;

  // Determine if we're betting WITH or AGAINST crowd
  const vsCorwd = emaSide === crowdSide ? 'WITH crowd' : 'AGAINST crowd';

  // Show some examples
  if (examplesShown < 15) {
    console.log(`Epoch ${r.epoch}:`);
    console.log(`  EMA signal: ${emaSide} (gap: ${emaGap.toFixed(3)}%)`);
    console.log(`  Crowd: ${bullPercent.toFixed(1)}% BULL, ${bearPercent.toFixed(1)}% BEAR → Majority is ${crowdSide}`);
    console.log(`  Our bet: ${emaSide} → Betting ${vsCorwd}`);
    console.log(`  Est. payout at T-20s: ${estimatedPayout.toFixed(2)}x`);
    console.log(`  Passes payout filter (≥1.5x)? ${passesPayoutFilter ? '✅ YES' : '❌ NO'}`);
    console.log(`  Actual winner: ${r.winner.toUpperCase()}`);
    console.log(`  Actual payout: ${parseFloat(r.winner_payout_multiple).toFixed(2)}x\n`);
    examplesShown++;
  }
}

console.log('═'.repeat(80) + '\n');

// Now analyze ALL rounds statistically
console.log('📊 FULL ANALYSIS OF ALL ROUNDS:\n');

const allRounds = db.prepare(`
  SELECT
    sample_id,
    epoch,
    t20s_bull_wei,
    t20s_bear_wei,
    winner,
    winner_payout_multiple,
    ema_gap
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_gap IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

let withCrowdCount = 0;
let againstCrowdCount = 0;
let withCrowdPasses = 0;
let againstCrowdPasses = 0;

for (const r of allRounds) {
  const emaGap = parseFloat(r.ema_gap);

  let emaSide = null;
  if (emaGap > EMA_THRESHOLD) emaSide = 'BULL';
  else if (emaGap < -EMA_THRESHOLD) emaSide = 'BEAR';

  if (!emaSide) continue;

  const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
  const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
  const total = bullWei + bearWei;

  if (total === 0) continue;

  const bullPercent = bullWei / total;
  const bearPercent = bearWei / total;
  const crowdSide = bullPercent > 0.5 ? 'BULL' : 'BEAR';

  const estimatedPayout = emaSide === 'BULL' ? (total / bullWei) : (total / bearWei);
  const passesPayoutFilter = estimatedPayout >= PAYOUT_FILTER;

  if (emaSide === crowdSide) {
    withCrowdCount++;
    if (passesPayoutFilter) withCrowdPasses++;
  } else {
    againstCrowdCount++;
    if (passesPayoutFilter) againstCrowdPasses++;
  }
}

console.log('EMA signals that align WITH crowd (majority):');
console.log(`  Total: ${withCrowdCount} trades`);
console.log(`  Pass payout filter (≥1.5x): ${withCrowdPasses} (${((withCrowdPasses/withCrowdCount)*100).toFixed(1)}%)`);
console.log(`  Fail payout filter (<1.5x): ${withCrowdCount - withCrowdPasses} (${(((withCrowdCount-withCrowdPasses)/withCrowdCount)*100).toFixed(1)}%)`);

console.log('\nEMA signals that go AGAINST crowd (minority):');
console.log(`  Total: ${againstCrowdCount} trades`);
console.log(`  Pass payout filter (≥1.5x): ${againstCrowdPasses} (${((againstCrowdPasses/againstCrowdCount)*100).toFixed(1)}%)`);
console.log(`  Fail payout filter (<1.5x): ${againstCrowdCount - againstCrowdPasses} (${(((againstCrowdCount-againstCrowdPasses)/againstCrowdCount)*100).toFixed(1)}%)`);

console.log('\n═'.repeat(80) + '\n');

console.log('🎯 CONCLUSION:\n');

console.log('When we add "Payout ≥ 1.5x" filter:');
console.log(`  • We MOSTLY bet AGAINST the crowd (${againstCrowdPasses} trades)`);
console.log(`  • We RARELY bet WITH the crowd (${withCrowdPasses} trades)`);
console.log('  • Because majority side = low payout (<1.5x)');
console.log('  • And minority side = high payout (≥1.5x)');

console.log('\nSo "Payout > 1.5x" filter = Betting AGAINST crowd while following EMA');

console.log('\n═'.repeat(80) + '\n');

db.close();
