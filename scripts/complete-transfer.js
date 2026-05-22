/**
 * complete-transfer.js
 *
 * Finish the admin transfer using the NEW safe wallet.
 * DEFAULT_ADMIN_ROLE is already on the new wallet — this script:
 *   1. Grants ORACLE_ROLE, ADMIN_ROLE, KEEPER_ROLE to new wallet
 *   2. Sets treasury to new wallet
 *   3. Revokes DEFAULT_ADMIN_ROLE, ORACLE_ROLE, ADMIN_ROLE, KEEPER_ROLE from compromised wallet
 *
 * Run: NEW_WALLET_KEY=<your-new-private-key> node scripts/complete-transfer.js
 * Or:  node scripts/complete-transfer.js   (if NEW_WALLET_KEY is already in .env)
 */

const { ethers } = require("ethers");
require("dotenv/config");

const COMPROMISED_WALLET = "0x8f0E9b15028311F263be1B71c1D5d8Ae8a35294e";
const MARKET_ADDR        = process.env.MARKET_CONTRACT_ADDRESS;
const NEW_WALLET         = process.env.NEW_ADMIN;
const NEW_WALLET_KEY     = process.env.NEW_WALLET_KEY || process.env.ORACLE_PRIVATE_KEY;
const RPC_URL            = process.env.AVALANCHE_MAINNET_RPC;

if (!NEW_WALLET_KEY || !MARKET_ADDR || !NEW_WALLET || !RPC_URL) {
  console.error("Missing env vars. Set NEW_WALLET_KEY (or ORACLE_PRIVATE_KEY), MARKET_CONTRACT_ADDRESS, NEW_ADMIN, AVALANCHE_MAINNET_RPC");
  process.exit(1);
}

const MARKET_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function revokeRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function setTreasury(address _treasury) external",
];

// Standard gas — no sweeper risk since we're using the safe wallet
const GAS = {
  maxFeePerGas:         ethers.parseUnits("50", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("2",  "gwei"),
  gasLimit: 120_000,
};

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const ORACLE_ROLE  = ethers.keccak256(ethers.toUtf8Bytes("ORACLE_ROLE"));
const KEEPER_ROLE  = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));
const ADMIN_ROLE   = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer   = new ethers.Wallet(NEW_WALLET_KEY, provider);

  if (signer.address.toLowerCase() !== NEW_WALLET.toLowerCase()) {
    console.error(`Key mismatch: key derives to ${signer.address}, expected ${NEW_WALLET}`);
    process.exit(1);
  }

  const balance = await provider.getBalance(signer.address);
  console.log("=".repeat(55));
  console.log("TrendZap Role Transfer — Completion");
  console.log("=".repeat(55));
  console.log("Safe wallet:", signer.address);
  console.log("Balance:    ", ethers.formatEther(balance), "AVAX");
  console.log("=".repeat(55));

  if (balance < ethers.parseEther("0.01")) {
    throw new Error(`Need at least 0.01 AVAX in ${signer.address}. Current: ${ethers.formatEther(balance)} AVAX`);
  }

  const market = new ethers.Contract(MARKET_ADDR, MARKET_ABI, signer);
  let nonce = await provider.getTransactionCount(signer.address, "pending");

  async function send(label, fn) {
    try {
      const tx = await fn();
      console.log(`  ✓ ${label}: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`    Confirmed (block ${receipt.blockNumber})`);
      nonce++;
    } catch (e) {
      console.log(`  ✗ ${label}: ${e.message.slice(0, 100)}`);
    }
  }

  console.log("\n→ Granting remaining roles to new wallet...");
  await send("Grant ORACLE_ROLE",  () => market.grantRole(ORACLE_ROLE,  NEW_WALLET, { ...GAS, nonce }));
  await send("Grant ADMIN_ROLE",   () => market.grantRole(ADMIN_ROLE,   NEW_WALLET, { ...GAS, nonce }));
  await send("Grant KEEPER_ROLE",  () => market.grantRole(KEEPER_ROLE,  NEW_WALLET, { ...GAS, nonce }));
  await send("Set treasury",       () => market.setTreasury(NEW_WALLET,              { ...GAS, nonce }));

  console.log("\n→ Revoking all roles from compromised wallet...");
  for (const [name, role] of [
    ["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN_ROLE],
    ["ORACLE_ROLE",        ORACLE_ROLE],
    ["ADMIN_ROLE",         ADMIN_ROLE],
    ["KEEPER_ROLE",        KEEPER_ROLE],
  ]) {
    const has = await market.hasRole(role, COMPROMISED_WALLET);
    if (has) {
      await send(`Revoke ${name} from compromised`, () => market.revokeRole(role, COMPROMISED_WALLET, { ...GAS, nonce }));
    } else {
      console.log(`  — ${name}: not held, skipping`);
    }
  }

  console.log("\n" + "=".repeat(55));
  console.log("✅ COMPLETE. All roles transferred.");
  console.log("   New wallet:         ", NEW_WALLET);
  console.log("   Compromised wallet: ", COMPROMISED_WALLET, "(revoked)");
  console.log("=".repeat(55));
}

main().catch(e => { console.error(e); process.exit(1); });
