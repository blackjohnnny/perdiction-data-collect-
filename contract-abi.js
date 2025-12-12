/**
 * PancakeSwap Prediction V2 Contract ABI
 * Only includes events and functions we need for monitoring
 */

export const PREDICTION_CONTRACT_ADDRESS = '0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA';

export const PREDICTION_ABI = [
  // Events
  'event StartRound(uint256 indexed epoch)',
  'event LockRound(uint256 indexed epoch, uint256 indexed roundId, int256 price)',
  'event EndRound(uint256 indexed epoch, uint256 indexed roundId, int256 price)',
  'event BetBull(address indexed sender, uint256 indexed epoch, uint256 amount)',
  'event BetBear(address indexed sender, uint256 indexed epoch, uint256 amount)',

  // View functions
  'function currentEpoch() view returns (uint256)',
  'function rounds(uint256 epoch) view returns (uint256 epoch, uint256 startTimestamp, uint256 lockTimestamp, uint256 closeTimestamp, int256 lockPrice, int256 closePrice, uint256 lockOracleId, uint256 closeOracleId, uint256 totalAmount, uint256 bullAmount, uint256 bearAmount, uint256 rewardBaseCalAmount, uint256 rewardAmount, bool oracleCalled)',
  'function ledger(uint256 epoch, address user) view returns (uint8 position, uint256 amount, bool claimed)',
  'function claimable(uint256 epoch, address user) view returns (bool)',
  'function refundable(uint256 epoch, address user) view returns (bool)'
];

/**
 * Parse round data from contract response
 */
export function parseRoundData(roundData) {
  return {
    epoch: roundData.epoch.toString(),
    startTimestamp: Number(roundData.startTimestamp),
    lockTimestamp: Number(roundData.lockTimestamp),
    closeTimestamp: Number(roundData.closeTimestamp),
    lockPrice: roundData.lockPrice.toString(),
    closePrice: roundData.closePrice.toString(),
    lockOracleId: roundData.lockOracleId.toString(),
    closeOracleId: roundData.closeOracleId.toString(),
    totalAmount: roundData.totalAmount.toString(),
    bullAmount: roundData.bullAmount.toString(),
    bearAmount: roundData.bearAmount.toString(),
    rewardBaseCalAmount: roundData.rewardBaseCalAmount.toString(),
    rewardAmount: roundData.rewardAmount.toString(),
    oracleCalled: roundData.oracleCalled
  };
}

/**
 * Determine winner and calculate payout multiple
 */
export function calculateWinner(lockPrice, closePrice, bullAmount, bearAmount) {
  const lock = BigInt(lockPrice);
  const close = BigInt(closePrice);
  const bull = BigInt(bullAmount);
  const bear = BigInt(bearAmount);
  const total = bull + bear;

  if (total === 0n) {
    return { winner: 'draw', payoutMultiple: 0 };
  }

  if (close > lock) {
    // Bull wins
    const payoutMultiple = bull > 0n ? Number(total * 10000n / bull) / 10000 : 0;
    return { winner: 'bull', payoutMultiple };
  } else if (close < lock) {
    // Bear wins
    const payoutMultiple = bear > 0n ? Number(total * 10000n / bear) / 10000 : 0;
    return { winner: 'bear', payoutMultiple };
  } else {
    // Draw (extremely rare)
    return { winner: 'draw', payoutMultiple: 1 };
  }
}
