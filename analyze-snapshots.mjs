import initSqlJs from 'sql.js';
import fs from 'fs';

const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync('prediction-data.db'));

console.log('\n5. ROI ANALYSIS\n');

const data = db.exec(`
  SELECT s.bull_amount_wei, s.bear_amount_wei, s.implied_up_multiple,
         s.implied_down_multiple, r.winner, r.winner_multiple
  FROM snapshots s
  JOIN rounds r ON s.epoch = r.epoch
`);

let contraProfit = 0;
let crowdProfit = 0;
const betCount = data[0].values.length;

data[0].values.forEach(row => {
  const bull = BigInt(row[0]);
  const bear = BigInt(row[1]);
  const winner = row[4];
  const winnerMult = row[5];

  const contraBet = bull > bear ? 'DOWN' : 'UP';

  if (contraBet === winner) {
    contraProfit += (winnerMult - 1);
  } else {
    contraProfit -= 1;
  }

  if (contraBet !== winner) {
    crowdProfit += (winnerMult - 1);
  } else {
    crowdProfit -= 1;
  }
});

console.log('CONTRARIAN (bet against crowd):');
console.log('  Total profit: ' + contraProfit.toFixed(2) + ' BNB (if betting 1 BNB each)');
console.log('  ROI: ' + (contraProfit * 100 / betCount).toFixed(2) + '%');

console.log('\nFOLLOW CROWD (bet with majority):');
console.log('  Total profit: ' + crowdProfit.toFixed(2) + ' BNB');
console.log('  ROI: ' + (crowdProfit * 100 / betCount).toFixed(2) + '%');

console.log('\n6. POOL SIZE BREAKDOWN\n');

const poolSize = db.exec(`
  SELECT s.total_amount_wei, r.winner
  FROM snapshots s
  JOIN rounds r ON s.epoch = r.epoch
`);

const buckets = {
  small: { total: 0, up: 0 },
  medium: { total: 0, up: 0 },
  large: { total: 0, up: 0 }
};

poolSize[0].values.forEach(row => {
  const totalBNB = Number(BigInt(row[0]) / BigInt(1e18));
  const winner = row[1];

  if (totalBNB < 1) {
    buckets.small.total++;
    if (winner === 'UP') buckets.small.up++;
  } else if (totalBNB < 5) {
    buckets.medium.total++;
    if (winner === 'UP') buckets.medium.up++;
  } else {
    buckets.large.total++;
    if (winner === 'UP') buckets.large.up++;
  }
});

console.log('Small pools (<1 BNB): ' + buckets.small.total + ' rounds, UP: ' + (buckets.small.up*100/buckets.small.total).toFixed(1) + '%');
console.log('Medium pools (1-5 BNB): ' + buckets.medium.total + ' rounds, UP: ' + (buckets.medium.up*100/buckets.medium.total).toFixed(1) + '%');
console.log('Large pools (>5 BNB): ' + buckets.large.total + ' rounds, UP: ' + (buckets.large.up*100/buckets.large.total).toFixed(1) + '%');

console.log('\n7. BETTING DISTRIBUTION ANALYSIS\n');

const distribution = db.exec(`
  SELECT s.epoch, s.bull_amount_wei, s.bear_amount_wei, r.winner
  FROM snapshots s
  JOIN rounds r ON s.epoch = r.epoch
`);

const distBuckets = {
  verySkewed: { total: 0, majorityWins: 0 },    // >80% on one side
  skewed: { total: 0, majorityWins: 0 },        // 65-80% on one side
  balanced: { total: 0, majorityWins: 0 }       // 45-65% on each side
};

distribution[0].values.forEach(row => {
  const bull = BigInt(row[1]);
  const bear = BigInt(row[2]);
  const winner = row[3];
  const total = bull + bear;
  const bullPct = Number((bull * 10000n) / total) / 100;

  const majority = bullPct > 50 ? 'UP' : 'DOWN';
  const majorityPct = Math.max(bullPct, 100 - bullPct);

  if (majorityPct > 80) {
    distBuckets.verySkewed.total++;
    if (majority === winner) distBuckets.verySkewed.majorityWins++;
  } else if (majorityPct > 65) {
    distBuckets.skewed.total++;
    if (majority === winner) distBuckets.skewed.majorityWins++;
  } else {
    distBuckets.balanced.total++;
    if (majority === winner) distBuckets.balanced.majorityWins++;
  }
});

console.log('Very skewed (>80% on one side):');
console.log('  Count: ' + distBuckets.verySkewed.total);
console.log('  Majority wins: ' + distBuckets.verySkewed.majorityWins + '/' + distBuckets.verySkewed.total +
            ' (' + (distBuckets.verySkewed.total > 0 ? (distBuckets.verySkewed.majorityWins*100/distBuckets.verySkewed.total).toFixed(1) : '0') + '%)');

console.log('\nSkewed (65-80% on one side):');
console.log('  Count: ' + distBuckets.skewed.total);
console.log('  Majority wins: ' + distBuckets.skewed.majorityWins + '/' + distBuckets.skewed.total +
            ' (' + (distBuckets.skewed.majorityWins*100/distBuckets.skewed.total).toFixed(1) + '%)');

console.log('\nBalanced (45-65% each side):');
console.log('  Count: ' + distBuckets.balanced.total);
console.log('  Majority wins: ' + distBuckets.balanced.majorityWins + '/' + distBuckets.balanced.total +
            ' (' + (distBuckets.balanced.majorityWins*100/distBuckets.balanced.total).toFixed(1) + '%)');

db.close();
