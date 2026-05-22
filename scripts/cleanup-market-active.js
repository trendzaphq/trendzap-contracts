/**
 * cleanup-market-active.js
 *
 * Run this from the NEW safe wallet after migrate-all-contracts.js completed.
 * The new wallet already has DEFAULT_ADMIN_ROLE on ViralityMarketV2 (active).
 * This script revokes the remaining roles from the old compromised wallet.
 *
 * Required env vars:
 *   NEW_WALLET_KEY     — private key for the new safe wallet (NEW_ADMIN)
 *   NEW_ADMIN          — new safe wallet address (signer must match)
 *   AVALANCHE_MAINNET_RPC
 *
 * Run: node scripts/cleanup-market-active.js
 */

const { ethers } = require("ethers");
require("dotenv/config");

const NEW_WALLET_KEY = process.env.NEW_WALLET_KEY;
const NEW_ADMIN      = process.env.NEW_ADMIN;
const RPC_URL        = process.env.AVALANCHE_MAINNET_RPC;

// The old compromised admin wallet — still has ORACLE/ADMIN/KEEPER roles on active market
const OLD_ADMIN = "0x05394029EA22767D2283bcd0bE03B13353781212";

const MARKET_ACTIVE = "0xbB898682B2BbD8cF19c33179b783ed172168BB6d";

if (!NEW_WALLET_KEY || !NEW_ADMIN || !RPC_URL) {
  console.error("Missing env vars: NEW_WALLET_KEY, NEW_ADMIN, AVALANCHE_MAINNET_RPC");
  process.exit(1);
}

const MARKET_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function revokeRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
];

const ORACLE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ORACLE_ROLE"));
const ADMIN_ROLE  = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const KEEPER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));

const GAS = {
  maxFeePerGas:         ethers.parseUnits("50", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("5",  "gwei"),
  gasLimit: 80_000,
};

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer   = new ethers.Wallet(NEW_WALLET_KEY, provider);

  if (signer.address.toLowerCase() !== NEW_ADMIN.toLowerCase()) {
    console.error(`Key mismatch: key derives to ${signer.address}, expected ${NEW_ADMIN}`);
    process.exit(1);
  }

  console.log("=".repeat(55));
  console.log("TrendZap — Market Active Cleanup");
  console.log("=".repeat(55));
  console.log("Signer (new wallet):", signer.address);
  console.log("Revoking from:      ", OLD_ADMIN);
  console.log("=".repeat(55));

  const market = new ethers.Contract(MARKET_ACTIVE, MARKET_ABI, signer);

  // Check roles first
  const hasOracle = await market.hasRole(ORACLE_ROLE, OLD_ADMIN);
  const hasAdmin  = await market.hasRole(ADMIN_ROLE,  OLD_ADMIN);
  const hasKeeper = await market.hasRole(KEEPER_ROLE, OLD_ADMIN);

  console.log(`\nOld wallet role status on Market Active:`);
  console.log(`  ORACLE_ROLE:  ${hasOracle ? "still held — will revoke" : "already clean"}`);
  console.log(`  ADMIN_ROLE:   ${hasAdmin  ? "still held — will revoke" : "already clean"}`);
  console.log(`  KEEPER_ROLE:  ${hasKeeper ? "still held — will revoke" : "already clean"}`);

  const ops = [];
  let nonce = await provider.getTransactionCount(signer.address, "pending");

  if (hasOracle) ops.push(["Revoke ORACLE_ROLE",  () => market.revokeRole(ORACLE_ROLE, OLD_ADMIN, { ...GAS, nonce: nonce++ })]);
  if (hasAdmin)  ops.push(["Revoke ADMIN_ROLE",   () => market.revokeRole(ADMIN_ROLE,  OLD_ADMIN, { ...GAS, nonce: nonce++ })]);
  if (hasKeeper) ops.push(["Revoke KEEPER_ROLE",  () => market.revokeRole(KEEPER_ROLE, OLD_ADMIN, { ...GAS, nonce: nonce++ })]);

  if (ops.length === 0) {
    console.log("\nAll clean — nothing to revoke.");
    return;
  }

  console.log(`\nSubmitting ${ops.length} revoke transactions...\n`);
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

  console.log(`\nWaiting for confirmations...\n`);
  for (const { label, tx } of pending) {
    try {
      const receipt = await tx.wait();
      console.log(`  ✓ Confirmed — ${label} (block ${receipt.blockNumber})`);
    } catch (e) {
      console.log(`  ✗ Reverted  — ${label}: ${e.message.slice(0, 100)}`);
    }
  }

  console.log("\n" + "=".repeat(55));
  console.log("Market Active cleanup complete.");
  console.log("=".repeat(55));
}

main().catch(e => { console.error(e); process.exit(1); });
