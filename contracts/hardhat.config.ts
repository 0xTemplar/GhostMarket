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
const SEPOLIA_PRIVATE_KEY =
  process.env.SEPOLIA_PRIVATE_KEY ?? DEPLOYER_PRIVATE_KEY;

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

    // ── Flow EVM Testnet — GhostVault + GhostMarket ─────────────────────────
    flowTestnet: {
      url: 'https://testnet.evm.nodes.onflow.org',
      chainId: 545,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    flowMainnet: {
      url: 'https://mainnet.evm.nodes.onflow.org',
      chainId: 747,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },

    // ── Ethereum Sepolia — GhostEAMM (Zama fhevm) ───────────────────────────
    // Zama Protocol is NOT its own chain. It runs on Ethereum Sepolia.
    // ZamaEthereumConfig in GhostEAMM.sol wires the contract to the Sepolia
    // FHEVM gateway automatically.
    // Faucet:  https://sepoliafaucet.com / https://www.alchemy.com/faucets/ethereum-sepolia
    // Deploy:  npx hardhat run scripts/deploy-eamm.ts --network sepolia
    // Tests:   npx hardhat test --network sepolia   (real encryption, slower)
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org',
      chainId: 11155111,
      accounts: SEPOLIA_PRIVATE_KEY ? [SEPOLIA_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    // Flowscan does not use a standard etherscan key but the config is kept
    // for future verification support.
    apiKey: {
      flowTestnet: 'no-api-key-needed',
      flowMainnet: 'no-api-key-needed',
    },
    customChains: [
      {
        network: 'flowTestnet',
        chainId: 545,
        urls: {
          apiURL: 'https://evm-testnet.flowscan.io/api',
          browserURL: 'https://evm-testnet.flowscan.io',
        },
      },
      {
        network: 'flowMainnet',
        chainId: 747,
        urls: {
          apiURL: 'https://evm.flowscan.io/api',
          browserURL: 'https://evm.flowscan.io',
        },
      },
    ],
  },
};

export default config;
