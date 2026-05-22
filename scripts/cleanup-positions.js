/**
 * cleanup-positions.js
 *
 * Finishes ViralityPositions migration using the NEW safe wallet.
 * New wallet already has DEFAULT_ADMIN_ROLE + MARKET_ROLE (confirmed).
 *
 * This script:
 *   1. Grants RESOLVER_ROLE to new wallet (missed due to insufficient funds)
 *   2. Revokes DEFAULT_ADMIN_ROLE from orig deployer (failed earlier)
 *   3. Revokes MARKET_ROLE from orig deployer (if not yet done)
 *   4. Revokes RESOLVER_ROLE from orig deployer (if not yet done)
 */

const { ethers } = require("ethers");
require("dotenv/config");

const NEW_WALLET_KEY = process.env.NEW_WALLET_KEY;
const ORIG_DEPLOYER  = "0x8f0E9b15028311F263be1B71c1D5d8Ae8a35294e";
const NEW_ADMIN      = process.env.NEW_ADMIN;
const RPC_URL        = process.env.AVALANCHE_MAINNET_RPC;

const POSITIONS = "0x837dD8Ce4E3CDd4d408d3B5D83998B110632bEaE";

if (!NEW_WALLET_KEY || !NEW_ADMIN || !RPC_URL) {
  console.error("Missing env vars: NEW_WALLET_KEY, NEW_ADMIN, AVALANCHE_MAINNET_RPC");
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

const GAS = {
  maxFeePerGas:         ethers.parseUnits("50", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("2",  "gwei"),
  gasLimit: 80_000,
};

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer   = new ethers.Wallet(NEW_WALLET_KEY, provider);
  const positions = new ethers.Contract(POSITIONS, POSITIONS_ABI, signer);

  console.log("=======================================================");
  console.log("TrendZap — ViralityPositions Cleanup (New Wallet)");
  console.log("=======================================================");
  console.log("Signer:", signer.address);
  const bal = await provider.getBalance(signer.address);
  console.log("Balance:", ethers.formatEther(bal), "AVAX");
  console.log("=======================================================\n");

  // Role status check
  const [
    newHasAdmin, newHasMarket, newHasResolver,
    origHasAdmin, origHasMarket, origHasResolver,
  ] = await Promise.all([
    positions.hasRole(DEFAULT_ADMIN_ROLE, NEW_ADMIN),
    positions.hasRole(MARKET_ROLE,        NEW_ADMIN),
    positions.hasRole(RESOLVER_ROLE,      NEW_ADMIN),
    positions.hasRole(DEFAULT_ADMIN_ROLE, ORIG_DEPLOYER),
    positions.hasRole(MARKET_ROLE,        ORIG_DEPLOYER),
    positions.hasRole(RESOLVER_ROLE,      ORIG_DEPLOYER),
  ]);

  console.log("Role status:");
  console.log("  New wallet  — DEFAULT_ADMIN:", newHasAdmin);
  console.log("  New wallet  — MARKET_ROLE:  ", newHasMarket);
  console.log("  New wallet  — RESOLVER_ROLE:", newHasResolver);
  console.log("  Orig deploy — DEFAULT_ADMIN:", origHasAdmin);
  console.log("  Orig deploy — MARKET_ROLE:  ", origHasMarket);
  console.log("  Orig deploy — RESOLVER_ROLE:", origHasResolver);

  const ops = [];

  if (!newHasResolver)
    ops.push(["[Positions] Grant RESOLVER_ROLE to new wallet",
      (n) => positions.grantRole(RESOLVER_ROLE, NEW_ADMIN, { ...GAS, nonce: n })]);

  if (origHasAdmin)
    ops.push(["[Positions] Revoke DEFAULT_ADMIN from orig deployer",
      (n) => positions.revokeRole(DEFAULT_ADMIN_ROLE, ORIG_DEPLOYER, { ...GAS, nonce: n })]);

  if (origHasMarket)
    ops.push(["[Positions] Revoke MARKET_ROLE from orig deployer",
      (n) => positions.revokeRole(MARKET_ROLE, ORIG_DEPLOYER, { ...GAS, nonce: n })]);

  if (origHasResolver)
    ops.push(["[Positions] Revoke RESOLVER_ROLE from orig deployer",
      (n) => positions.revokeRole(RESOLVER_ROLE, ORIG_DEPLOYER, { ...GAS, nonce: n })]);

  if (ops.length === 0) {
    console.log("\nAll roles already correct — nothing to do.\n");
    return;
  }

  console.log(`\nSubmitting ${ops.length} transactions...\n`);
  let nonce = await provider.getTransactionCount(signer.address, "pending");
  const pending = [];

  for (const [label, fn] of ops) {
    try {
      const tx = await fn(nonce++);
      pending.push({ label, tx });
      console.log(`  ✓ Submitted — ${label}`);
      console.log(`    tx: ${tx.hash}`);
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

  // Final verification
  const [na2, nm2, nr2, oa2, om2, or2] = await Promise.all([
    positions.hasRole(DEFAULT_ADMIN_ROLE, NEW_ADMIN),
    positions.hasRole(MARKET_ROLE,        NEW_ADMIN),
    positions.hasRole(RESOLVER_ROLE,      NEW_ADMIN),
    positions.hasRole(DEFAULT_ADMIN_ROLE, ORIG_DEPLOYER),
    positions.hasRole(MARKET_ROLE,        ORIG_DEPLOYER),
    positions.hasRole(RESOLVER_ROLE,      ORIG_DEPLOYER),
  ]);

  console.log("\nFinal role state:");
  console.log("  New wallet  — DEFAULT_ADMIN:", na2, na2 ? "✓" : "✗ MISSING");
  console.log("  New wallet  — MARKET_ROLE:  ", nm2, nm2 ? "✓" : "✗ MISSING");
  console.log("  New wallet  — RESOLVER_ROLE:", nr2, nr2 ? "✓" : "✗ MISSING");
  console.log("  Orig deploy — DEFAULT_ADMIN:", oa2, !oa2 ? "✓ revoked" : "✗ STILL HELD");
  console.log("  Orig deploy — MARKET_ROLE:  ", om2, !om2 ? "✓ revoked" : "✗ STILL HELD");
  console.log("  Orig deploy — RESOLVER_ROLE:", or2, !or2 ? "✓ revoked" : "✗ STILL HELD");

  const clean = na2 && nm2 && nr2 && !oa2 && !om2 && !or2;
  console.log("\n" + "=".repeat(55));
  console.log(clean
    ? "ViralityPositions fully migrated. Migration COMPLETE."
    : `Done with ${failed} failure(s) — check role state above.`);
  console.log("=".repeat(55));
}

main().catch(e => { console.error(e); process.exit(1); });
