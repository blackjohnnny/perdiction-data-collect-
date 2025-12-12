import { ethers } from 'ethers';
import { PREDICTION_CONTRACT_ADDRESS, PREDICTION_ABI } from './contract-abi.js';

/**
 * Test script to verify BSC connection and contract interaction
 */

async function testConnection() {
  console.log('🧪 Testing connection to PancakeSwap Prediction contract...\n');

  try {
    // Test HTTP connection
    console.log('📡 Testing HTTP RPC connection...');
    const httpProvider = new ethers.JsonRpcProvider('https://bsc-dataseed1.binance.org');

    const blockNumber = await httpProvider.getBlockNumber();
    console.log(`✅ HTTP Connected - Current block: ${blockNumber}\n`);

    // Test contract
    console.log('📜 Testing contract interface...');
    const contract = new ethers.Contract(
      PREDICTION_CONTRACT_ADDRESS,
      PREDICTION_ABI,
      httpProvider
    );

    const currentEpoch = await contract.currentEpoch();
    console.log(`✅ Contract Connected - Current epoch: ${currentEpoch.toString()}\n`);

    // Fetch latest round data
    console.log('🔍 Fetching latest round data...');
    const roundData = await contract.rounds(currentEpoch);

    const lockTime = new Date(Number(roundData.lockTimestamp) * 1000).toISOString();
    const closeTime = new Date(Number(roundData.closeTimestamp) * 1000).toISOString();
    const bullBNB = ethers.formatEther(roundData.bullAmount);
    const bearBNB = ethers.formatEther(roundData.bearAmount);
    const total = parseFloat(bullBNB) + parseFloat(bearBNB);
    const bullPct = total > 0 ? ((parseFloat(bullBNB) / total) * 100).toFixed(2) : 0;
    const bearPct = total > 0 ? ((parseFloat(bearBNB) / total) * 100).toFixed(2) : 0;

    console.log(`\nEpoch ${currentEpoch}:`);
    console.log(`   Lock Time:  ${lockTime}`);
    console.log(`   Close Time: ${closeTime}`);
    console.log(`   Bull Pool:  ${bullBNB} BNB (${bullPct}%)`);
    console.log(`   Bear Pool:  ${bearBNB} BNB (${bearPct}%)`);
    console.log(`   Total Pool: ${total.toFixed(4)} BNB`);

    if (roundData.lockPrice > 0) {
      const lockPrice = (Number(roundData.lockPrice) / 1e8).toFixed(2);
      console.log(`   Lock Price: $${lockPrice}`);
    }

    if (roundData.closePrice > 0) {
      const closePrice = (Number(roundData.closePrice) / 1e8).toFixed(2);
      console.log(`   Close Price: $${closePrice}`);
    }

    console.log('\n✅ All tests passed!\n');

    // Test WebSocket connection
    console.log('🔌 Testing WebSocket connection...');
    const wssProvider = new ethers.WebSocketProvider('wss://bsc.publicnode.com');

    const wssBlockNumber = await wssProvider.getBlockNumber();
    console.log(`✅ WebSocket Connected - Current block: ${wssBlockNumber}\n`);

    console.log('🎉 System is ready to monitor!\n');

    // Cleanup
    httpProvider.destroy();
    await wssProvider.destroy();

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('\nTroubleshooting:');
    console.error('1. Check your internet connection');
    console.error('2. Verify BSC RPC endpoints are accessible');
    console.error('3. Try running: npm install\n');
    process.exit(1);
  }
}

testConnection();
