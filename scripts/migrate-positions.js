/**
 * migrate-positions.js
 *
 * Migrates ViralityPositions (ERC1155 token contract) to the new safe wallet.
 * The ORIGINAL deployer (0x8f0E9b15...) still holds DEFAULT_ADMIN_ROLE here.
 * This wallet has an active sweeper bot — uses fast-transfer pattern.
 *
 * Required env vars:
 *   ORIGINAL_DEPLOYER_KEY   — private key for 0x8f0E9b15028311F263be1B71c1D5d8Ae8a35294e
 *   NEW_ADMIN               — new safe wallet address
 *   AVALANCHE_MAINNET_RPC
 *
 * Run: node scripts/migrate-positions.js
 * Then send EXACTLY 0.02 AVAX to: 0x8f0E9b15028311F263be1B71c1D5d8Ae8a35294e
 */

const { ethers } = require("ethers");
require("dotenv/config");

const ORIGINAL_KEY = process.env.ORIGINAL_DEPLOYER_KEY;
const NEW_ADMIN    = process.env.NEW_ADMIN;
const RPC_URL      = process.env.AVALANCHE_MAINNET_RPC;

const POSITIONS = "0x837dD8Ce4E3CDd4d408d3B5D83998B110632bEaE";

if (!ORIGINAL_KEY || !NEW_ADMIN || !RPC_URL) {
  console.error("Missing env vars: ORIGINAL_DEPLOYER_KEY, NEW_ADMIN, AVALANCHE_MAINNET_RPC");
  process.exit(1);
}

const POSITIONS_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function revokeRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
];

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const MARKET_ROLE        = ethers.keccak256(ethers.toUtf8Bytes("MARKET_ROLE"));
const RESOLVER_ROLE      = ethers.keccak256(ethers.toUtf8Bytes("RESOLVER_ROLE"));

// 150 gwei beats typical sweeper bots
const GAS = {
  maxFeePerGas:         ethers.parseUnits("150", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("75",  "gwei"),
  gasLimit: 60_000,
};

async function fireAll(provider, signer) {
  const positions = new ethers.Contract(POSITIONS, POSITIONS_ABI, signer);
  const old       = signer.address;
  let   nonce     = await provider.getTransactionCount(signer.address, "pending");

  const ops = [
    ["Grant DEFAULT_ADMIN_ROLE", () => positions.grantRole(DEFAULT_ADMIN_ROLE, NEW_ADMIN, { ...GAS, nonce: nonce++ })],
    ["Grant MARKET_ROLE",        () => positions.grantRole(MARKET_ROLE,        NEW_ADMIN, { ...GAS, nonce: nonce++ })],
    ["Grant RESOLVER_ROLE",      () => positions.grantRole(RESOLVER_ROLE,      NEW_ADMIN, { ...GAS, nonce: nonce++ })],
    ["Revoke DEFAULT_ADMIN_ROLE",() => positions.revokeRole(DEFAULT_ADMIN_ROLE, old,      { ...GAS, nonce: nonce++ })],
    ["Revoke MARKET_ROLE",       () => positions.revokeRole(MARKET_ROLE,        old,      { ...GAS, nonce: nonce++ })],
    ["Revoke RESOLVER_ROLE",     () => positions.revokeRole(RESOLVER_ROLE,      old,      { ...GAS, nonce: nonce++ })],
  ];

  console.log(`\nFiring ${ops.length} transactions simultaneously...\n`);
  const pending = [];
  for (const [label, fn] of ops) {
    try {
      const tx = await fn();
      pending.push({ label, tx });
      console.log(`  ✓ Submitted — ${label}: ${tx.hash}`);
    } catch (e) {
      console.log(`  ✗ Failed   — ${label}: ${e.message.slice(0, 120)}`);
    }
  }

  console.log(`\nWaiting for ${pending.length} confirmations...\n`);
  let failed = 0;
  for (const { label, tx } of pending) {
    try {
      const receipt = await tx.wait();
      console.log(`  ✓ Confirmed — ${label} (block ${receipt.blockNumber})`);
    } catch (e) {
      console.log(`  ✗ Reverted  — ${label}: ${e.message.slice(0, 100)}`);
      failed++;
    }
  }

  console.log("\n" + "=".repeat(55));
  console.log(failed === 0 ? "ViralityPositions fully migrated." : `Done with ${failed} failure(s).`);
  console.log("New admin:", NEW_ADMIN);
  console.log("=".repeat(55));
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer   = new ethers.Wallet(ORIGINAL_KEY, provider);

  console.log("=".repeat(55));
  console.log("TrendZap — ViralityPositions Migration");
  console.log("=".repeat(55));
  console.log("Signer (original deployer):", signer.address);
  console.log("New safe admin:            ", NEW_ADMIN);
  console.log("WARNING: sweeper bot active on this wallet.");
  console.log("=".repeat(55));

  const bal = await provider.getBalance(signer.address);
  if (bal > 0n) {
    console.log(`\nBalance: ${ethers.formatEther(bal)} AVAX — firing immediately.`);
    await fireAll(provider, signer);
    return;
  }

  console.log(`\nWaiting for AVAX...`);
  console.log(`Send EXACTLY 0.02 AVAX to: ${signer.address}`);
  console.log("Script fires the instant funds land.\n");

  while (true) {
    await new Promise(r => setTimeout(r, 200));
    const b = await provider.getBalance(signer.address);
    if (b > 0n) {
      console.log(`\nBalance detected: ${ethers.formatEther(b)} AVAX — firing NOW!`);
      await fireAll(provider, signer);
      break;
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
