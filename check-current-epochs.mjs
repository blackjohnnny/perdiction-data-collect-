import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc.publicnode.com'),
});

const PREDICTION_ABI = [
  {
    type: 'function',
    stateMutability: 'view',
    name: 'currentEpoch',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
];

const MARKETS = {
  BNB: '0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA',
  BTC: '0x48781a7d35f6137a9135Bbb984AF65fd6AB25618',
  ETH: '0x7451F994A8D510CBCB46cF57D50F31F188Ff58F5',
};

console.log('Checking current epochs for all markets...\n');

for (const [name, address] of Object.entries(MARKETS)) {
  try {
    const epoch = await client.readContract({
      address,
      abi: PREDICTION_ABI,
      functionName: 'currentEpoch',
    });

    console.log(`${name}/USD (${address}):`);
    console.log(`  Current Epoch: ${epoch}`);

    // Calculate 90 days ago epoch (288 rounds per day)
    const rounds90Days = 90 * 288;
    const startEpoch = Number(epoch) - rounds90Days;

    console.log(`  90 days ago (~${rounds90Days} rounds): Epoch ${startEpoch}`);
    console.log('');
  } catch (error) {
    console.error(`${name}/USD: Error -`, error.message);
  }
}
