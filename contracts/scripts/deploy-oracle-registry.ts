/**
 * deploy-oracle-registry.ts
 *
 * Deploys OracleAgentRegistry.sol to Filecoin Calibration testnet.
 *
 * Uses plain ethers — NOT Hardhat — because the @fhevm/hardhat-plugin
 * intercepts all Hardhat network calls and rejects non-Sepolia networks.
 *
 * Filecoin Calibration testnet:
 *   Chain ID : 314159
 *   RPC      : https://api.calibration.node.glif.io/rpc/v1
 *   Explorer : https://calibration.filfox.info/en
 *   Faucet   : https://faucet.calibration.fildev.network/
 *
 * Run:
 *   cd contracts
 *   npx ts-node scripts/deploy-oracle-registry.ts
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const CALIBRATION_RPC = process.env.CALIBRATION_RPC_URL ?? 'https://filecoin-calibration.drpc.org';
const CALIBRATION_CHAIN_ID = 314159;

// ── Load compiled artifact ─────────────────────────────────────────────────

function loadArtifact() {
  const artifactPath = path.join(
    __dirname,
    '../artifacts/contracts/OracleAgentRegistry.sol/OracleAgentRegistry.json'
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Artifact not found at ${artifactPath}.\n` +
      `Run: npx hardhat compile --network hardhat`
    );
  }
  return JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const privateKey = process.env.CALIBRATION_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      'Set CALIBRATION_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY in contracts/.env\n' +
      'Fund it at: https://faucet.calibration.fildev.network/'
    );
  }

  console.log('\n=== OracleAgentRegistry Deploy — Filecoin Calibration ===\n');

  const provider = new ethers.JsonRpcProvider(CALIBRATION_RPC, {
    chainId: CALIBRATION_CHAIN_ID,
    name: 'filecoin-calibration',
  });

  const wallet = new ethers.Wallet(privateKey, provider);
  console.log('Deployer  :', wallet.address);

  const balance = await provider.getBalance(wallet.address);
  console.log('Balance   :', ethers.formatEther(balance), 'tFIL');

  if (balance === 0n) {
    throw new Error(
      'Deployer has no tFIL. Fund at: https://faucet.calibration.fildev.network/'
    );
  }

  // quorumThreshold: must match ACTIVE_ORACLE_AGENTS in oracle/.env
  // floor(n/2)+1 → 4 agents = 3, 7 agents = 4
  const activeAgents    = Number(process.env.ACTIVE_ORACLE_AGENTS ?? 4);
  const quorumThreshold = Math.floor(activeAgents / 2) + 1;
  console.log(`Active agents: ${activeAgents}  →  quorum threshold: ${quorumThreshold}-of-${activeAgents}`);

  const artifact = loadArtifact();
  const factory  = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  console.log('\nDeploying OracleAgentRegistry...');
  const contract = await factory.deploy(quorumThreshold);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log('\n✓ OracleAgentRegistry deployed');
  console.log('  Address  :', address);
  console.log('  Explorer :', `https://calibration.filfox.info/en/address/${address}`);
  console.log('  Tx       :', contract.deploymentTransaction()?.hash);

  // ── Persist address to env file ──────────────────────────────────────────

  const envPath = path.join(__dirname, '../.env');
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';

  const newVar = `ORACLE_REGISTRY_ADDRESS=${address}`;
  if (envContent.includes('ORACLE_REGISTRY_ADDRESS=')) {
    envContent = envContent.replace(/ORACLE_REGISTRY_ADDRESS=.*/, newVar);
  } else {
    envContent += `\n${newVar}\n`;
  }
  fs.writeFileSync(envPath, envContent);
  console.log('\n✓ ORACLE_REGISTRY_ADDRESS written to contracts/.env');

  // ── Also write to web/.env.local ─────────────────────────────────────────

  const webEnvPath = path.join(__dirname, '../../web/.env.local');
  if (fs.existsSync(webEnvPath)) {
    let webEnv = fs.readFileSync(webEnvPath, 'utf-8');
    const webVar = `NEXT_PUBLIC_ORACLE_REGISTRY_ADDRESS=${address}`;
    if (webEnv.includes('NEXT_PUBLIC_ORACLE_REGISTRY_ADDRESS=')) {
      webEnv = webEnv.replace(/NEXT_PUBLIC_ORACLE_REGISTRY_ADDRESS=.*/, webVar);
    } else {
      webEnv += `\n${webVar}\n`;
    }
    fs.writeFileSync(webEnvPath, webEnv);
    console.log('✓ NEXT_PUBLIC_ORACLE_REGISTRY_ADDRESS written to web/.env.local');
  }

  // ── Also write to oracle/.env ────────────────────────────────────────────

  const oracleEnvPath = path.join(__dirname, '../../oracle/.env');
  if (fs.existsSync(oracleEnvPath)) {
    let oracleEnv = fs.readFileSync(oracleEnvPath, 'utf-8');
    const oracleVar = `ORACLE_REGISTRY_ADDRESS=${address}`;
    if (oracleEnv.includes('ORACLE_REGISTRY_ADDRESS=')) {
      oracleEnv = oracleEnv.replace(/ORACLE_REGISTRY_ADDRESS=.*/, oracleVar);
    } else {
      oracleEnv += `\n${oracleVar}\n`;
    }
    fs.writeFileSync(oracleEnvPath, oracleEnv);
    console.log('✓ ORACLE_REGISTRY_ADDRESS written to oracle/.env');
  }

  console.log('\n=== Next Steps ===');
  console.log('1. Run the Synapse SDK upload for each agent (register-agents.ts)');
  console.log('2. Register each agent with the returned Piece CID');
  console.log('3. Register ERC-8004 identities on Sepolia (register-erc8004.ts)');
}

main().catch((err) => {
  console.error('\n✗ Deploy failed:', err.message);
  process.exit(1);
});
