import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
// FHEVM Hardhat plugin — adds `fhevm` to the Hardhat runtime, enables mock
// FHE on the default hardhat network, and provides compile/test helpers.
// Docs: https://docs.zama.org/protocol/solidity-guides/development-guide/hardhat
import '@fhevm/hardhat-plugin';
// Custom FHEVM tasks
import './tasks/shielded-bet';
import dotenv from 'dotenv';

dotenv.config();

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? '';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.26',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      viaIR: true,
    },
  },
  networks: {
    // ── hardhat (default) ───────────────────────────────────────────────────
    // @fhevm/hardhat-plugin makes this network FHE-mock by default.
    // Run tests: npx hardhat test --network hardhat
    hardhat: {},

    // ── Ethereum Sepolia ─────────────────────────────────────────────────────
    // All GhostMarket contracts deploy here:
    //   GhostEAMM.sol    — FHE encrypted AMM (Zama coprocessor)
    //   GhostVault.sol   — ETH custody + EIP-712 settlement
    //   GhostMarket.sol  — Public market metadata registry
    //
    // Faucet:  https://sepoliafaucet.com / https://www.alchemy.com/faucets/ethereum-sepolia
    // Deploy:  npx hardhat run scripts/deploy-sepolia.ts --network sepolia
    // Tests:   npx hardhat test --network sepolia   (real FHE encryption, slower)
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org',
      chainId: 11155111,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: {
      sepolia: process.env.ETHERSCAN_API_KEY ?? 'no-api-key',
    },
  },
};

export default config;
