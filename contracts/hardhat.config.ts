import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import dotenv from 'dotenv';

dotenv.config();

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? '';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // Flow EVM Testnet — chain ID 545
    flowTestnet: {
      url: 'https://testnet.evm.nodes.onflow.org',
      chainId: 545,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    // Flow EVM Mainnet — chain ID 747
    flowMainnet: {
      url: 'https://mainnet.evm.nodes.onflow.org',
      chainId: 747,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
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
