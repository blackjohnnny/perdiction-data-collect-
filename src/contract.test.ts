import { describe, it, expect } from 'vitest';
import { determineWinner, calculateWinnerMultiple, calculateImpliedMultiples, type RoundData } from './contract.js';

describe('determineWinner', () => {
  const baseRound: RoundData = {
    epoch: 1000n,
    startTimestamp: 1000000n,
    lockTimestamp: 1000300n,
    closeTimestamp: 1000600n,
    lockPrice: 0n,
    closePrice: 0n,
    lockOracleId: 0n,
    closeOracleId: 0n,
    totalAmount: 10000000000000000000n, // 10 BNB
    bullAmount: 6000000000000000000n, // 6 BNB
    bearAmount: 4000000000000000000n, // 4 BNB
    rewardBaseCalAmount: 4000000000000000000n,
    rewardAmount: 9700000000000000000n, // 9.7 BNB (3% fee)
    oracleCalled: true,
  };

  it('should return UNKNOWN when oracle not called', () => {
    const round = { ...baseRound, oracleCalled: false };
    expect(determineWinner(round)).toBe('UNKNOWN');
  });

  it('should return UP when closePrice > lockPrice', () => {
    const round = {
      ...baseRound,
      lockPrice: 30000000000n,
      closePrice: 30100000000n,
    };
    expect(determineWinner(round)).toBe('UP');
  });

  it('should return DOWN when closePrice < lockPrice', () => {
    const round = {
      ...baseRound,
      lockPrice: 30000000000n,
      closePrice: 29900000000n,
    };
    expect(determineWinner(round)).toBe('DOWN');
  });

  it('should return DRAW when closePrice == lockPrice', () => {
    const round = {
      ...baseRound,
      lockPrice: 30000000000n,
      closePrice: 30000000000n,
    };
    expect(determineWinner(round)).toBe('DRAW');
  });
});

describe('calculateWinnerMultiple', () => {
  const baseRound: RoundData = {
    epoch: 1000n,
    startTimestamp: 1000000n,
    lockTimestamp: 1000300n,
    closeTimestamp: 1000600n,
    lockPrice: 30000000000n,
    closePrice: 30100000000n, // UP wins
    lockOracleId: 0n,
    closeOracleId: 0n,
    totalAmount: 10000000000000000000n, // 10 BNB
    bullAmount: 6000000000000000000n, // 6 BNB
    bearAmount: 4000000000000000000n, // 4 BNB
    rewardBaseCalAmount: 6000000000000000000n, // bullAmount (UP won)
    rewardAmount: 9700000000000000000n, // 9.7 BNB (3% treasury fee)
    oracleCalled: true,
  };

  it('should return null when oracle not called', () => {
    const round = { ...baseRound, oracleCalled: false };
    expect(calculateWinnerMultiple(round)).toBeNull();
  });

  it('should calculate correct multiple for UP win', () => {
    const round = baseRound;
    const multiple = calculateWinnerMultiple(round);
    expect(multiple).not.toBeNull();
    expect(multiple).toBeCloseTo(9.7 / 6, 5); // ~1.617
  });

  it('should calculate correct multiple for DOWN win', () => {
    const round = {
      ...baseRound,
      lockPrice: 30000000000n,
      closePrice: 29900000000n, // DOWN wins
      rewardBaseCalAmount: 4000000000000000000n, // bearAmount
      rewardAmount: 9700000000000000000n, // 9.7 BNB
    };
    const multiple = calculateWinnerMultiple(round);
    expect(multiple).not.toBeNull();
    expect(multiple).toBeCloseTo(9.7 / 4, 5); // ~2.425
  });

  it('should return null for DRAW', () => {
    const round = {
      ...baseRound,
      lockPrice: 30000000000n,
      closePrice: 30000000000n, // DRAW
      rewardBaseCalAmount: 0n,
      rewardAmount: 0n,
    };
    expect(calculateWinnerMultiple(round)).toBeNull();
  });

  it('should return null when rewardBaseCalAmount is zero', () => {
    const round = {
      ...baseRound,
      rewardBaseCalAmount: 0n,
    };
    expect(calculateWinnerMultiple(round)).toBeNull();
  });

  it('should handle very small amounts correctly', () => {
    const round = {
      ...baseRound,
      totalAmount: 1000000n,
      bullAmount: 600000n,
      bearAmount: 400000n,
      rewardBaseCalAmount: 600000n,
      rewardAmount: 970000n,
    };
    const multiple = calculateWinnerMultiple(round);
    expect(multiple).not.toBeNull();
    expect(multiple).toBeCloseTo(970000 / 600000, 5);
  });
});

describe('calculateImpliedMultiples', () => {
  it('should calculate correct implied multiples', () => {
    const totalAmount = 10000000000000000000n; // 10 BNB
    const bullAmount = 6000000000000000000n; // 6 BNB
    const bearAmount = 4000000000000000000n; // 4 BNB

    const { impliedUp, impliedDown } = calculateImpliedMultiples(totalAmount, bullAmount, bearAmount);

    expect(impliedUp).not.toBeNull();
    expect(impliedDown).not.toBeNull();
    expect(impliedUp).toBeCloseTo(10 / 6, 5); // ~1.667
    expect(impliedDown).toBeCloseTo(10 / 4, 5); // 2.5
  });

  it('should return null for impliedUp when bullAmount is zero', () => {
    const totalAmount = 10000000000000000000n;
    const bullAmount = 0n;
    const bearAmount = 10000000000000000000n;

    const { impliedUp, impliedDown } = calculateImpliedMultiples(totalAmount, bullAmount, bearAmount);

    expect(impliedUp).toBeNull();
    expect(impliedDown).toBeCloseTo(1, 5);
  });

  it('should return null for impliedDown when bearAmount is zero', () => {
    const totalAmount = 10000000000000000000n;
    const bullAmount = 10000000000000000000n;
    const bearAmount = 0n;

    const { impliedUp, impliedDown } = calculateImpliedMultiples(totalAmount, bullAmount, bearAmount);

    expect(impliedUp).toBeCloseTo(1, 5);
    expect(impliedDown).toBeNull();
  });

  it('should handle both amounts being zero', () => {
    const totalAmount = 10000000000000000000n;
    const bullAmount = 0n;
    const bearAmount = 0n;

    const { impliedUp, impliedDown } = calculateImpliedMultiples(totalAmount, bullAmount, bearAmount);

    expect(impliedUp).toBeNull();
    expect(impliedDown).toBeNull();
  });

  it('should handle zero total amount', () => {
    const totalAmount = 0n;
    const bullAmount = 6000000000000000000n;
    const bearAmount = 4000000000000000000n;

    const { impliedUp, impliedDown } = calculateImpliedMultiples(totalAmount, bullAmount, bearAmount);

    expect(impliedUp).toBe(0);
    expect(impliedDown).toBe(0);
  });
});
