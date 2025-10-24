import { createPublicClient, http, type Address } from 'viem';
import { bsc } from 'viem/chains';
import { config } from './config.js';
import predictionAbi from './abi/prediction.json' with { type: 'json' };

export type RoundData = {
  epoch: bigint;
  startTimestamp: bigint;
  lockTimestamp: bigint;
  closeTimestamp: bigint;
  lockPrice: bigint;
  closePrice: bigint;
  lockOracleId: bigint;
  closeOracleId: bigint;
  totalAmount: bigint;
  bullAmount: bigint;
  bearAmount: bigint;
  rewardBaseCalAmount: bigint;
  rewardAmount: bigint;
  oracleCalled: boolean;
};

export const publicClient = createPublicClient({
  chain: bsc,
  transport: http(config.bscRpc, {
    timeout: 30_000,
    retryCount: 3,
    retryDelay: 1000,
  }),
});

export async function getCurrentEpoch(): Promise<bigint> {
  const result = await publicClient.readContract({
    address: config.predictionContractAddress,
    abi: predictionAbi,
    functionName: 'currentEpoch',
  });
  return result as bigint;
}

export async function getRound(epoch: bigint): Promise<RoundData> {
  const result = await publicClient.readContract({
    address: config.predictionContractAddress,
    abi: predictionAbi,
    functionName: 'rounds',
    args: [epoch],
  });

  const round = result as any;

  return {
    epoch: round.epoch ?? round[0],
    startTimestamp: round.startTimestamp ?? round[1],
    lockTimestamp: round.lockTimestamp ?? round[2],
    closeTimestamp: round.closeTimestamp ?? round[3],
    lockPrice: round.lockPrice ?? round[4],
    closePrice: round.closePrice ?? round[5],
    lockOracleId: round.lockOracleId ?? round[6],
    closeOracleId: round.closeOracleId ?? round[7],
    totalAmount: round.totalAmount ?? round[8],
    bullAmount: round.bullAmount ?? round[9],
    bearAmount: round.bearAmount ?? round[10],
    rewardBaseCalAmount: round.rewardBaseCalAmount ?? round[11],
    rewardAmount: round.rewardAmount ?? round[12],
    oracleCalled: round.oracleCalled ?? round[13],
  };
}

export async function getTreasuryFee(): Promise<bigint> {
  const result = await publicClient.readContract({
    address: config.predictionContractAddress,
    abi: predictionAbi,
    functionName: 'treasuryFee',
  });
  return result as bigint;
}

export type Winner = 'UP' | 'DOWN' | 'DRAW' | 'UNKNOWN';

export function determineWinner(round: RoundData): Winner {
  if (!round.oracleCalled) {
    return 'UNKNOWN';
  }

  if (round.closePrice > round.lockPrice) {
    return 'UP';
  } else if (round.closePrice < round.lockPrice) {
    return 'DOWN';
  } else {
    return 'DRAW';
  }
}

export function calculateWinnerMultiple(round: RoundData): number | null {
  if (!round.oracleCalled) {
    return null;
  }

  const winner = determineWinner(round);
  if (winner === 'DRAW' || winner === 'UNKNOWN') {
    return null;
  }

  if (round.rewardBaseCalAmount === 0n) {
    return null;
  }

  // Convert to number for float division
  const rewardAmount = Number(round.rewardAmount);
  const rewardBaseCalAmount = Number(round.rewardBaseCalAmount);

  return rewardAmount / rewardBaseCalAmount;
}

export function calculateImpliedMultiples(
  totalAmount: bigint,
  bullAmount: bigint,
  bearAmount: bigint
): { impliedUp: number | null; impliedDown: number | null } {
  const total = Number(totalAmount);
  const bull = Number(bullAmount);
  const bear = Number(bearAmount);

  return {
    impliedUp: bull > 0 ? total / bull : null,
    impliedDown: bear > 0 ? total / bear : null,
  };
}

export function formatWei(wei: bigint): string {
  const bnb = Number(wei) / 1e18;
  return bnb.toFixed(6);
}
