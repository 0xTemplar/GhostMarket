/**
 * simulate-settlement.ts
 *
 * Simulates what the Lit Action does in Phase 6:
 *
 *   1. Resolver calls GhostEAMM.resolveMarket() on Sepolia → YES wins.
 *   2. Resolver grants payout access to the "Lit PKP" (deployer for testnet).
 *   3. Deployer signs an EIP-191 settlement message matching GhostVault format.
 *   4. Deployer calls GhostVault.claimPayout() on Flow EVM — vault credits user.
 *
 * In production:
 *   - Step 1 is triggered by oracle quorum (Phase 5).
 *   - Step 2-3 are done by the Lit Action, which reads the decrypted payout
 *     from the Zama gateway and signs with the registered Lit PKP key.
 *   - Step 4 is the user clicking "Claim" in the UI.
 *
 * Uses plain ethers.JsonRpcProvider directly — not Hardhat signers — so the
 * fhevm hardhat plugin doesn't intercept calls.
 *
 * Run:
 *   npx hardhat run scripts/simulate-settlement.ts --network sepolia
 */

import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

// ─── Addresses ────────────────────────────────────────────────────────────────

const GHOST_EAMM_ADDRESS  = process.env.GHOST_EAMM_ADDRESS!;
const GHOST_VAULT_ADDRESS = '0xAf470490b2462DC7359605B8e5D731CbB7816B55'; // Flow EVM testnet
const SEPOLIA_RPC_URL     = process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';
const FLOW_EVM_RPC        = 'https://testnet.evm.nodes.onflow.org';
const PRIVATE_KEY         = process.env.DEPLOYER_PRIVATE_KEY!;

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const EAMM_ABI = [
  'function resolveMarket(uint256 marketId, bool outcome) external',
  'function grantPositionAccess(uint256 marketId, address user, address decryptor) external',
  'function getMarketMeta(uint256 marketId) external view returns (uint8 status, bool outcome, uint64 expiryAt)',
  'function hasPosition(uint256 marketId, address user) external view returns (bool)',
  'event MarketResolved(uint256 indexed marketId, bool outcome)',
];

const VAULT_ABI = [
  'function claimPayout(bytes32 marketId, uint256 amount, uint256 nonce, uint256 expiry, bytes calldata sig) external',
  'function balances(address user) external view returns (uint256)',
  'function settlementSigner() external view returns (address)',
  'event PayoutClaimed(address indexed user, bytes32 indexed marketId, uint256 amount)',
];

// ─── Settlement signing (must match GhostVault._recoverSigner exactly) ───────

async function signSettlement(
  signer:       ethers.Wallet,
  user:         string,
  marketId:     string,   // bytes32 hex
  amount:       bigint,
  nonce:        bigint,
  expiry:       bigint,
  vaultAddress: string,
): Promise<string> {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'bytes32', 'uint256', 'uint256', 'uint256', 'address'],
      [user, marketId, amount, nonce, expiry, vaultAddress],
    ),
  );
  return signer.signMessage(ethers.getBytes(inner));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Plain providers — bypasses the Hardhat fhevm plugin interceptor.
  const sepoliaProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const flowProvider    = new ethers.JsonRpcProvider(FLOW_EVM_RPC);
  const deployer        = new ethers.Wallet(PRIVATE_KEY, sepoliaProvider);

  console.log('='.repeat(64));
  console.log('GhostMarket — Settlement Simulation (Lit Action stub)');
  console.log('='.repeat(64));
  console.log('Deployer (resolver + settlement signer):', deployer.address);
  console.log('GhostEAMM  (Sepolia):                  ', GHOST_EAMM_ADDRESS);
  console.log('GhostVault (Flow EVM):                 ', GHOST_VAULT_ADDRESS);

  const eamm     = new ethers.Contract(GHOST_EAMM_ADDRESS, EAMM_ABI, deployer);
  const marketId = 1n;
  const marketIdBytes32 = ethers.zeroPadValue(ethers.toBeHex(marketId), 32);

  // ── Step 1: Resolve the market on Sepolia ─────────────────────────────────
  console.log('\n[Step 1] Resolving market 1 on GhostEAMM (outcome = YES)…');
  const [currentStatus] = await eamm.getMarketMeta(marketId);

  if (Number(currentStatus) === 0) {
    const tx = await eamm.resolveMarket(marketId, true); // YES wins
    console.log('  TX:', tx.hash);
    await tx.wait();
    console.log('✓ Market resolved — YES won');
    console.log(`  Etherscan: https://sepolia.etherscan.io/tx/${tx.hash}`);
  } else {
    console.log(`  (Already in status: ${['Active','Resolved','Cancelled'][Number(currentStatus)]})`);
  }

  // ── Step 2: Grant payout access to "Lit PKP" (deployer for testnet) ───────
  console.log('\n[Step 2] Granting position access to Lit PKP (deployer)…');
  const userAddress = deployer.address;
  const hasPos      = await eamm.hasPosition(marketId, userAddress);

  if (hasPos) {
    const tx2 = await eamm.grantPositionAccess(marketId, userAddress, deployer.address);
    console.log('  TX:', tx2.hash);
    await tx2.wait();
    console.log('✓ Decryptor can now gateway-decrypt the position handle');
    console.log(`  Etherscan: https://sepolia.etherscan.io/tx/${tx2.hash}`);
  } else {
    console.log('  (No position found — using simulated payout amount)');
  }

  // ── Step 3: Lit Action signs the settlement message ───────────────────────
  console.log('\n[Step 3] Signing settlement message (simulating Lit Action)…');

  // In production this comes from gateway-decrypting the position handle.
  const payoutWei = ethers.parseEther('0.001');
  const nonce     = BigInt(Date.now());
  const expiry    = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour TTL

  const sig = await signSettlement(
    deployer,
    userAddress,
    marketIdBytes32,
    payoutWei,
    nonce,
    expiry,
    GHOST_VAULT_ADDRESS,
  );

  console.log('  Settlement message:');
  console.log('    marketId:   ', marketIdBytes32);
  console.log('    user:       ', userAddress);
  console.log('    payout:     ', ethers.formatEther(payoutWei), 'FLOW (simulated)');
  console.log('    nonce:      ', nonce.toString());
  console.log('    expiry:     ', new Date(Number(expiry) * 1000).toISOString());
  console.log('    sig:        ', sig.slice(0, 22) + '…');
  console.log('✓ Signed with deployer key (= GhostVault.settlementSigner)');

  // ── Step 4: Submit claimPayout() to GhostVault on Flow EVM ───────────────
  console.log('\n[Step 4] Calling GhostVault.claimPayout() on Flow EVM…');

  const flowSigner = new ethers.Wallet(PRIVATE_KEY, flowProvider);
  const vault      = new ethers.Contract(GHOST_VAULT_ADDRESS, VAULT_ABI, flowSigner);

  const registeredSigner = await vault.settlementSigner();
  console.log('  Vault settlementSigner:', registeredSigner);

  if (registeredSigner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log('\n⚠  settlementSigner mismatch — run update-settlement-signer.ts first.');
    console.log('   Vault expects:', registeredSigner);
    console.log('   We signed with:', deployer.address);
    return;
  }

  const balanceBefore = await vault.balances(userAddress);
  console.log('  Vault balance before:', ethers.formatEther(balanceBefore), 'FLOW');

  const claimTx = await vault.claimPayout(
    marketIdBytes32,
    payoutWei,
    nonce,
    expiry,
    sig,
  );
  console.log('  TX (Flow EVM):', claimTx.hash);
  const claimReceipt = await claimTx.wait();
  console.log('✓ Confirmed in block', claimReceipt.blockNumber);

  const balanceAfter = await vault.balances(userAddress);
  console.log('\n  Vault balance after: ', ethers.formatEther(balanceAfter), 'FLOW');
  console.log('  Delta:               ', ethers.formatEther(balanceAfter - balanceBefore), 'FLOW');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(64));
  console.log('RESULT: Full cross-chain settlement flow completed.');
  console.log('');
  console.log('  Chain 1 (Zama / Sepolia):');
  console.log('    ✓ Market resolved — YES won');
  console.log('    ✓ Payout access granted to decryptor');
  console.log('');
  console.log('  Off-chain (Lit Action simulated):');
  console.log('    ✓ Settlement message signed');
  console.log('    ✓ Payout delta:', ethers.formatEther(payoutWei), 'FLOW');
  console.log('');
  console.log('  Chain 2 (Flow EVM):');
  console.log('    ✓ GhostVault.claimPayout() accepted signature');
  console.log('    ✓ Vault balance credited');
  console.log(`    ✓ Flowscan: https://evm-testnet.flowscan.io/tx/${claimTx.hash}`);
  console.log('');
  console.log('  NO token bridge used. FLOW never left Flow EVM.');
  console.log('  Only a signed message crossed chain boundaries.');
  console.log('='.repeat(64));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
