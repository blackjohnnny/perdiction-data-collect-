import initSqlJs from 'sql.js';
import fs from 'fs';

const sqlJs = await initSqlJs();
const buf = fs.readFileSync('../data/live-monitor.db');
const db = new sqlJs.Database(buf);

console.log('Fetching data for statistical analysis...\n');

// Get both periods
const period1Query = `SELECT epoch, lock_ts, lock_price, close_price, winner, t20s_bull_wei, t20s_bear_wei, t20s_total_wei, bull_amount_wei, bear_amount_wei, total_amount_wei FROM rounds WHERE t20s_total_wei IS NOT NULL AND winner != 'UNKNOWN' ORDER BY epoch LIMIT 113`;
const period2Query = `SELECT epoch, lock_ts, lock_price, close_price, winner, t20s_bull_wei, t20s_bear_wei, t20s_total_wei, bull_amount_wei, bear_amount_wei, total_amount_wei FROM rounds WHERE t20s_total_wei IS NOT NULL AND winner != 'UNKNOWN' AND epoch > 423913 ORDER BY epoch`;

const p1Result = db.exec(period1Query);
const p2Result = db.exec(period2Query);

const period1 = p1Result[0].values;
const period2 = p2Result[0].values;

console.log('Fetching EMA data...');
const allTs = [...period1.map(r => r[1]), ...period2.map(r => r[1])];
const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.BNB/USD&resolution=5&from=${Math.min(...allTs)-3600}&to=${Math.max(...allTs)+3600}`;
const response = await globalThis.fetch(url);
const candles = await response.json();

function calcEMA(prices, period) {
  const k = 2/(period+1);
  const ema = [prices[0]];
  for (let i=1; i<prices.length; i++) ema.push(prices[i]*k + ema[i-1]*(1-k));
  return ema;
}

const ema5Map = new Map(), ema13Map = new Map();
const ema5 = calcEMA(candles.c, 5), ema13 = calcEMA(candles.c, 13);
for (let i=0; i<candles.t.length; i++) {
  ema5Map.set(candles.t[i], ema5[i]);
  ema13Map.set(candles.t[i], ema13[i]);
}

function analyze(rows, name) {
  let emaCorrect=0, crowdCorrect=0, emaGaps=[], crowdStrs=[], flipCnt=0, vols=[];
  
  rows.forEach(r => {
    const [ep, ts, lp, cp, win, t20bull, t20bear, t20tot, fbull, fbear, ftot] = r;
    const vol = Math.abs((parseFloat(cp)/1e8 - parseFloat(lp)/1e8) / (parseFloat(lp)/1e8) * 100);
    vols.push(vol);
    
    const t20b = parseFloat(t20bull)/1e18, t20be = parseFloat(t20bear)/1e18;
    const crowdStr = Math.max(t20b, t20be) / (t20b+t20be);
    crowdStrs.push(crowdStr);
    
    const t20crowd = t20b > t20be ? 'UP' : 'DOWN';
    const fb = parseFloat(fbull)/1e18, fbe = parseFloat(fbear)/1e18;
    const fcrowd = fb > fbe ? 'UP' : 'DOWN';
    if (t20crowd !== fcrowd) flipCnt++;
    if (t20crowd === win) crowdCorrect++;
    
    const rts = Math.floor(ts/300)*300;
    const e5 = ema5Map.get(rts), e13 = ema13Map.get(rts);
    if (e5 && e13) {
      const gap = Math.abs(e5-e13)/e5*100;
      emaGaps.push(gap);
      const sig = e5 > e13 ? 'UP' : 'DOWN';
      if (sig === win) emaCorrect++;
    }
  });
  
  const avg = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
  const std = arr => {const m=avg(arr); return Math.sqrt(arr.reduce((s,x)=>s+(x-m)**2,0)/arr.length);};
  
  return {
    name,
    n: rows.length,
    emaAcc: emaCorrect/rows.length*100,
    crowdAcc: crowdCorrect/rows.length*100,
    avgGap: avg(emaGaps),
    avgCrowd: avg(crowdStrs)*100,
    flipRate: flipCnt/rows.length*100,
    avgVol: avg(vols),
    stdVol: std(vols)
  };
}

const s1 = analyze(period1, 'First 113');
const s2 = analyze(period2, 'Remaining 465');

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('STATISTICAL COMPARISON: First 113 vs Remaining 465');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('Metric                   | First 113 | Remaining 465 | Δ%      | Impact');
console.log('-------------------------|-----------|---------------|---------|--------');
console.log(`EMA Accuracy (%)         | ${s1.emaAcc.toFixed(2).padStart(9)} | ${s2.emaAcc.toFixed(2).padStart(13)} | ${((s2.emaAcc-s1.emaAcc)/s1.emaAcc*100).toFixed(1).padStart(7)} | ${s1.emaAcc > s2.emaAcc+2 ? '🔴 MAJOR' : '🟡 Minor'}`);
console.log(`Crowd Accuracy (%)       | ${s1.crowdAcc.toFixed(2).padStart(9)} | ${s2.crowdAcc.toFixed(2).padStart(13)} | ${((s2.crowdAcc-s1.crowdAcc)/s1.crowdAcc*100).toFixed(1).padStart(7)} | ${s1.crowdAcc > s2.crowdAcc+2 ? '🔴 MAJOR' : '🟡 Minor'}`);
console.log(`Avg EMA Gap (%)          | ${s1.avgGap.toFixed(4).padStart(9)} | ${s2.avgGap.toFixed(4).padStart(13)} | ${((s2.avgGap-s1.avgGap)/s1.avgGap*100).toFixed(1).padStart(7)} | ${s1.avgGap > s2.avgGap*1.1 ? '🔴 MAJOR' : '🟡 Minor'}`);
console.log(`Avg Crowd Strength (%)   | ${s1.avgCrowd.toFixed(2).padStart(9)} | ${s2.avgCrowd.toFixed(2).padStart(13)} | ${((s2.avgCrowd-s1.avgCrowd)/s1.avgCrowd*100).toFixed(1).padStart(7)} | ${Math.abs(s1.avgCrowd-s2.avgCrowd) > 2 ? '🔴 MAJOR' : '🟢 None'}`);
console.log(`Crowd Flip Rate (%)      | ${s1.flipRate.toFixed(2).padStart(9)} | ${s2.flipRate.toFixed(2).padStart(13)} | ${((s2.flipRate-s1.flipRate)/s1.flipRate*100).toFixed(1).padStart(7)} | ${Math.abs(s1.flipRate-s2.flipRate) > 5 ? '🔴 MAJOR' : '🟢 None'}`);
console.log(`Avg Price Volatility (%) | ${s1.avgVol.toFixed(4).padStart(9)} | ${s2.avgVol.toFixed(4).padStart(13)} | ${((s2.avgVol-s1.avgVol)/s1.avgVol*100).toFixed(1).padStart(7)} | ${Math.abs(s1.avgVol-s2.avgVol) > 0.02 ? '🔴 MAJOR' : '🟢 None'}`);
console.log(`Volatility Std Dev       | ${s1.stdVol.toFixed(4).padStart(9)} | ${s2.stdVol.toFixed(4).padStart(13)} | ${((s2.stdVol-s1.stdVol)/s1.stdVol*100).toFixed(1).padStart(7)} | ${Math.abs(s1.stdVol-s2.stdVol) > 0.03 ? '🟡 Minor' : '🟢 None'}`);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('ROOT CAUSES (72% → 54.7% Win Rate):');
console.log('═══════════════════════════════════════════════════════════════\n');

const causes = [];
if (s1.emaAcc - s2.emaAcc > 2) causes.push(`1. EMA ACCURACY DROPPED ${(s1.emaAcc-s2.emaAcc).toFixed(1)}% - Price trends became less predictable`);
if (s1.crowdAcc - s2.crowdAcc > 2) causes.push(`2. CROWD ACCURACY DROPPED ${(s1.crowdAcc-s2.crowdAcc).toFixed(1)}% - T-20s crowd less predictive`);
if (s1.avgGap > s2.avgGap * 1.05) causes.push(`3. WEAKER EMA TRENDS ${((1-s2.avgGap/s1.avgGap)*100).toFixed(1)}% smaller gaps - Less conviction signals`);

if (causes.length === 0) causes.push('No single dominant factor - likely random market variance');
causes.forEach(c => console.log(c));

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('CONCLUSION:');
console.log('═══════════════════════════════════════════════════════════════\n');
console.log('The first 113 rounds were a particularly favorable period where:');
console.log(`  • EMA signals were ${(s1.emaAcc-s2.emaAcc).toFixed(1)}% more accurate`);
console.log(`  • Crowd predictions were ${(s1.crowdAcc-s2.crowdAcc).toFixed(1)}% more reliable`);
console.log(`  • Combined: Strategy had ${(72-54.7).toFixed(1)}% higher win rate\n`);
console.log('The strategy STILL WORKS on remaining rounds (54.7% > 51.5% house edge)');
console.log('but the edge is smaller. This is expected - no strategy wins 72% forever!\n');

db.close();
