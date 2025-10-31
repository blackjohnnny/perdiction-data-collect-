import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';

const SQL = await initSqlJs();
const buffer = readFileSync('../data/prediction-data.db');
const db = new SQL.Database(buffer);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('   EMA SIGNAL STABILITY ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('Loading rounds...');

const query = `
  SELECT
    epoch,
    winner,
    close_price,
    lock_price,
    total_amount_wei,
    bull_amount_wei,
    bear_amount_wei
  FROM rounds
  WHERE winner IN ('UP', 'DOWN')
    AND close_price > 0
  ORDER BY epoch ASC
  LIMIT 10000
`;

const stmt = db.prepare(query);
const rounds = [];
while (stmt.step()) {
  const row = stmt.getAsObject();

  const finalBull = BigInt(row.bull_amount_wei);
  const finalBear = BigInt(row.bear_amount_wei);
  const finalTotal = BigInt(row.total_amount_wei);

  const finalUpMultiple = finalBull > 0n ? Number(finalTotal * 100n / finalBull) / 100 : 0;
  const finalDownMultiple = finalBear > 0n ? Number(finalTotal * 100n / finalBear) / 100 : 0;

  rounds.push({
    epoch: row.epoch,
    winner: row.winner,
    closePrice: BigInt(row.close_price),
    lockPrice: BigInt(row.lock_price),
    finalUpPayout: finalUpMultiple,
    finalDownPayout: finalDownMultiple
  });
}
stmt.free();
db.close();

console.log(`✓ Loaded ${rounds.length} rounds\n`);

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = [];
  ema[0] = prices[0];

  for (let i = 1; i < prices.length; i++) {
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }

  return ema;
}

const closePrices = rounds.map(r => Number(r.closePrice) / 1e8);
const ema5 = calculateEMA(closePrices, 5);
const ema13 = calculateEMA(closePrices, 13);

console.log('═══════════════════════════════════════════════════════════════');
console.log('1. HOW OFTEN DOES EMA SIGNAL FLIP?');
console.log('═══════════════════════════════════════════════════════════════\n');

let flips = 0;
let lastSignal = null;

for (let i = 13; i < rounds.length; i++) {
  const signal = ema5[i] > ema13[i] ? 'UP' : 'DOWN';

  if (lastSignal && signal !== lastSignal) {
    flips++;
  }
  lastSignal = signal;
}

const totalRounds = rounds.length - 13;
const flipRate = (flips / totalRounds) * 100;

console.log(`Total rounds analyzed: ${totalRounds}`);
console.log(`Signal flips: ${flips}`);
console.log(`Flip rate: ${flipRate.toFixed(2)}% of rounds\n`);
console.log(`Average rounds between flips: ${(totalRounds / flips).toFixed(1)}\n`);

console.log('═══════════════════════════════════════════════════════════════');
console.log('2. TEST PRECAUTION: REQUIRE EMA GAP THRESHOLD');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('Testing different EMA gap requirements:\n');

// Test different gap thresholds
const gapThresholds = [0, 0.1, 0.5, 1.0, 2.0, 5.0];

for (const gapThreshold of gapThresholds) {
  let bankroll = 1.0;
  let totalBets = 0;
  let wins = 0;
  let skipped = 0;

  for (let i = 13; i < rounds.length; i++) {
    const round = rounds[i];

    const emaGap = Math.abs(ema5[i] - ema13[i]);
    const emaSignal = ema5[i] > ema13[i] ? 'UP' : 'DOWN';

    // Skip if gap is too small (signal not confident)
    if (emaGap < gapThreshold) {
      skipped++;
      continue;
    }

    const betSize = bankroll * 0.02;
    bankroll -= betSize;
    totalBets++;

    const won = emaSignal === round.winner;

    if (won) {
      const payout = emaSignal === 'UP' ? round.finalUpPayout : round.finalDownPayout;
      bankroll += betSize * payout;
      wins++;
    }
  }

  const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;
  const roi = ((bankroll - 1.0) / 1.0) * 100;

  console.log(`Gap ≥ ${gapThreshold.toFixed(1)}:`);
  console.log(`  Bets: ${totalBets} (${skipped} skipped)`);
  console.log(`  Win Rate: ${winRate.toFixed(2)}%`);
  console.log(`  ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`);
  console.log(`  Final: ${bankroll.toFixed(4)} BNB\n`);
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('3. TEST PRECAUTION: REQUIRE CONSECUTIVE SIGNALS');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('Testing consecutive signal requirements:\n');

const consecutiveReqs = [1, 2, 3, 4, 5];

for (const consecutiveReq of consecutiveReqs) {
  let bankroll = 1.0;
  let totalBets = 0;
  let wins = 0;
  let skipped = 0;

  for (let i = 13; i < rounds.length; i++) {
    const round = rounds[i];
    const currentSignal = ema5[i] > ema13[i] ? 'UP' : 'DOWN';

    // Check if signal has been consistent for N rounds
    let consecutive = 0;
    for (let j = i; j >= 13 && consecutive < consecutiveReq; j--) {
      const pastSignal = ema5[j] > ema13[j] ? 'UP' : 'DOWN';
      if (pastSignal === currentSignal) {
        consecutive++;
      } else {
        break;
      }
    }

    if (consecutive < consecutiveReq) {
      skipped++;
      continue;
    }

    const betSize = bankroll * 0.02;
    bankroll -= betSize;
    totalBets++;

    const won = currentSignal === round.winner;

    if (won) {
      const payout = currentSignal === 'UP' ? round.finalUpPayout : round.finalDownPayout;
      bankroll += betSize * payout;
      wins++;
    }
  }

  const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;
  const roi = ((bankroll - 1.0) / 1.0) * 100;

  console.log(`Require ${consecutiveReq} consecutive signal(s):`);
  console.log(`  Bets: ${totalBets} (${skipped} skipped)`);
  console.log(`  Win Rate: ${winRate.toFixed(2)}%`);
  console.log(`  ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`);
  console.log(`  Final: ${bankroll.toFixed(4)} BNB\n`);
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('4. RECOMMENDED PRECAUTIONS');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('Based on analysis above:\n');
console.log('Option A: EMA Gap Threshold');
console.log('  - Skip when |EMA5 - EMA13| < threshold');
console.log('  - Pro: Avoids choppy markets');
console.log('  - Con: May miss some opportunities\n');

console.log('Option B: Consecutive Signal Requirement');
console.log('  - Only bet after N consecutive same signals');
console.log('  - Pro: Confirms trend stability');
console.log('  - Con: Enters trades later\n');

console.log('Option C: Combine Both');
console.log('  - Require gap threshold AND consecutive signals');
console.log('  - Pro: Most conservative, highest confidence');
console.log('  - Con: Fewest betting opportunities\n');

console.log('Option D: No Filter (Current Strategy)');
console.log('  - Bet on every EMA signal');
console.log('  - Pro: Maximum opportunities');
console.log('  - Con: Some trades during choppy periods\n');

console.log('═══════════════════════════════════════════════════════════════\n');
