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

console.log('🔍 ANALYZING CIRCUIT BREAKER TRIGGER PATTERNS\n');
console.log('═'.repeat(70));

let consecLosses = 0;
let circuitBreakers = [];
let allTrades = [];

rounds.forEach((r, idx) => {
  if (!r.ema_signal || r.ema_signal === 'NEUTRAL') return;

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

  if (!signal) return;

  const actualPayout = signal === 'BULL' ? bullPayout : bearPayout;
  const won = r.winner.toUpperCase() === signal;

  const date = new Date(r.lock_timestamp * 1000);
  const hour = date.getUTCHours();
  const dayOfWeek = date.getUTCDay(); // 0=Sunday, 6=Saturday

  const trade = {
    epoch: r.epoch,
    timestamp: r.lock_timestamp,
    hour,
    dayOfWeek,
    signal,
    won,
    payout: actualPayout,
    emaGap: r.ema_gap,
    emaSignal: r.ema_signal,
    lockPrice: parseFloat(r.lock_price) / 1e8,
    closePrice: parseFloat(r.close_price) / 1e8
  };

  allTrades.push(trade);

  if (!won) {
    consecLosses++;
    if (consecLosses === 3) {
      // Circuit breaker triggered!
      circuitBreakers.push({
        triggerEpoch: r.epoch,
        triggerTime: date.toISOString(),
        hour,
        dayOfWeek,
        last3Trades: allTrades.slice(-3)
      });
      consecLosses = 0;
    }
  } else {
    consecLosses = 0;
  }
});

console.log('\n📊 CIRCUIT BREAKER STATISTICS:\n');
console.log(`Total circuit breakers triggered: ${circuitBreakers.length}`);
console.log(`Total trades: ${allTrades.length}`);
console.log(`Circuit breaker rate: ${(circuitBreakers.length / allTrades.length * 100).toFixed(1)}%`);

// Analyze by hour
console.log('\n⏰ CIRCUIT BREAKERS BY HOUR (UTC):\n');
const byHour = {};
for (let h = 0; h < 24; h++) byHour[h] = 0;
circuitBreakers.forEach(cb => byHour[cb.hour]++);

const hoursSorted = Object.entries(byHour).sort((a, b) => b[1] - a[1]);
console.log('Hour | Count | % of Total');
console.log('-----|-------|----------');
hoursSorted.slice(0, 10).forEach(([hour, count]) => {
  const pct = (count / circuitBreakers.length * 100).toFixed(1);
  console.log(`${hour.padStart(4)} | ${count.toString().padStart(5)} | ${pct}%`);
});

// Analyze by day of week
console.log('\n📅 CIRCUIT BREAKERS BY DAY OF WEEK:\n');
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const byDay = {};
for (let d = 0; d < 7; d++) byDay[d] = 0;
circuitBreakers.forEach(cb => byDay[cb.dayOfWeek]++);

console.log('Day       | Count | % of Total');
console.log('----------|-------|----------');
Object.entries(byDay).forEach(([day, count]) => {
  const pct = (count / circuitBreakers.length * 100).toFixed(1);
  console.log(`${dayNames[day].padEnd(9)} | ${count.toString().padStart(5)} | ${pct}%`);
});

// Analyze market conditions before circuit breaker
console.log('\n🔬 MARKET CONDITIONS BEFORE CIRCUIT BREAKER:\n');

let avgEmaGap = 0;
let avgPayout = 0;
let priceVolatility = [];

circuitBreakers.forEach(cb => {
  const last3 = cb.last3Trades;
  last3.forEach(t => {
    avgEmaGap += Math.abs(t.emaGap);
    avgPayout += t.payout;
  });

  // Calculate price volatility
  const prices = last3.map(t => t.closePrice);
  const volatility = Math.max(...prices) - Math.min(...prices);
  priceVolatility.push(volatility);
});

avgEmaGap /= (circuitBreakers.length * 3);
avgPayout /= (circuitBreakers.length * 3);
const avgVolatility = priceVolatility.reduce((a, b) => a + b, 0) / priceVolatility.length;

console.log(`Average EMA gap before CB: ${avgEmaGap.toFixed(3)}%`);
console.log(`Average payout before CB: ${avgPayout.toFixed(2)}x`);
console.log(`Average price volatility: $${avgVolatility.toFixed(2)}`);

// Compare to overall stats
const overallAvgEmaGap = allTrades.reduce((acc, t) => acc + Math.abs(t.emaGap), 0) / allTrades.length;
const overallAvgPayout = allTrades.reduce((acc, t) => acc + t.payout, 0) / allTrades.length;

console.log(`\nOverall average EMA gap: ${overallAvgEmaGap.toFixed(3)}%`);
console.log(`Overall average payout: ${overallAvgPayout.toFixed(2)}x`);

// Pattern detection
console.log('\n🎯 PREDICTIVE INDICATORS:\n');

if (avgEmaGap < overallAvgEmaGap * 0.8) {
  console.log('✅ LOW EMA GAP = Higher circuit breaker risk');
  console.log(`   CB triggers when EMA gap < ${(overallAvgEmaGap * 0.8).toFixed(3)}%`);
}

if (avgPayout > overallAvgPayout * 1.1) {
  console.log('✅ HIGH PAYOUTS = Higher circuit breaker risk');
  console.log(`   CB triggers when payouts > ${(overallAvgPayout * 1.1).toFixed(2)}x`);
}

// Show first 5 circuit breakers as examples
console.log('\n📋 EXAMPLE CIRCUIT BREAKER EVENTS:\n');
circuitBreakers.slice(0, 5).forEach((cb, idx) => {
  console.log(`${idx + 1}. Epoch ${cb.triggerEpoch} at ${cb.triggerTime.substring(0, 19)}Z`);
  console.log(`   Hour: ${cb.hour}:00 UTC | Day: ${dayNames[cb.dayOfWeek]}`);
  console.log(`   Last 3 trades before trigger:`);
  cb.last3Trades.forEach((t, i) => {
    console.log(`     ${i + 1}. ${t.signal} @ ${t.payout.toFixed(2)}x (EMA gap: ${t.emaGap.toFixed(3)}%) → LOSS`);
  });
  console.log('');
});

console.log('═'.repeat(70));

db.close();
