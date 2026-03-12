/**
 * seed-eamm-bet.ts
 *
 * Seeds a fresh market on the NEW GhostEAMM (Sepolia) and places a shielded bet,
 * so the Lit Protocol settlement flow can be tested end-to-end against live data.
 *
 * Steps:
 *   1. Read existing markets — pick the next unused market ID
 *   2. Create the market on GhostEAMM (onlyMarketManager)
 *   3. Encrypt a bet amount with @zama-fhe/relayer-sdk
 *   4. Place the shielded bet (BetPlaced event emitted)
 *   5. Print the bet tx hash + market ID — feed these into the oracle settle call
 *
 * Usage:
 *   npx hardhat run scripts/seed-eamm-bet.ts --network sepolia
 *
 * Required in contracts/.env:
 *   DEPLOYER_PRIVATE_KEY   — market manager / owner of GhostEAMM
 *   GHOST_EAMM_ADDRESS     — deployed GhostEAMM.sol on Sepolia
 *   SEPOLIA_RPC_URL        — Alchemy Sepolia RPC
 */

import { ethers } from 'hardhat';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';
import dotenv from 'dotenv';
dotenv.config();

const GHOST_EAMM_ADDRESS = process.env.GHOST_EAMM_ADDRESS!;

const EAMM_ABI = [
  'function createMarket(uint256 marketId, uint64 expiryAt) external',
  'function placeBet(uint256 marketId, bool side, bytes32 encAmount, bytes calldata inputProof) external',
  'function getMarketMeta(uint256 marketId) external view returns (uint8 status, bool outcome, uint64 expiryAt)',
  'function hasPosition(uint256 marketId, address user) external view returns (bool)',
  'event BetPlaced(uint256 indexed marketId, address indexed user, bool indexed side)',
];

function toHex(v: string | Uint8Array): `0x${string}` {
  return typeof v === 'string'
    ? (v.startsWith('0x') ? v as `0x${string}` : `0x${v}`)
    : `0x${Buffer.from(v).toString('hex')}`;
}

async function findNextMarketId(eamm: ethers.Contract): Promise<bigint> {
  // Scan IDs 1..20 and return the first one that doesn't exist (status reverts)
  for (let id = 1n; id <= 20n; id++) {
    try {
      const [status] = await eamm.getMarketMeta(id);
      // Status 0=Active, 1=Resolved, 2=Cancelled — all mean the market exists
      console.log(`  Market ${id}: exists (status=${status})`);
    } catch {
      console.log(`  Market ${id}: does not exist — will create here`);
      return id;
    }
  }
  throw new Error('All market IDs 1-20 are taken — extend the scan range');
}

async function main() {
  const [signer] = await ethers.getSigners();
  const eamm = new ethers.Contract(GHOST_EAMM_ADDRESS, EAMM_ABI, signer);

  console.log('='.repeat(64));
  console.log('GhostMarket — Seed EAMM Market + Shielded Bet');
  console.log('='.repeat(64));
  console.log('Signer:   ', signer.address);
  console.log('GhostEAMM:', GHOST_EAMM_ADDRESS);

  // ── 1. Find next available market ID ──────────────────────────────────────
  console.log('\n[Step 1] Scanning for next available market ID…');
  const marketId = await findNextMarketId(eamm);

  // Expiry: 30 days from now
  const expiryAt = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);

  // ── 2. Create the market ──────────────────────────────────────────────────
  console.log(`\n[Step 2] Creating market ${marketId} (expires ${new Date(Number(expiryAt) * 1000).toUTCString()})…`);
  const createTx = await eamm.createMarket(marketId, expiryAt);
  const createReceipt = await createTx.wait();
  console.log(`✓ Market ${marketId} created — block ${createReceipt.blockNumber}`);
  console.log(`  Etherscan: https://sepolia.etherscan.io/tx/${createTx.hash}`);

  // ── 3. Init FHEVM relayer SDK ──────────────────────────────────────────────
  const rpc = process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';
  console.log('\n[Step 3] Initialising @zama-fhe/relayer-sdk…');
  const instance = await createInstance({ ...SepoliaConfig, network: rpc });
  console.log('✓ relayer-sdk ready');

  // ── 4. Encrypt bet amount ──────────────────────────────────────────────────
  const BET_ETH = '0.001';
  const betWei  = ethers.parseEther(BET_ETH);
  const side    = true; // YES

  console.log(`\n[Step 4] Encrypting ${BET_ETH} ETH YES bet…`);
  const buffer      = instance.createEncryptedInput(GHOST_EAMM_ADDRESS, signer.address);
  buffer.add64(betWei);
  const ciphertexts = await buffer.encrypt();
  const handle      = toHex(ciphertexts.handles[0]);
  const inputProof  = toHex(ciphertexts.inputProof);
  console.log('✓ Amount encrypted (plaintext gone)');

  // ── 5. Submit shielded bet ─────────────────────────────────────────────────
  console.log(`\n[Step 5] Placing shielded YES bet on market ${marketId}…`);
  const betTx      = await eamm.placeBet(marketId, side, handle, inputProof);
  const betReceipt = await betTx.wait();
  console.log(`✓ Bet confirmed — block ${betReceipt.blockNumber}`);
  console.log(`  Etherscan: https://sepolia.etherscan.io/tx/${betTx.hash}`);

  // ── Verify BetPlaced event ─────────────────────────────────────────────────
  const iface    = new ethers.Interface(EAMM_ABI);
  const betEvent = betReceipt.logs
    .map((l: ethers.Log) => { try { return iface.parseLog(l); } catch { return null; } })
    .filter(Boolean)
    .find((e: ethers.LogDescription) => e!.name === 'BetPlaced');

  if (betEvent) {
    console.log('\nBetPlaced event:');
    console.log('  marketId:', betEvent.args.marketId.toString());
    console.log('  user:    ', betEvent.args.user);
    console.log('  side:    ', betEvent.args.side ? 'YES' : 'NO');
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(64));
  console.log('SEEDED. Use these values for the oracle settle flow:');
  console.log('='.repeat(64));
  console.log(`  Market ID:    ${marketId}`);
  console.log(`  User address: ${signer.address}`);
  console.log(`  Bet tx hash:  ${betTx.hash}`);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. curl -s -X POST http://localhost:8080/oracle/resolve/${marketId} | jq .`);
  console.log(`     (wait for phase: finalized)`);
  console.log(`  2. npx ts-node oracle/scripts/resolve-ghost-eamm.ts ${marketId} true`);
  console.log(`  3. curl -s -X POST http://localhost:8080/oracle/settle/${marketId} \\`);
  console.log(`       -H "Content-Type: application/json" \\`);
  console.log(`       -d '{"userAddress":"${signer.address}","betTxHash":"${betTx.hash}"}' | jq .`);
  console.log('='.repeat(64));
}

main().catch(e => { console.error(e); process.exitCode = 1; });
