import Database from 'better-sqlite3';

const db = new Database('./resolved_markets.db', { readonly: true });

console.log('\n🔍 BTC DATABASE FORMAT CHECK\n');
console.log('═'.repeat(80) + '\n');

// Get schema
console.log('📋 SCHEMA:\n');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));
console.log('\n');

for (const table of tables) {
  console.log(`📊 Table: ${table.name}\n`);
  const columns = db.prepare(`PRAGMA table_info(${table.name})`).all();

  console.log('  Columns:');
  for (const col of columns) {
    console.log(`    - ${col.name} (${col.type})`);
  }
  console.log('\n');
}

console.log('─'.repeat(80) + '\n');

// Count records
const mainTable = tables[0]?.name;
if (mainTable) {
  const count = db.prepare(`SELECT COUNT(*) as count FROM ${mainTable}`).get();
  console.log(`📊 Total records in ${mainTable}: ${count.count}\n`);

  // Show sample records
  console.log('📝 SAMPLE RECORDS (First 5):\n');
  const samples = db.prepare(`SELECT * FROM ${mainTable} LIMIT 5`).all();

  for (let i = 0; i < samples.length; i++) {
    console.log(`Record ${i + 1}:`);
    console.log(JSON.stringify(samples[i], null, 2));
    console.log('');
  }
}

console.log('═'.repeat(80) + '\n');

db.close();
