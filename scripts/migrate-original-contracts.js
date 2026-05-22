/**
 * migrate-original-contracts.js
 *
 * Migrates admin roles on the three contracts NOT covered by the April 2026 migration:
 *   - ViralityMarketV2 (deprecated)  0x5C13B24ae55fE5CaF8B694E6ff4478bfC0C22DB8
 *   - MarketFactoryV2                0x55Ed74dFD27E16bd69decf473b524379A588a427
 *   - ViralityPositions              0x837dD8Ce4E3CDd4d408d3B5D83998B110632bEaE
 *
 * These contracts still have the ORIGINAL deployer (0x8f0E9b15...) as DEFAULT_ADMIN.
 * That wallet has a confirmed sweeper bot — AVAX sent to it is drained instantly.
 *
 * This script uses the fast-transfer pattern:
 *   - Polls for balance every 200ms
 *   - Fires ALL transactions simultaneously the instant AVAX lands
 *   - Uses ultra-high gas (500 gwei) to beat the sweeper to the next block
 *
 * Required env vars:
 *   ORIGINAL_DEPLOYER_KEY   — private key for 0x8f0E9b15028311F263be1B71c1D5d8Ae8a35294e
 *   NEW_ADMIN               — new safe wallet address to receive all roles
 *   AVALANCHE_MAINNET_RPC
 *
 * Run:
 *   node scripts/migrate-original-contracts.js
 * Then immediately send exactly 0.01 AVAX to: 0x8f0E9b15028311F263be1B71c1D5d8Ae8a35294e
 * Do NOT send more — excess will be swept.
 */

const { ethers } = require("ethers");
require("dotenv/config");

const ORIGINAL_KEY = process.env.ORIGINAL_DEPLOYER_KEY;
const NEW_ADMIN    = process.env.NEW_ADMIN;
const RPC_URL      = process.env.AVALANCHE_MAINNET_RPC;

if (!ORIGINAL_KEY || !NEW_ADMIN || !RPC_URL) {
  console.error("Missing env vars: ORIGINAL_DEPLOYER_KEY, NEW_ADMIN, AVALANCHE_MAINNET_RPC");
  process.exit(1);
}

const CONTRACTS = {
  MARKET_DEPRECATED: "0x5C13B24ae55fE5CaF8B694E6ff4478bfC0C22DB8",
  FACTORY_V2:        "0x55Ed74dFD27E16bd69decf473b524379A588a427",
  POSITIONS:         "0x837dD8Ce4E3CDd4d408d3B5D83998B110632bEaE",
};

const MARKET_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function revokeRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function setTreasury(address _treasury) external",
];

const FACTORY_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function revokeRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function setTreasury(address _treasury) external",
  "function setOracle(address _oracle) external",
];

const POSITIONS_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function revokeRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
];

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const ORACLE_ROLE        = ethers.keccak256(ethers.toUtf8Bytes("ORACLE_ROLE"));
const ADMIN_ROLE         = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const KEEPER_ROLE        = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));
const MARKET_ROLE        = ethers.keccak256(ethers.toUtf8Bytes("MARKET_ROLE"));
const RESOLVER_ROLE      = ethers.keccak256(ethers.toUtf8Bytes("RESOLVER_ROLE"));

// 150 gwei beats typical sweeper bots (25–100 gwei) while fitting in a small balance.
// Max cost per tx: 150 gwei × 60k gas = 0.009 AVAX. Send at least 0.02 AVAX (~$0.50).
const GAS = {
  maxFeePerGas:         ethers.parseUnits("150", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("75",  "gwei"),
  gasLimit: 60_000,
};

function buildOps(signer) {
  const deprecated = new ethers.Contract(CONTRACTS.MARKET_DEPRECATED, MARKET_ABI,    signer);
  const factory    = new ethers.Contract(CONTRACTS.FACTORY_V2,        FACTORY_ABI,   signer);
  const positions  = new ethers.Contract(CONTRACTS.POSITIONS,         POSITIONS_ABI, signer);
  const old        = signer.address;

  return [
    // ViralityMarketV2 (deprecated) — grant
    ["[Deprecated Market] Grant DEFAULT_ADMIN_ROLE", () => deprecated.grantRole(DEFAULT_ADMIN_ROLE, NEW_ADMIN, GAS)],
    ["[Deprecated Market] Grant ORACLE_ROLE",        () => deprecated.grantRole(ORACLE_ROLE,        NEW_ADMIN, GAS)],
    ["[Deprecated Market] Grant ADMIN_ROLE",         () => deprecated.grantRole(ADMIN_ROLE,         NEW_ADMIN, GAS)],
    ["[Deprecated Market] Grant KEEPER_ROLE",        () => deprecated.grantRole(KEEPER_ROLE,        NEW_ADMIN, GAS)],

    // MarketFactoryV2 — grant
    ["[Factory] Grant DEFAULT_ADMIN_ROLE", () => factory.grantRole(DEFAULT_ADMIN_ROLE, NEW_ADMIN, GAS)],
    ["[Factory] Grant ADMIN_ROLE",         () => factory.grantRole(ADMIN_ROLE,         NEW_ADMIN, GAS)],
    ["[Factory] Set treasury",             () => factory.setTreasury(NEW_ADMIN,                   GAS)],
    ["[Factory] Set oracle",               () => factory.setOracle(NEW_ADMIN,                     GAS)],

    // ViralityPositions — grant
    ["[Positions] Grant DEFAULT_ADMIN_ROLE", () => positions.grantRole(DEFAULT_ADMIN_ROLE, NEW_ADMIN, GAS)],
    ["[Positions] Grant MARKET_ROLE",        () => positions.grantRole(MARKET_ROLE,        NEW_ADMIN, GAS)],
    ["[Positions] Grant RESOLVER_ROLE",      () => positions.grantRole(RESOLVER_ROLE,      NEW_ADMIN, GAS)],

    // Revoke from original deployer — all contracts
    ["[Deprecated Market] Revoke DEFAULT_ADMIN_ROLE", () => deprecated.revokeRole(DEFAULT_ADMIN_ROLE, old, GAS)],
    ["[Deprecated Market] Revoke ORACLE_ROLE",        () => deprecated.revokeRole(ORACLE_ROLE,        old, GAS)],
    ["[Deprecated Market] Revoke ADMIN_ROLE",         () => deprecated.revokeRole(ADMIN_ROLE,         old, GAS)],
    ["[Deprecated Market] Revoke KEEPER_ROLE",        () => deprecated.revokeRole(KEEPER_ROLE,        old, GAS)],

    ["[Factory] Revoke DEFAULT_ADMIN_ROLE", () => factory.revokeRole(DEFAULT_ADMIN_ROLE, old, GAS)],
    ["[Factory] Revoke ADMIN_ROLE",         () => factory.revokeRole(ADMIN_ROLE,         old, GAS)],

    ["[Positions] Revoke DEFAULT_ADMIN_ROLE", () => positions.revokeRole(DEFAULT_ADMIN_ROLE, old, GAS)],
    ["[Positions] Revoke MARKET_ROLE",        () => positions.revokeRole(MARKET_ROLE,        old, GAS)],
    ["[Positions] Revoke RESOLVER_ROLE",      () => positions.revokeRole(RESOLVER_ROLE,      old, GAS)],
  ];
}

async function fireAll(provider, signer) {
  const ops   = buildOps(signer);
  let   nonce = await provider.getTransactionCount(signer.address, "pending");

  console.log(`\nFiring ${ops.length} transactions simultaneously...\n`);

  const pending = [];
  for (const [label, fn] of ops) {
    try {
      const tx = await fn({ ...GAS, nonce: nonce++ });
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

  console.log("\n" + "=".repeat(55));
  if (failed === 0) {
    console.log("ALL DONE — remaining contracts migrated.");
  } else {
    console.log(`Done with ${failed} failure(s). Check above.`);
  }
  console.log("New admin:", NEW_ADMIN);
  console.log("=".repeat(55));
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer   = new ethers.Wallet(ORIGINAL_KEY, provider);

  console.log("=".repeat(55));
  console.log("TrendZap — Original Contracts Migration");
  console.log("=".repeat(55));
  console.log("Original deployer (signer):", signer.address);
  console.log("New safe admin:            ", NEW_ADMIN);
  console.log("WARNING: This wallet has a sweeper bot.");
  console.log("Send EXACTLY 0.01 AVAX — no more.");
  console.log("=".repeat(55));

  const balance = await provider.getBalance(signer.address);
  if (balance > 0n) {
    console.log(`\nBalance detected: ${ethers.formatEther(balance)} AVAX — firing immediately.`);
    await fireAll(provider, signer);
    return;
  }

  console.log(`\nWaiting for AVAX...`);
  console.log(`Send EXACTLY 0.02 AVAX (~$0.50) to: ${signer.address}`);
  console.log("Script fires the instant funds land.\n");

  while (true) {
    await new Promise(r => setTimeout(r, 200)); // poll every 200ms (faster than sweeper)
    const bal = await provider.getBalance(signer.address);
    if (bal > 0n) {
      console.log(`\nBalance detected: ${ethers.formatEther(bal)} AVAX — firing NOW!`);
      await fireAll(provider, signer);
      break;
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
