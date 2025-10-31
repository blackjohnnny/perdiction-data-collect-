import { readFileSync } from 'fs';

const lines = readFileSync('check-new-snapshots.csv', 'utf8').split('\n').slice(1).filter(l=>l);
const byEpoch = {};

lines.forEach(l => {
  const epoch = l.split(',')[0];
  const type = l.split(',')[1];
  if (!byEpoch[epoch]) byEpoch[epoch] = [];
  byEpoch[epoch].push(type);
});

const complete = Object.keys(byEpoch).filter(e =>
  byEpoch[e].includes('T_MINUS_25S') &&
  byEpoch[e].includes('T_MINUS_8S') &&
  byEpoch[e].includes('T_MINUS_4S')
);

console.log('Total snapshots:', lines.length);
console.log('Unique epochs:', Object.keys(byEpoch).length);
console.log('Rounds with complete T-25s+T-8s+T-4s:', complete.length);
console.log('First 5 epochs:', complete.slice(0,5));
console.log('Last 5 epochs:', complete.slice(-5));
