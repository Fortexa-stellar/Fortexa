# Ecosystem Integration

This document clarifies OverSync's position within the broader Stellar ecosystem, detailing how it complements existing infrastructure and outlines the integration paths for current and future components.

## Complementary to Existing Rails

OverSync is designed to operate alongside, rather than compete with, existing bridge and movement protocols:

- **CCTP-style USDC movement**: OverSync complements Circle's Cross-Chain Transfer Protocol (CCTP) by providing a trust-minimized HTLC (Hashed Time-Locked Contract) path. While CCTP is optimal for fast USDC bridging, OverSync offers a secure, decentralized settlement layer for a wider array of cross-chain swaps and native assets.
- **Validator-set or Wrapped-asset bridges**: Unlike traditional bridges (such as Axelar or Allbridge-style routes) that rely on external validator sets to mint and burn wrapped assets, OverSync focuses on native HTLC settlement via Soroban. This trust-minimized approach eliminates the honeypot risk associated with wrapped assets and third-party validators.

## Feature Flagging Strategy

To maintain the security and isolation of OverSync's core HTLC behavior, all future ecosystem adapters must be implemented behind explicit feature flags or launch gates. This ensures that experimental or unaudited integration paths cannot compromise or bleed into the core settlement layer.

## Integration & Readiness Matrix

The following matrix clearly separates currently shipped testnet functionality from planned future ecosystem adapters.

| Integration Target         | Current Status    | Repo Owner / Module  | Risk Level | Test Artifact Needed Before Enabling | Launch Gate             |
| :------------------------- | :---------------- | :------------------- | :--------- | :----------------------------------- | :---------------------- |
| **SDK Asset Mappings**     | Shipped (Testnet) | OverSync Core        | Low        | Unit test coverage > 90%             | N/A (Default enabled)   |
| **Resolver Runner**        | Shipped (Testnet) | OverSync Core        | Medium     | E2E resolver scenario tests          | N/A (Default enabled)   |
| **Freighter Hook**         | Shipped (Testnet) | OverSync / Client    | Low        | Manual wallet integration sign-off   | N/A (Default enabled)   |
| **Soroban HTLC Contracts** | Shipped (Testnet) | OverSync / Contracts | High       | Independent security audit           | Mainnet Contract Deploy |
| **Axelar ITS Adapter**     | Planned           | Future Adapter       | High       | Cross-chain E2E test suite           | `ENABLE_AXELAR_ITS`     |
| **CCTP Fast Path**         | Planned           | Future Adapter       | Medium     | Circle testnet confirmation          | `ENABLE_CCTP_FASTPATH`  |
| **Wallet/DEX Integration** | Planned           | Client SDK           | Medium     | Partner integration sign-off         | `ENABLE_DEX_ROUTING`    |

> **Note**: No mainnet funds should ever be routed through unaudited code. OverSync’s core value proposition remains centered entirely on secure, trust-minimized Soroban HTLC settlement.
