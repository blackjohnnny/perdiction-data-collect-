import { getDb } from '../store/sqlite.js';

interface Round {
  epoch: number;
  lock_ts: number;
  winner: string;
}

interface PatternStats {
  pattern: string;
  count: number;
  percentage: number;
  nextOutcome: {
    UP: number;
    DOWN: number;
    upPercent: number;
    downPercent: number;
  };
}

interface PatternAnalysisResult {
  totalRounds: number;
  daysAnalyzed: number;
  patterns: {
    length2: PatternStats[];
    length3: PatternStats[];
    length4: PatternStats[];
    length5: PatternStats[];
  };
}

function findPatterns(rounds: Round[], patternLength: number): Map<string, { count: number; nextUp: number; nextDown: number }> {
  const patterns = new Map<string, { count: number; nextUp: number; nextDown: number }>();

  for (let i = 0; i <= rounds.length - patternLength - 1; i++) {
    // Get pattern (e.g., "UP DOWN UP")
    const pattern = rounds
      .slice(i, i + patternLength)
      .map(r => r.winner)
      .join(' ');

    // Get next outcome
    const nextRound = rounds[i + patternLength];
    if (!nextRound) continue;

    if (!patterns.has(pattern)) {
      patterns.set(pattern, { count: 0, nextUp: 0, nextDown: 0 });
    }

    const stats = patterns.get(pattern)!;
    stats.count++;

    if (nextRound.winner === 'UP') {
      stats.nextUp++;
    } else if (nextRound.winner === 'DOWN') {
      stats.nextDown++;
    }
  }

  return patterns;
}

export async function analyzePatternSequences(daysBack: number = 90): Promise<PatternAnalysisResult> {
  const db = await getDb();

  // Get rounds from last N days
  const nowTs = Math.floor(Date.now() / 1000);
  const startTs = nowTs - (daysBack * 24 * 60 * 60);

  const rows = db.exec(`
    SELECT
      epoch,
      lock_ts,
      winner
    FROM rounds
    WHERE winner IN ('UP', 'DOWN')
      AND lock_ts >= ${startTs}
    ORDER BY epoch ASC
  `);

  if (rows.length === 0 || rows[0].values.length === 0) {
    throw new Error('No rounds found in the specified time range');
  }

  const rounds: Round[] = rows[0].values.map((row: any) => ({
    epoch: row[0] as number,
    lock_ts: row[1] as number,
    winner: row[2] as string,
  }));

  // Analyze patterns of different lengths
  const result: PatternAnalysisResult = {
    totalRounds: rounds.length,
    daysAnalyzed: daysBack,
    patterns: {
      length2: [],
      length3: [],
      length4: [],
      length5: [],
    },
  };

  // Pattern length 2 (e.g., "UP UP")
  const patterns2 = findPatterns(rounds, 2);
  patterns2.forEach((stats, pattern) => {
    const total = stats.nextUp + stats.nextDown;
    if (total > 0) {
      result.patterns.length2.push({
        pattern,
        count: stats.count,
        percentage: (stats.count / (rounds.length - 2)) * 100,
        nextOutcome: {
          UP: stats.nextUp,
          DOWN: stats.nextDown,
          upPercent: (stats.nextUp / total) * 100,
          downPercent: (stats.nextDown / total) * 100,
        },
      });
    }
  });

  // Pattern length 3 (e.g., "UP UP DOWN")
  const patterns3 = findPatterns(rounds, 3);
  patterns3.forEach((stats, pattern) => {
    const total = stats.nextUp + stats.nextDown;
    if (total > 0) {
      result.patterns.length3.push({
        pattern,
        count: stats.count,
        percentage: (stats.count / (rounds.length - 3)) * 100,
        nextOutcome: {
          UP: stats.nextUp,
          DOWN: stats.nextDown,
          upPercent: (stats.nextUp / total) * 100,
          downPercent: (stats.nextDown / total) * 100,
        },
      });
    }
  });

  // Pattern length 4 (e.g., "UP UP DOWN DOWN")
  const patterns4 = findPatterns(rounds, 4);
  patterns4.forEach((stats, pattern) => {
    const total = stats.nextUp + stats.nextDown;
    if (total > 0) {
      result.patterns.length4.push({
        pattern,
        count: stats.count,
        percentage: (stats.count / (rounds.length - 4)) * 100,
        nextOutcome: {
          UP: stats.nextUp,
          DOWN: stats.nextDown,
          upPercent: (stats.nextUp / total) * 100,
          downPercent: (stats.nextDown / total) * 100,
        },
      });
    }
  });

  // Pattern length 5 (e.g., "UP UP DOWN DOWN UP")
  const patterns5 = findPatterns(rounds, 5);
  patterns5.forEach((stats, pattern) => {
    const total = stats.nextUp + stats.nextDown;
    if (total > 0) {
      result.patterns.length5.push({
        pattern,
        count: stats.count,
        percentage: (stats.count / (rounds.length - 5)) * 100,
        nextOutcome: {
          UP: stats.nextUp,
          DOWN: stats.nextDown,
          upPercent: (stats.nextUp / total) * 100,
          downPercent: (stats.nextDown / total) * 100,
        },
      });
    }
  });

  // Sort by count (most common first)
  result.patterns.length2.sort((a, b) => b.count - a.count);
  result.patterns.length3.sort((a, b) => b.count - a.count);
  result.patterns.length4.sort((a, b) => b.count - a.count);
  result.patterns.length5.sort((a, b) => b.count - a.count);

  return result;
}

export function formatPatternAnalysis(result: PatternAnalysisResult): string {
  let output = '';

  output += '═══════════════════════════════════════════════════════════════\n';
  output += `         PATTERN SEQUENCE ANALYSIS (LAST ${result.daysAnalyzed} DAYS)\n`;
  output += '═══════════════════════════════════════════════════════════════\n\n';

  output += `📊 ANALYZED ${result.totalRounds.toLocaleString()} rounds over ${result.daysAnalyzed} days\n\n`;

  // 2-length patterns
  output += '═══════════════════════════════════════════════════════════════\n';
  output += '📌 2-ROUND PATTERNS (e.g., "UP UP")\n';
  output += '═══════════════════════════════════════════════════════════════\n\n';
  result.patterns.length2.forEach((p, idx) => {
    const predictability = Math.abs(p.nextOutcome.upPercent - 50);
    const isPredictable = predictability > 5 ? '⚠️ ' : '';
    output += `${idx + 1}. ${isPredictable}Pattern: "${p.pattern}"\n`;
    output += `   Occurred: ${p.count} times (${p.percentage.toFixed(2)}%)\n`;
    output += `   Next outcome: ${p.nextOutcome.UP} UP (${p.nextOutcome.upPercent.toFixed(1)}%) | ${p.nextOutcome.DOWN} DOWN (${p.nextOutcome.downPercent.toFixed(1)}%)\n`;
    if (predictability > 5) {
      const likely = p.nextOutcome.upPercent > 50 ? 'UP' : 'DOWN';
      output += `   ⚠️  After "${p.pattern}", next is more likely ${likely}\n`;
    }
    output += '\n';
  });

  // 3-length patterns
  output += '═══════════════════════════════════════════════════════════════\n';
  output += '📌 3-ROUND PATTERNS (e.g., "UP UP DOWN") - ALL PATTERNS\n';
  output += '═══════════════════════════════════════════════════════════════\n\n';
  result.patterns.length3.forEach((p, idx) => {
    const predictability = Math.abs(p.nextOutcome.upPercent - 50);
    const isPredictable = predictability > 5 ? '⚠️ ' : '';
    output += `${idx + 1}. ${isPredictable}Pattern: "${p.pattern}"\n`;
    output += `   Occurred: ${p.count} times (${p.percentage.toFixed(2)}%)\n`;
    output += `   Next outcome: ${p.nextOutcome.UP} UP (${p.nextOutcome.upPercent.toFixed(1)}%) | ${p.nextOutcome.DOWN} DOWN (${p.nextOutcome.downPercent.toFixed(1)}%)\n`;
    if (predictability > 5) {
      const likely = p.nextOutcome.upPercent > 50 ? 'UP' : 'DOWN';
      output += `   ⚠️  After "${p.pattern}", next is more likely ${likely}\n`;
    }
    output += '\n';
  });

  // 4-length patterns
  output += '═══════════════════════════════════════════════════════════════\n';
  output += '📌 4-ROUND PATTERNS - ALL PATTERNS\n';
  output += '═══════════════════════════════════════════════════════════════\n\n';
  result.patterns.length4.forEach((p, idx) => {
    const predictability = Math.abs(p.nextOutcome.upPercent - 50);
    const isPredictable = predictability > 5 ? '⚠️ ' : '';
    output += `${idx + 1}. ${isPredictable}Pattern: "${p.pattern}"\n`;
    output += `   Occurred: ${p.count} times (${p.percentage.toFixed(2)}%)\n`;
    output += `   Next outcome: ${p.nextOutcome.UP} UP (${p.nextOutcome.upPercent.toFixed(1)}%) | ${p.nextOutcome.DOWN} DOWN (${p.nextOutcome.downPercent.toFixed(1)}%)\n`;
    if (predictability > 5) {
      const likely = p.nextOutcome.upPercent > 50 ? 'UP' : 'DOWN';
      output += `   ⚠️  After "${p.pattern}", next is more likely ${likely}\n`;
    }
    output += '\n';
  });

  // Most predictable patterns (any length)
  output += '═══════════════════════════════════════════════════════════════\n';
  output += '🎯 MOST PREDICTABLE PATTERNS (>55% bias)\n';
  output += '═══════════════════════════════════════════════════════════════\n\n';

  const allPatterns = [
    ...result.patterns.length2,
    ...result.patterns.length3,
    ...result.patterns.length4,
  ].filter(p => {
    const bias = Math.max(p.nextOutcome.upPercent, p.nextOutcome.downPercent);
    return bias > 55 && p.count >= 10; // At least 10 occurrences
  }).sort((a, b) => {
    const biasA = Math.max(a.nextOutcome.upPercent, a.nextOutcome.downPercent);
    const biasB = Math.max(b.nextOutcome.upPercent, b.nextOutcome.downPercent);
    return biasB - biasA;
  }).slice(0, 10);

  if (allPatterns.length === 0) {
    output += '   ✅ No significantly predictable patterns found (all close to 50/50)\n';
    output += '   This confirms BNB price movements are random and unpredictable\n\n';
  } else {
    allPatterns.forEach((p, idx) => {
      const likely = p.nextOutcome.upPercent > 50 ? 'UP' : 'DOWN';
      const bias = Math.max(p.nextOutcome.upPercent, p.nextOutcome.downPercent);
      output += `${idx + 1}. Pattern: "${p.pattern}" → ${likely} (${bias.toFixed(1)}%)\n`;
      output += `   Occurred ${p.count} times\n`;
      output += `   Next: ${p.nextOutcome.UP} UP | ${p.nextOutcome.DOWN} DOWN\n\n`;
    });
  }

  output += '═══════════════════════════════════════════════════════════════\n';
  output += '💡 ANALYSIS\n';
  output += '═══════════════════════════════════════════════════════════════\n';
  output += 'If patterns exist, you could bet based on recent history.\n';
  output += 'However, if all patterns hover around 50/50, it confirms\n';
  output += 'BNB price movements are random and past results don\'t predict future.\n';
  output += '═══════════════════════════════════════════════════════════════\n';

  return output;
}
