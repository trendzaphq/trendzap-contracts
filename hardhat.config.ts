import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import "dotenv/config";

const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000000";
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY || "";
const SNOWTRACE_API_KEY = process.env.SNOWTRACE_API_KEY || "";
const ARBITRUM_SEPOLIA_RPC = process.env.ARBITRUM_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc";
const ARBITRUM_ONE_RPC = process.env.ARBITRUM_ONE_RPC || "https://arb1.arbitrum.io/rpc";
const AVALANCHE_FUJI_RPC = process.env.AVALANCHE_FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc";
const AVALANCHE_MAINNET_RPC = process.env.AVALANCHE_MAINNET_RPC || "https://api.avax.network/ext/bc/C/rpc";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    // Avalanche Networks
    avalancheFuji: {
      url: AVALANCHE_FUJI_RPC,
      chainId: 43113,
      accounts: [PRIVATE_KEY],
      gasPrice: 25000000000, // 25 gwei
    },
    avalancheMainnet: {
      url: AVALANCHE_MAINNET_RPC,
      chainId: 43114,
      accounts: [PRIVATE_KEY],
      timeout: 300000,
    },
    // Arbitrum Networks (legacy)
    arbitrumSepolia: {
      url: ARBITRUM_SEPOLIA_RPC,
      chainId: 421614,
      accounts: [PRIVATE_KEY],
    },
    arbitrumOne: {
      url: ARBITRUM_ONE_RPC,
      chainId: 42161,
      accounts: [PRIVATE_KEY],
    },
  },
  etherscan: {
    apiKey: {
      avalancheFujiTestnet: SNOWTRACE_API_KEY,
      avalanche: SNOWTRACE_API_KEY,
      arbitrumSepolia: ARBISCAN_API_KEY,
      arbitrumOne: ARBISCAN_API_KEY,
    },
    customChains: [
      {
        network: "avalancheFujiTestnet",
        chainId: 43113,
        urls: {
          apiURL: "https://api-testnet.snowtrace.io/api",
          browserURL: "https://testnet.snowtrace.io",
        },
      },
      {
        network: "arbitrumSepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://api-sepolia.arbiscan.io/api",
          browserURL: "https://sepolia.arbiscan.io",
        },
      },
    ],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

export default config;
