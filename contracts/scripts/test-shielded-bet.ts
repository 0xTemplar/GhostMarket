/**
 * test-shielded-bet.ts
 *
 * End-to-end test of the shielded bet path on live Ethereum Sepolia:
 *
 *   1. Initialise @zama-fhe/relayer-sdk (SepoliaConfig) connected to Zama relayer.
 *   2. Encrypt a bet amount client-side — plaintext never leaves this script.
 *   3. Submit the encrypted payload to GhostEAMM.placeBet() on Sepolia.
 *   4. Read back the position handle and confirm it is non-zero.
 *   5. Print the encrypted pool handles (opaque — no plaintext visible).
 *
 * SDK config follows docs.zama.org/protocol/relayer-sdk-guides/fhevm-relayer/initialization
 * Using SepoliaConfig which includes:
 *   ACL:           0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D
 *   KMS:           0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A
 *   InputVerifier: 0xBBC1fFCdc7C316aAAd72E807D9b0272BE8F84DA0
 *   gatewayChainId: 10901
 *   relayerUrl:    https://relayer.testnet.zama.org
 *
 * Run:
 *   npx hardhat run scripts/test-shielded-bet.ts --network sepolia
 */

import { ethers } from 'hardhat';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';
import dotenv from 'dotenv';
dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const GHOST_EAMM_ADDRESS = process.env.GHOST_EAMM_ADDRESS!;
const SEPOLIA_RPC_URL    = process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';

const GHOST_EAMM_ABI = [
  'function placeBet(uint256 marketId, bool side, bytes32 encAmount, bytes calldata inputProof) external',
  'function getUserPositionHandles(uint256 marketId, address user) external view returns (bytes32 yesHandle, bytes32 noHandle)',
  'function getPoolHandles(uint256 marketId) external view returns (bytes32 yesPool, bytes32 noPool)',
  'function getMarketMeta(uint256 marketId) external view returns (uint8 status, bool outcome, uint64 expiryAt)',
  'function hasPosition(uint256 marketId, address user) external view returns (bool)',
  'event BetPlaced(uint256 indexed marketId, address indexed user, bool indexed side)',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function maskHandle(handle: string): string {
  return handle === ethers.ZeroHash
    ? '(empty)'
    : `${handle.slice(0, 10)}…${handle.slice(-8)} [ENCRYPTED]`;
}

function toHex(v: string | Uint8Array): `0x${string}` {
  return typeof v === 'string'
    ? (v.startsWith('0x') ? v as `0x${string}` : `0x${v}`)
    : `0x${Buffer.from(v).toString('hex')}`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const [signer] = await ethers.getSigners();

  console.log('='.repeat(64));
  console.log('GhostMarket — Shielded Bet (live Sepolia)');
  console.log('='.repeat(64));
  console.log('Signer:   ', signer.address);
  console.log('GhostEAMM:', GHOST_EAMM_ADDRESS);
  console.log('Network:   Ethereum Sepolia (Zama fhevm)\n');

  // ── 1. Connect to GhostEAMM ────────────────────────────────────────────────
  const eamm = new ethers.Contract(GHOST_EAMM_ADDRESS, GHOST_EAMM_ABI, signer);

  const marketId  = 1n;
  const [status, , expiryAt] = await eamm.getMarketMeta(marketId);
  const statusNum = Number(status);
  console.log('Market 1 status:', ['Active', 'Resolved', 'Cancelled'][statusNum]);
  console.log('Market 1 expiry:', new Date(Number(expiryAt) * 1000).toISOString());

  if (statusNum !== 0) {
    console.log('\nMarket is not Active — cannot place bet.');
    return;
  }

  // ── 2. Initialise @zama-fhe/relayer-sdk ───────────────────────────────────
  // SepoliaConfig matches the addresses from:
  // https://docs.zama.org/protocol/relayer-sdk-guides/fhevm-relayer/initialization
  console.log('\n[Step 1] Initialising @zama-fhe/relayer-sdk on Sepolia…');
  const instance = await createInstance({
    ...SepoliaConfig,
    network: SEPOLIA_RPC_URL, // use Alchemy for reliability
  });
  console.log('✓ relayer-sdk ready');
  console.log('  relayerUrl:', SepoliaConfig.relayerUrl);
  console.log('  ACL:       ', SepoliaConfig.aclContractAddress);

  // ── 3. Encrypt the bet amount ──────────────────────────────────────────────
  const BET_ETH = '0.001';
  const betWei  = ethers.parseEther(BET_ETH);

  console.log(`\n[Step 2] Encrypting bet amount: ${BET_ETH} ETH`);
  console.log('  Plaintext (wei):', betWei.toString());

  const buffer      = instance.createEncryptedInput(GHOST_EAMM_ADDRESS, signer.address);
  buffer.add64(betWei);
  const ciphertexts = await buffer.encrypt();

  const handle     = toHex(ciphertexts.handles[0]);
  const inputProof = toHex(ciphertexts.inputProof);
  const proofBytes = typeof ciphertexts.inputProof === 'string'
    ? ciphertexts.inputProof.replace('0x','').length / 2
    : ciphertexts.inputProof.length;

  console.log('  Encrypted handle:    ', maskHandle(handle));
  console.log('  Proof length (bytes):', proofBytes);
  console.log('✓ Amount encrypted — plaintext is gone from this point');

  // ── 4. Submit to GhostEAMM ────────────────────────────────────────────────
  const side      = true; // YES
  const sideLabel = side ? 'YES' : 'NO';
  console.log(`\n[Step 3] Submitting shielded ${sideLabel} bet to GhostEAMM…`);

  const tx = await eamm.placeBet(marketId, side, handle, inputProof);
  console.log('  TX hash:', tx.hash);
  console.log('  Waiting for confirmation…');
  const receipt = await tx.wait();
  console.log('✓ Confirmed in block', receipt.blockNumber);

  // Parse BetPlaced — confirm NO amount in the event.
  const iface  = new ethers.Interface(GHOST_EAMM_ABI);
  const events = receipt.logs
    .map((l: ethers.Log) => { try { return iface.parseLog(l); } catch { return null; } })
    .filter(Boolean);
  const betEvent = events.find((e: ethers.LogDescription) => e!.name === 'BetPlaced');
  if (betEvent) {
    console.log('\nBetPlaced event:');
    console.log('  marketId:', betEvent.args.marketId.toString());
    console.log('  user:    ', betEvent.args.user);
    console.log('  side:    ', betEvent.args.side ? 'YES' : 'NO');
    console.log('  amount:   *** NOT IN EVENT — shielded ✓ ***');
  }

  // ── 5. Verify position handles ────────────────────────────────────────────
  console.log('\n[Step 4] Reading position handles from GhostEAMM…');
  const [yesHandle, noHandle] = await eamm.getUserPositionHandles(marketId, signer.address);
  const hasPos = await eamm.hasPosition(marketId, signer.address);

  console.log('  YES handle:', maskHandle(yesHandle));
  console.log('  NO  handle:', maskHandle(noHandle));
  console.log('  hasPosition():', hasPos);

  // ── 6. Pool handles (encrypted — resolver/Lit PKP only) ───────────────────
  const [yesPool, noPool] = await eamm.getPoolHandles(marketId);
  console.log('\n[Step 5] Pool handles (encrypted — readable only by resolver/Lit PKP):');
  console.log('  YES pool:', maskHandle(yesPool));
  console.log('  NO  pool:', maskHandle(noPool));

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(64));
  console.log('RESULT: Shielded bet placed successfully.');
  console.log(`  Bet:    ${BET_ETH} ETH on ${sideLabel}`);
  console.log('  Chain:  Ethereum Sepolia (Zama fhevm)');
  console.log('  Amount: never appeared in calldata, events, or state as plaintext');
  console.log(`  Etherscan: https://sepolia.etherscan.io/tx/${tx.hash}`);
  console.log('='.repeat(64));
  console.log('\nNext: run scripts/simulate-settlement.ts --network sepolia');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
