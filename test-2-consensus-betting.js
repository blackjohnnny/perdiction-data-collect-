import { initDatabase } from './db-init.js';

const DB_PATH = './prediction.db';

console.log('🔬 TEST 2: CONSENSUS BETTING (WITH CROWD)\n');
console.log('═'.repeat(100) + '\n');
console.log('Testing: Betting WITH the crowd instead of AGAINST\n');
console.log('─'.repeat(100) + '\n');

const db = initDatabase(DB_PATH);

const rounds = db.prepare(`
  SELECT *
  FROM rounds
  WHERE t20s_timestamp IS NOT NULL
    AND winner IS NOT NULL
    AND ema_signal IS NOT NULL
  ORDER BY lock_timestamp ASC
`).all();

console.log(`📊 Testing on ${rounds.length} complete rounds\n\n`);

const BASE_CONFIG = {
  BASE_POSITION_SIZE: 0.045,
  MOMENTUM_MULTIPLIER: 1.889,
  RECOVERY_MULTIPLIER: 1.5,
  MIN_PAYOUT: 1.45,
  STARTING_BANKROLL: 1.0
};

const strategies = [
  {
    name: 'Baseline (EMA Contrarian - bet AGAINST crowd)',
    contrarian: true,
    useEMA: true
  },
  {
    name: 'EMA Consensus (bet WITH crowd)',
    consensus: true,
    useEMA: true
  },
  {
    name: 'Consensus: Follow the herd (bet on lower payout side)',
    followHerd: true
  },
  {
    name: 'Consensus: EMA + Strong crowd (payout <1.3x)',
    consensus: true,
    useEMA: true,
    maxPayout: 1.3
  },
  {
    name: 'Consensus: EMA + Very strong crowd (payout <1.2x)',
    consensus: true,
    useEMA: true,
    maxPayout: 1.2
  },
  {
    name: 'Smart Consensus: EMA + crowd agree + balanced pool',
    smartConsensus: true,
    minPayout: 1.3,
    maxPayout: 1.45
  },
  {
    name: 'Pure Crowd Fade (bet on higher payout)',
    crowdFade: true,
    minPayout: 1.5
  },
  {
    name: 'Extreme Crowd Fade (payout >1.7x)',
    crowdFade: true,
    minPayout: 1.7
  },
  {
    name: 'Balanced: 50-50 pools only',
    balancedOnly: true,
    minPayout: 1.4,
    maxPayout: 1.6
  }
];

function runStrategy(config) {
  let bankroll = BASE_CONFIG.STARTING_BANKROLL;
  let lastTwoResults = [];
  let wins = 0;
  let losses = 0;
  let skipped = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];

    const bullWei = parseFloat(r.t20s_bull_wei) / 1e18;
    const bearWei = parseFloat(r.t20s_bear_wei) / 1e18;
    const total = bullWei + bearWei;
    if (total === 0) continue;

    const bullPayout = (total * 0.97) / bullWei;
    const bearPayout = (total * 0.97) / bearWei;

    let signal = null;

    // CONTRARIAN (baseline)
    if (config.contrarian && config.useEMA) {
      const emaSignal = r.ema_signal;
      if (!emaSignal || emaSignal === 'NEUTRAL') continue;

      if (emaSignal === 'BULL' && bearPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BULL';
      } else if (emaSignal === 'BEAR' && bullPayout >= BASE_CONFIG.MIN_PAYOUT) {
        signal = 'BEAR';
      }
    }

    // CONSENSUS (bet with EMA and WITH crowd)
    if (config.consensus && config.useEMA) {
      const emaSignal = r.ema_signal;
      if (!emaSignal || emaSignal === 'NEUTRAL') continue;

      const maxPayout = config.maxPayout || 999;

      // EMA says BULL and crowd is bullish (bull payout is LOW)
      if (emaSignal === 'BULL' && bullPayout < maxPayout) {
        signal = 'BULL';
      }
      // EMA says BEAR and crowd is bearish (bear payout is LOW)
      else if (emaSignal === 'BEAR' && bearPayout < maxPayout) {
        signal = 'BEAR';
      }
    }

    // FOLLOW THE HERD (no EMA, just bet on lower payout)
    if (config.followHerd) {
      if (bullPayout < bearPayout) {
        signal = 'BULL';
      } else {
        signal = 'BEAR';
      }
    }

    // SMART CONSENSUS (EMA + crowd agree + balanced)
    if (config.smartConsensus) {
      const emaSignal = r.ema_signal;
      if (!emaSignal || emaSignal === 'NEUTRAL') continue;

      // EMA BULL + crowd bullish (low bull payout) + not too skewed
      if (emaSignal === 'BULL' && bullPayout >= config.minPayout && bullPayout <= config.maxPayout) {
        signal = 'BULL';
      }
      // EMA BEAR + crowd bearish (low bear payout) + not too skewed
      else if (emaSignal === 'BEAR' && bearPayout >= config.minPayout && bearPayout <= config.maxPayout) {
        signal = 'BEAR';
      }
    }

    // CROWD FADE (bet against extreme crowd)
    if (config.crowdFade) {
      if (bullPayout >= config.minPayout) {
        signal = 'BULL';
      } else if (bearPayout >= config.minPayout) {
        signal = 'BEAR';
      }
    }

    // BALANCED ONLY
    if (config.balancedOnly) {
      if (bullPayout >= config.minPayout && bullPayout <= config.maxPayout) {
        signal = 'BULL';
      } else if (bearPayout >= config.minPayout && bearPayout <= config.maxPayout) {
        signal = 'BEAR';
      }
    }

    if (!signal) {
      skipped++;
      continue;
    }

    // Position sizing
    let sizeMultiplier = 1.0;
    const emaGap = parseFloat(r.ema_gap) || 0;
    const hasStrongSignal = Math.abs(emaGap) >= 0.15;

    if (hasStrongSignal) {
      sizeMultiplier = BASE_CONFIG.MOMENTUM_MULTIPLIER;
    }

    if (lastTwoResults.length === 2 && lastTwoResults.every(r => !r)) {
      sizeMultiplier *= BASE_CONFIG.RECOVERY_MULTIPLIER;
    }

    const betSize = bankroll * BASE_CONFIG.BASE_POSITION_SIZE * sizeMultiplier;
    if (betSize > bankroll) continue;

    const actualPayout = parseFloat(r.winner_payout_multiple);
    const won = signal.toLowerCase() === r.winner.toLowerCase();

    if (won) {
      const profit = betSize * (actualPayout - 1);
      bankroll += profit;
      wins++;
    } else {
      bankroll -= betSize;
      losses++;
    }

    lastTwoResults.push(won);
    if (lastTwoResults.length > 2) lastTwoResults.shift();
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const roi = ((bankroll - BASE_CONFIG.STARTING_BANKROLL) / BASE_CONFIG.STARTING_BANKROLL) * 100;

  return {
    trades: totalTrades,
    wins,
    losses,
    winRate,
    roi,
    bankroll,
    skipped
  };
}

console.log('Running tests...\n\n');

const results = strategies.map(strategy => ({
  ...strategy,
  ...runStrategy(strategy)
}));

// Sort by ROI
results.sort((a, b) => b.roi - a.roi);

console.log('═'.repeat(100) + '\n');
console.log('📊 CONSENSUS BETTING TEST RESULTS\n');
console.log('═'.repeat(100) + '\n\n');

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;

  console.log(`${rank} ${r.name}`);
  console.log(`   Trades: ${r.trades} | Win Rate: ${r.winRate.toFixed(1)}% | ROI: ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}%`);
  console.log(`   Final Bankroll: ${r.bankroll.toFixed(3)} BNB`);
  if (r.skipped > 0) {
    console.log(`   Skipped: ${r.skipped} rounds (no signal)`);
  }
  console.log();
}

console.log('═'.repeat(100) + '\n');

const baseline = results.find(r => r.contrarian);
const best = results[0];

console.log('📈 SUMMARY:\n');
console.log(`Baseline (Contrarian): ${baseline.trades} trades, ${baseline.winRate.toFixed(1)}% WR, ${baseline.roi >= 0 ? '+' : ''}${baseline.roi.toFixed(2)}% ROI\n`);

if (best.roi > baseline.roi) {
  console.log(`✅ CONSENSUS BEATS CONTRARIAN!`);
  console.log(`   Best: ${best.name}`);
  console.log(`   Improvement: ${(best.roi - baseline.roi).toFixed(2)}% ROI`);
  console.log(`   Win Rate: ${best.winRate.toFixed(1)}% vs ${baseline.winRate.toFixed(1)}%`);
  console.log(`   ${best.trades} trades vs ${baseline.trades} trades\n`);
} else {
  console.log(`❌ CONTRARIAN STILL BETTER THAN CONSENSUS`);
  console.log(`   Best consensus: ${best.name} (${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(2)}% ROI)\n`);
}

console.log('═'.repeat(100));

db.close();
