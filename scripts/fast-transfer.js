/**
 * fast-transfer.js
 *
 * Pure ethers.js — no Hardhat overhead. Polls for balance and fires
 * all grantRole transactions instantly before the sweeper can drain.
 *
 * Run: node scripts/fast-transfer.js
 * Then send AVAX to the deployer wallet.
 */

const { ethers } = require("ethers");
require("dotenv/config");

const DEPLOYER_KEY  = process.env.PRIVATE_KEY;
const MARKET_ADDR   = process.env.MARKET_CONTRACT_ADDRESS;
const NEW_WALLET    = process.env.NEW_ADMIN; // same address for admin + oracle
const RPC_URL       = process.env.AVALANCHE_MAINNET_RPC;

if (!DEPLOYER_KEY || !MARKET_ADDR || !NEW_WALLET || !RPC_URL) {
  console.error("Missing env vars: PRIVATE_KEY, MARKET_CONTRACT_ADDRESS, NEW_ADMIN, AVALANCHE_MAINNET_RPC");
  process.exit(1);
}

const MARKET_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function revokeRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function setTreasury(address _treasury) external",
];

// 10× normal gas price — ensures our TXs beat the sweeper
const GAS = {
  maxFeePerGas:         ethers.parseUnits("500", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("200", "gwei"),
  gasLimit: 120_000,
};

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const ORACLE_ROLE  = ethers.keccak256(ethers.toUtf8Bytes("ORACLE_ROLE"));
const KEEPER_ROLE  = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));
const ADMIN_ROLE   = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

async function fireAll(provider, signer) {
  const market = new ethers.Contract(MARKET_ADDR, MARKET_ABI, signer);
  let nonce = await provider.getTransactionCount(signer.address, "pending");

  const ops = [
    ["Grant DEFAULT_ADMIN_ROLE", () => market.grantRole(DEFAULT_ADMIN_ROLE, NEW_WALLET, { ...GAS, nonce: nonce++ })],
    ["Grant ORACLE_ROLE",        () => market.grantRole(ORACLE_ROLE,        NEW_WALLET, { ...GAS, nonce: nonce++ })],
    ["Grant ADMIN_ROLE",         () => market.grantRole(ADMIN_ROLE,         NEW_WALLET, { ...GAS, nonce: nonce++ })],
    ["Grant KEEPER_ROLE",        () => market.grantRole(KEEPER_ROLE,        NEW_WALLET, { ...GAS, nonce: nonce++ })],
    ["Set treasury",             () => market.setTreasury(NEW_WALLET,                   { ...GAS, nonce: nonce++ })],
    ["Revoke DEFAULT_ADMIN",     () => market.revokeRole(DEFAULT_ADMIN_ROLE, signer.address, { ...GAS, nonce: nonce++ })],
    ["Revoke ORACLE_ROLE",       () => market.revokeRole(ORACLE_ROLE,        signer.address, { ...GAS, nonce: nonce++ })],
  ];

  // Submit ALL transactions to mempool immediately (don't wait for each to confirm)
  console.log("\n🚀 Submitting all transactions simultaneously...");
  const txs = [];
  for (const [label, fn] of ops) {
    try {
      const tx = await fn();
      txs.push({ label, tx });
      console.log(`  ✓ ${label}: ${tx.hash}`);
    } catch (e) {
      console.log(`  ✗ ${label}: ${e.message.slice(0, 80)}`);
    }
  }

  // Now wait for confirmations
  console.log("\n⏳ Waiting for confirmations...");
  for (const { label, tx } of txs) {
    try {
      const receipt = await tx.wait();
      console.log(`  ✓ ${label} confirmed (block ${receipt.blockNumber})`);
    } catch (e) {
      console.log(`  ✗ ${label} failed: ${e.message.slice(0, 80)}`);
    }
  }

  console.log("\n✅ DONE. New wallet controls the contracts:", NEW_WALLET);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer   = new ethers.Wallet(DEPLOYER_KEY, provider);

  console.log("=".repeat(55));
  console.log("TrendZap Emergency Role Transfer");
  console.log("=".repeat(55));
  console.log("Compromised wallet:", signer.address);
  console.log("New safe wallet:   ", NEW_WALLET);
  console.log("=".repeat(55));
  console.log("\n⏳ Waiting for AVAX to arrive in compromised wallet...");
  console.log(`   Send at least 0.002 AVAX to: ${signer.address}`);
  console.log("   (Script fires the instant funds land)\n");

  // Poll every 500ms
  while (true) {
    const balance = await provider.getBalance(signer.address);
    if (balance > 0n) {
      console.log(`\n💰 Balance detected: ${ethers.formatEther(balance)} AVAX — firing NOW!`);
      await fireAll(provider, signer);
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
