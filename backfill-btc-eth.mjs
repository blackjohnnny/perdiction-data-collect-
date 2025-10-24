import { spawn } from 'child_process';

const MARKETS = [
  { name: 'BTC', from: 1, to: 12878, dbPath: './prediction-data-btc.db' },
  { name: 'ETH', from: 1, to: 12876, dbPath: './prediction-data-eth.db' },
];

async function backfillMarket(market) {
  return new Promise((resolve, reject) => {
    console.log(`\n🚀 Starting backfill for ${market.name}/USD...`);
    console.log(`   Epochs: ${market.from} → ${market.to} (~${market.to} rounds)`);
    console.log(`   Database: ${market.dbPath}\n`);

    const env = {
      ...process.env,
      DB_PATH: market.dbPath,
      PREDICTION_CONTRACT: market.name === 'BTC'
        ? '0x48781a7d35f6137a9135Bbb984AF65fd6AB25618'
        : '0x7451F994A8D510CBCB46cF57D50F31F188Ff58F5',
    };

    const child = spawn('npm', ['start', 'backfill', '--', '--from', market.from.toString(), '--to', market.to.toString()], {
      env,
      shell: true,
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`\n✅ ${market.name}/USD backfill completed!`);
        resolve();
      } else {
        console.error(`\n❌ ${market.name}/USD backfill failed with code ${code}`);
        reject(new Error(`Backfill failed with code ${code}`));
      }
    });

    child.on('error', (err) => {
      console.error(`\n❌ ${market.name}/USD backfill error:`, err);
      reject(err);
    });
  });
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  BACKFILLING BTC/USD AND ETH/USD PREDICTION DATA');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const market of MARKETS) {
    try {
      await backfillMarket(market);
    } catch (error) {
      console.error(`Failed to backfill ${market.name}:`, error);
      process.exit(1);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  ✅ ALL MARKETS BACKFILLED SUCCESSFULLY!');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);
