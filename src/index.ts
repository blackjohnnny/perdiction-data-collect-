#!/usr/bin/env node

import { backfillHistorical } from './pipeline/historical.js';
import { runLiveWatcher } from './pipeline/live.js';
import { exportToCSV, exportRoundsWithHumanReadable, exportRoundsWithDates } from './export/csv.js';
import { getStats, closeDb } from './store/sqlite.js';
import { getCurrentEpoch } from './contract.js';
import { analyzeData, formatStatistics } from './analysis/statistics.js';
import { analyzeMonthlyData, formatMonthlyStatistics } from './analysis/monthly.js';
import { analyzeDetailedMonth, formatDetailedMonthStatistics } from './analysis/detailed-month.js';
import { analyzeTimeAndProfitability, formatTimeAndProfitability } from './analysis/time-profitability.js';
import { analyzeStrategies, formatStrategyAnalysis } from './analysis/strategies.js';
import { analyzeOctoberHourly, formatOctoberHourly } from './analysis/october-hourly.js';
import { analyzePoolVolatility, formatVolatilityAnalysis } from './analysis/pool-volatility-filter.js';
import { analyzeTrendStrategies, formatTrendAnalysis } from './analysis/trend-strategies.js';
import { analyzeOctoberTrends, formatOctoberTrends } from './analysis/october-trends.js';
import { analyzeBothSides, formatBothSidesAnalysis } from './analysis/arbitrage-both-sides.js';
import { analyzeEMAStrategies, formatEMAAnalysis } from './analysis/ema-strategies.js';
import { backTestManualTrades, formatManualTradeResults } from './analysis/manual-ema-backtest.js';
import { analyzePatternSequences, formatPatternAnalysis } from './analysis/pattern-sequences.js';
import { analyzePriceMovementCorrelation, formatPriceMovementCorrelation } from './analysis/price-movement-correlation.js';
import { analyzeAveragePriceMovement, formatAveragePriceMovement } from './analysis/average-price-movement.js';
import { analyzeContrarianStrategy, formatContrarianStrategy } from './analysis/contrarian-strategy.js';
import { analyzePriceChangeTheory } from './analysis/price-change-theory.js';
import { analyzeThreeConsecutiveUps } from './analysis/three-up-pattern.js';
import { analyzeAdvancedPatterns } from './analysis/advanced-patterns.js';
import { analyzeTrendPeriods } from './analysis/trend-periods.js';

type Command = 'backfill' | 'live' | 'export' | 'stats' | 'analyze' | 'monthly' | 'detailed' | 'profitability' | 'strategies' | 'october-hourly' | 'volatility' | 'trends' | 'october-trends' | 'arbitrage' | 'ema' | 'manual-ema' | 'patterns' | 'price-correlation' | 'avg-movement' | 'contrarian' | 'price-theory' | 'three-up' | 'advanced' | 'trend-periods' | 'help';

function parseArgs(args: string[]): {
  command: Command;
  options: Record<string, string | boolean>;
} {
  const command = (args[0] || 'help') as Command;
  const options: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];

      if (nextArg && !nextArg.startsWith('--')) {
        options[key] = nextArg;
        i++;
      } else {
        options[key] = true;
      }
    }
  }

  return { command, options };
}

function printUsage(): void {
  console.log(`
PancakeSwap Prediction V2 Data Collector

Usage:
  pnpm start <command> [options]

Commands:
  backfill    Backfill historical round data
    --from <epoch|latest>   Starting epoch (required)
    --to <epoch|latest>     Ending epoch (required)

    Examples:
      pnpm start backfill --from 423000 --to latest
      pnpm start backfill --from 423000 --to 425000

  live        Run live watcher (captures new rounds + T-20s snapshots)

    Examples:
      pnpm start live

  export      Export data to CSV
    --table <rounds|snapshots>   Table to export (required)
    --out <path>                 Output file path (required)
    --human                      Export rounds with human-readable BNB values

    Examples:
      pnpm start export --table rounds --out rounds.csv
      pnpm start export --table snapshots --out snapshots.csv
      pnpm start export --table rounds --out rounds-human.csv --human

  stats       Show database statistics

    Examples:
      pnpm start stats

  analyze     Perform comprehensive data analysis

    Examples:
      pnpm start analyze

  monthly     Perform monthly breakdown analysis

    Examples:
      pnpm start monthly

  detailed    Perform detailed analysis for a specific month
    --year <YYYY>    Year (required)
    --month <MM>     Month 1-12 (required)

    Examples:
      pnpm start detailed --year 2025 --month 10

  profitability   Analyze time-of-day patterns and betting profitability

    Examples:
      pnpm start profitability

  strategies  Test various betting strategies and find profitable edges

    Examples:
      pnpm start strategies

  help        Show this help message
  `);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, options } = parseArgs(args);

  try {
    switch (command) {
      case 'backfill': {
        const from = options.from as string | undefined;
        const to = options.to as string | undefined;

        if (!from || !to) {
          console.error('Error: --from and --to are required for backfill');
          printUsage();
          process.exit(1);
        }

        const fromEpoch = from === 'latest' ? 'latest' : parseInt(from, 10);
        const toEpoch = to === 'latest' ? 'latest' : parseInt(to, 10);

        if (fromEpoch !== 'latest' && isNaN(fromEpoch)) {
          console.error('Error: --from must be a number or "latest"');
          process.exit(1);
        }

        if (toEpoch !== 'latest' && isNaN(toEpoch)) {
          console.error('Error: --to must be a number or "latest"');
          process.exit(1);
        }

        await backfillHistorical({ from: fromEpoch, to: toEpoch });
        break;
      }

      case 'live': {
        console.log('Starting live watcher... (press Ctrl+C to stop)');
        await runLiveWatcher();
        break;
      }

      case 'export': {
        const table = options.table as string | undefined;
        const out = options.out as string | undefined;
        const human = options.human === true;
        const dates = options.dates === true;

        if (!table || !out) {
          console.error('Error: --table and --out are required for export');
          printUsage();
          process.exit(1);
        }

        if (table !== 'rounds' && table !== 'snapshots') {
          console.error('Error: --table must be "rounds" or "snapshots"');
          process.exit(1);
        }

        if (dates && table === 'rounds') {
          await exportRoundsWithDates(out);
        } else if (human && table === 'rounds') {
          await exportRoundsWithHumanReadable(out);
        } else if ((human || dates) && table === 'snapshots') {
          console.error('Error: --human and --dates are only supported for rounds table');
          process.exit(1);
        } else {
          await exportToCSV(table, out);
        }
        break;
      }

      case 'stats': {
        const stats = await getStats();
        const currentEpoch = await getCurrentEpoch();

        console.log('\n=== Database Statistics ===');
        console.log(`Current on-chain epoch: ${currentEpoch}`);
        console.log(`Total rounds stored:    ${stats.totalRounds}`);
        console.log(`Total snapshots:        ${stats.totalSnapshots}`);
        console.log(`\nWinner breakdown:`);
        console.log(`  UP wins:              ${stats.upWins} (${((stats.upWins / stats.totalRounds) * 100).toFixed(1)}%)`);
        console.log(`  DOWN wins:            ${stats.downWins} (${((stats.downWins / stats.totalRounds) * 100).toFixed(1)}%)`);
        console.log(`  DRAW (house):         ${stats.draws} (${((stats.draws / stats.totalRounds) * 100).toFixed(1)}%)`);
        console.log(`  UNKNOWN (pending):    ${stats.unknown} (${((stats.unknown / stats.totalRounds) * 100).toFixed(1)}%)`);
        console.log('');
        break;
      }

      case 'analyze': {
        console.log('Analyzing data...\n');
        const statistics = await analyzeData();
        const report = formatStatistics(statistics);
        console.log(report);
        break;
      }

      case 'monthly': {
        console.log('Analyzing monthly data...\n');
        const monthlyStats = await analyzeMonthlyData();
        const report = formatMonthlyStatistics(monthlyStats);
        console.log(report);
        break;
      }

      case 'detailed': {
        const year = options.year as string | undefined;
        const month = options.month as string | undefined;

        if (!year || !month) {
          console.error('Error: --year and --month are required for detailed analysis');
          printUsage();
          process.exit(1);
        }

        const yearNum = parseInt(year, 10);
        const monthNum = parseInt(month, 10);

        if (isNaN(yearNum) || isNaN(monthNum)) {
          console.error('Error: --year and --month must be numbers');
          process.exit(1);
        }

        if (monthNum < 1 || monthNum > 12) {
          console.error('Error: --month must be between 1 and 12');
          process.exit(1);
        }

        console.log(`Analyzing detailed data for ${yearNum}-${String(monthNum).padStart(2, '0')}...\n`);
        const detailedStats = await analyzeDetailedMonth(yearNum, monthNum);
        const report = formatDetailedMonthStatistics(detailedStats);
        console.log(report);
        break;
      }

      case 'profitability': {
        console.log('Analyzing time-of-day patterns and betting profitability...\n');
        const profitStats = await analyzeTimeAndProfitability();
        const report = formatTimeAndProfitability(profitStats);
        console.log(report);
        break;
      }

      case 'strategies': {
        console.log('Testing betting strategies for profitable edges...\n');
        const strategyAnalysis = await analyzeStrategies();
        const report = formatStrategyAnalysis(strategyAnalysis);
        console.log(report);
        break;
      }

      case 'october-hourly': {
        console.log('Analyzing October hourly pool sizes...\n');
        const octoberHourly = await analyzeOctoberHourly();
        const report = formatOctoberHourly(octoberHourly);
        console.log(report);
        break;
      }

      case 'volatility': {
        const minPercent = options.min ? parseInt(options.min as string, 10) : 80;
        const maxPercent = options.max ? parseInt(options.max as string, 10) : 150;

        console.log(`Analyzing pool volatility (${minPercent}%-${maxPercent}% filter)...\n`);
        const volatilityAnalysis = await analyzePoolVolatility(minPercent, maxPercent);
        const report = formatVolatilityAnalysis(volatilityAnalysis, minPercent, maxPercent);
        console.log(report);
        break;
      }

      case 'trends': {
        console.log('Analyzing trend-following strategies...\n');
        const trendAnalysis = await analyzeTrendStrategies();
        const report = formatTrendAnalysis(trendAnalysis);
        console.log(report);
        break;
      }

      case 'october-trends': {
        console.log('Analyzing October trend-following strategies...\n');
        const octoberTrends = await analyzeOctoberTrends();
        const report = formatOctoberTrends(octoberTrends);
        console.log(report);
        break;
      }

      case 'arbitrage': {
        console.log('Analyzing "Bet Both Sides" arbitrage strategy...\n');
        const arbitrageResult = await analyzeBothSides();
        const report = formatBothSidesAnalysis(arbitrageResult);
        console.log(report);
        break;
      }

      case 'ema': {
        console.log('Analyzing EMA (20/50) trading strategies...\n');
        const emaResult = await analyzeEMAStrategies();
        const report = formatEMAAnalysis(emaResult);
        console.log(report);
        break;
      }

      case 'manual-ema': {
        // Parse trade parameters from command line
        // Format: --start1 "timestamp/epoch" --end1 "timestamp/epoch" --dir1 "UP/DOWN"
        //         --start2 "timestamp/epoch" --end2 "timestamp/epoch" --dir2 "UP/DOWN"
        const trades: Array<{ startTime: string; endTime: string; direction: 'UP' | 'DOWN' }> = [];

        // Collect all trades (numbered 1, 2, 3, etc.)
        for (let i = 1; i <= 10; i++) {
          const start = options[`start${i}`] as string | undefined;
          const end = options[`end${i}`] as string | undefined;
          const dir = options[`dir${i}`] as string | undefined;

          if (!start || !end || !dir) break;

          if (dir !== 'UP' && dir !== 'DOWN') {
            console.error(`Error: --dir${i} must be "UP" or "DOWN"`);
            process.exit(1);
          }

          trades.push({
            startTime: start,
            endTime: end,
            direction: dir as 'UP' | 'DOWN',
          });
        }

        if (trades.length === 0) {
          console.error('Error: No trades specified. Usage:');
          console.error('  npm start manual-ema --start1 "370000" --end1 "370100" --dir1 "UP"');
          console.error('  npm start manual-ema --start1 "1729000000" --end1 "1729010000" --dir1 "DOWN"');
          console.error('');
          console.error('You can specify multiple trades with --start2, --end2, --dir2, etc.');
          process.exit(1);
        }

        console.log(`Backtesting ${trades.length} manual trade(s)...\n`);
        const results = await backTestManualTrades(trades);
        const report = formatManualTradeResults(results);
        console.log(report);
        break;
      }

      case 'patterns': {
        const days = options.days ? parseInt(options.days as string, 10) : 90;
        console.log(`Analyzing pattern sequences over last ${days} days...\n`);
        const patternResult = await analyzePatternSequences(days);
        const report = formatPatternAnalysis(patternResult);
        console.log(report);
        break;
      }

      case 'price-correlation': {
        const days = options.days ? parseInt(options.days as string, 10) : 30;
        console.log(`Analyzing price movement correlation over last ${days} days...\n`);
        const correlationResult = await analyzePriceMovementCorrelation(days);
        const report = formatPriceMovementCorrelation(correlationResult);
        console.log(report);
        break;
      }

      case 'avg-movement': {
        const days = options.days ? parseInt(options.days as string, 10) : 60;
        console.log(`Analyzing average price movements over last ${days} days...\n`);
        const movementResult = await analyzeAveragePriceMovement(days);
        const report = formatAveragePriceMovement(movementResult);
        console.log(report);
        break;
      }

      case 'contrarian': {
        const days = options.days ? parseInt(options.days as string, 10) : 30;
        console.log(`Testing contrarian strategy over last ${days} days...\n`);
        const contrarianResult = await analyzeContrarianStrategy(days);
        const report = formatContrarianStrategy(contrarianResult);
        console.log(report);
        break;
      }

      case 'price-theory': {
        const days = options.days ? parseInt(options.days as string, 10) : 30;
        await analyzePriceChangeTheory(days);
        break;
      }

      case 'three-up': {
        const days = options.days ? parseInt(options.days as string, 10) : 30;
        await analyzeThreeConsecutiveUps(days);
        break;
      }

      case 'advanced': {
        const days = options.days ? parseInt(options.days as string, 10) : 30;
        await analyzeAdvancedPatterns(days);
        break;
      }

      case 'trend-periods': {
        const days = options.days ? parseInt(options.days as string, 10) : 30;
        await analyzeTrendPeriods(days);
        break;
      }

      case 'help':
      default:
        printUsage();
        break;
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    if (command !== 'live') {
      closeDb();
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  closeDb();
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  closeDb();
  process.exit(1);
});
