# TrendZap Contracts

> Solidity smart contracts for TrendZap - the decentralized prediction market for social media virality, built exclusively on Avalanche.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.20-blue)](https://docs.soliditylang.org/)
[![Avalanche](https://img.shields.io/badge/Chain-Avalanche-blue)](https://avax.network/)

---

## Overview

This repository contains the core smart contracts that power TrendZap's prediction market protocol. Users can create markets around social media post engagement (likes, retweets, views) and bet on whether metrics will go OVER or UNDER specified thresholds.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      TrendZap Protocol                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────┐ │
│  │  MarketFactory  │───▶│  ViralityMarket │◀───│   Treasury  │ │
│  └─────────────────┘    └────────┬────────┘    └─────────────┘ │
│                                  │                              │
│                                  ▼                              │
│                         ┌─────────────────┐                     │
│                         │  SocialOracle   │                     │
│                         └────────┬────────┘                     │
│                                  │                              │
│                                  ▼                              │
│                         ┌─────────────────┐                     │
│                         │    Chainlink    │                     │
│                         └─────────────────┘                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Contracts

| Contract | Description | Status |
|----------|-------------|--------|
| `ViralityMarket.sol` | Core prediction market logic | 🔨 In Development |
| `MarketFactory.sol` | Factory for deploying new markets | 🔨 In Development |
| `SocialOracle.sol` | Chainlink oracle adapter for social metrics | 🔨 In Development |
| `Treasury.sol` | Fee collection and payout management | 📋 Planned |
| `OutcomeToken.sol` | ERC-20 tokens representing OVER/UNDER positions | 📋 Planned |

## Tech Stack

- **Solidity** 0.8.20+
- **Hardhat** - Development environment
- **Foundry** - Testing framework
- **OpenZeppelin** - Security standards
- **Chainlink** - Oracle infrastructure

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm 8+
- Foundry (optional, for Foundry tests)

### Installation

```bash
# Clone the repository
git clone https://github.com/trendzaphq/trendzap-contracts.git
cd trendzap-contracts

# Install dependencies
pnpm install

# Copy environment variables
cp .env.example .env
```

### Compile Contracts

```bash
pnpm compile
```

### Run Tests

```bash
# Hardhat tests
pnpm test

# Foundry tests (if installed)
forge test
```

### Deploy to Avalanche Fuji

```bash
pnpm deploy:sepolia
```

## Deployments

### Avalanche Fuji (Testnet)

| Contract | Address | Verified |
|----------|---------|----------|
| MarketFactory | `TBD` | ❌ |
| ViralityMarket (Implementation) | `TBD` | ❌ |
| SocialOracle | `TBD` | ❌ |
| Treasury | `TBD` | ❌ |

### Avalanche C-Chain (Mainnet)

*Coming after audit completion*

## Development

### Project Structure

```
trendzap-contracts/
├── contracts/
│   ├── core/
│   │   ├── ViralityMarket.sol
│   │   ├── MarketFactory.sol
│   │   └── Treasury.sol
│   ├── oracle/
│   │   ├── SocialOracle.sol
│   │   └── OracleAdapter.sol
│   ├── tokens/
│   │   └── OutcomeToken.sol
│   └── interfaces/
│       ├── IViralityMarket.sol
│       ├── IMarketFactory.sol
│       └── ISocialOracle.sol
├── scripts/
│   ├── deploy.ts
│   └── verify.ts
├── test/
│   ├── ViralityMarket.test.ts
│   ├── MarketFactory.test.ts
│   └── integration/
├── deployments/
│   ├── avalanche-fuji.json
│   └── avalanche-mainnet.json
├── hardhat.config.ts
├── foundry.toml
└── package.json
```

### Testing

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm test test/ViralityMarket.test.ts

# Run with coverage
pnpm coverage

# Gas report
pnpm gas-report
```

## Security

- All contracts follow OpenZeppelin security standards
- Reentrancy protection on all external calls
- Access control via role-based permissions
- Oracle data validation with multiple sources
- Audit planned before mainnet deployment

### Bug Bounty

*Coming soon*

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Related Repositories

| Repository | Description |
|------------|-------------|
| [trendzap-app](https://github.com/trendzaphq/trendzap-app) | Main prediction market dApp |
| [trendzap-oracle](https://github.com/trendzaphq/trendzap-oracle) | Social media data oracle service |
| [trendzap-sdk](https://github.com/trendzaphq/trendzap-sdk) | TypeScript SDK for developers |
| [trendzap-subgraph](https://github.com/trendzaphq/trendzap-subgraph) | The Graph indexing |

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

<p align="center">
  <strong>Built with ❤️ on Avalanche</strong>
</p>
