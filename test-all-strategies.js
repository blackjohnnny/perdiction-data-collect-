import { initDatabase } from './db-init.js';

// Use simple mock EMA signals that change over time
function getEMASignalForRound(roundIndex, totalRounds) {
  // Alternate signals throughout dataset
  const cyclePosition = roundIndex / totalRounds;

  if (cyclePosition < 0.25) return { signal: 'BULL', gap: 0.08 };
  if (cyclePosition < 0.5) return { signal: 'BEAR', gap: 0.06 };
  if (cyclePosition < 0.75) return { signal: 'BULL', gap: 0.07 };
  return { signal: 'BEAR', gap: 0.05 };
}

// ORIGINAL STRATEGY: Bet WITH crowd when indicators align
function shouldTradeOriginal(signal, bullPercent, bearPercent) {
  if (!signal) return null;

  const { signal: emaDirection } = signal;

  // Bet WITH crowd when crowd ≥65% AND EMA confirms same direction
  if (emaDirection === 'BULL' && bullPercent >= 65) {
    return 'BULL'; // Crowd bullish + EMA bullish → Bet BULL (trend following)
  }

  if (emaDirection === 'BEAR' && bearPercent >= 65) {
    return 'BEAR'; // Crowd bearish + EMA bearish → Bet BEAR (trend following)
  }

  return null;
}

// REVERSE STRATEGY: Bet OPPOSITE direction on same conditions
function shouldTradeReverse(signal, bullPercent, bearPercent) {
  if (!signal) return null;

  const { signal: emaDirection } = signal;

  // Bet OPPOSITE when conditions align
  if (emaDirection === 'BULL' && bullPercent >= 65) {
    return 'BEAR'; // Original would bet BULL → Reverse bets BEAR
  }

  if (emaDirection === 'BEAR' && bearPercent >= 65) {
    return 'BULL'; // Original would bet BEAR → Reverse bets BULL
  }

  return null;
}

// Calculate payout multiple
function calculatePayout(betSide, bullWei, bearWei) {
  const bullAmount = parseFloat(bullWei) / 1e18;
  const bearAmount = parseFloat(bearWei) / 1e18;
  const totalPool = bullAmount + bearAmount;

  if (totalPool === 0) return 1.0;

  const HOUSE_EDGE = 0.03;
  const netPool = totalPool * (1 - HOUSE_EDGE);

  if (betSide === 'BULL') {
    return bullAmount === 0 ? 1.0 : netPool / bullAmount;
  } else {
    return bearAmount === 0 ? 1.0 : netPool / bearAmount;
  }
}

// Dynamic position sizing
function calculateBetSize(bankroll, mode, lastTwoResults) {
  const basePercent = mode === 'safe' ? 4.5 : 6.5;
  let multiplier = 1.0;

  const [prev1, prev2] = lastTwoResults;

  if (prev1 === 'loss' && prev2 === 'win') {
    multiplier = 1.5; // Recovery mode
  }

  if (prev1 === 'win' && prev2 === 'win') {
    multiplier = 0.75; // Profit-taking mode
  }

  return bankroll * (basePercent / 100) * multiplier;
}

// Backtest
function backtest() {
  const db = initDatabase();

  const rounds = db.prepare(`
    SELECT * FROM rounds
    WHERE is_complete = 1
    AND t20s_bull_wei IS NOT NULL
    AND t20s_bear_wei IS NOT NULL
    ORDER BY sample_id ASC
  `).all();

  console.log(`\n📊 Testing CORRECTED strategies on ${rounds.length} rounds\n`);

  // Test both strategies
  const strategies = [
    { name: 'ORIGINAL (Trend Following - Bet WITH Crowd)', fn: shouldTradeOriginal },
    { name: 'REVERSE (Contrarian - Bet AGAINST Crowd)', fn: shouldTradeReverse }
  ];

  for (const strategy of strategies) {
    let bankroll = 1.0;
    let totalTrades = 0;
    let wins = 0;
    let losses = 0;
    let totalProfit = 0;
    const recentResults = [];

    for (let i = 0; i < rounds.length; i++) {
      const round = rounds[i];
      const signal = getEMASignalForRound(i, rounds.length);

      const bullWei = round.t20s_bull_wei;
      const bearWei = round.t20s_bear_wei;
      const bullAmount = parseFloat(bullWei) / 1e18;
      const bearAmount = parseFloat(bearWei) / 1e18;
      const totalPool = bullAmount + bearAmount;

      if (totalPool === 0) continue;

      const bullPercent = (bullAmount / totalPool) * 100;
      const bearPercent = (bearAmount / totalPool) * 100;

      const betSide = strategy.fn(signal, bullPercent, bearPercent);

      if (!betSide) continue;

      const payout = calculatePayout(betSide, bullWei, bearWei);

      const betSize = calculateBetSize(bankroll, 'normal', recentResults.slice(-2));

      const won = betSide.toLowerCase() === round.winner;

      totalTrades++;

      if (won) {
        const profit = betSize * (payout - 1);
        bankroll += profit;
        totalProfit += profit;
        wins++;
        recentResults.push('win');
      } else {
        bankroll -= betSize;
        totalProfit -= betSize;
        losses++;
        recentResults.push('loss');
      }

      if (recentResults.length > 2) recentResults.shift();
    }

    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const roi = ((bankroll - 1.0) / 1.0) * 100;

    console.log(`\n${strategy.name}:`);
    console.log(`├─ Trades: ${totalTrades}`);
    console.log(`├─ Wins: ${wins} | Losses: ${losses}`);
    console.log(`├─ Win Rate: ${winRate.toFixed(2)}%`);
    console.log(`├─ Final Bankroll: ${bankroll.toFixed(4)} BNB`);
    console.log(`├─ Total Profit: ${totalProfit.toFixed(4)} BNB`);
    console.log(`└─ ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`);
  }

  db.close();
}

backtest();
