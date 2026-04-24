/**
 * eamm-resolver.ts — GhostEAMM on-chain resolution helpers.
 *
 * After oracle quorum this module:
 *   1. Calls GhostEAMM.resolveMarket(marketId, outcome) on Sepolia.
 *   2. Calls GhostEAMM.grantPositionAccess(marketId, user, oracle) so the
 *      oracle wallet can re-encrypt the winner's position via Zama gateway.
 *
 * The oracle wallet must hold the `resolver` role on GhostEAMM
 * (set at deploy time in deploy-sepolia.ts via ORACLE_PRIVATE_KEY).
 */

import { ethers } from 'ethers';

// ── Environment ───────────────────────────────────────────────────────────────

const SEPOLIA_RPC_URL    = process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY ?? '';
const GHOST_EAMM_ADDRESS = process.env.GHOST_EAMM_ADDRESS ?? '';

// ── ABIs (minimal) ────────────────────────────────────────────────────────────

const EAMM_ABI = [
  'function resolveMarket(uint256 marketId, bool outcome) external',
  'function cancelMarket(uint256 marketId) external',
  'function grantPositionAccess(uint256 marketId, address user, address decryptor) external',
  'function getMarketMeta(uint256 marketId) external view returns (uint8 status, bool outcome, uint64 expiryAt)',
  'function hasPosition(uint256 marketId, address user) external view returns (bool)',
];

// ── Singleton provider / wallet ───────────────────────────────────────────────

let _provider: ethers.JsonRpcProvider | null = null;
let _wallet: ethers.Wallet | null = null;
let _eamm: ethers.Contract | null = null;

function getEamm(): ethers.Contract {
  if (!ORACLE_PRIVATE_KEY) throw new Error('ORACLE_PRIVATE_KEY not set');
  if (!GHOST_EAMM_ADDRESS) throw new Error('GHOST_EAMM_ADDRESS not set');
  if (!_eamm) {
    _provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
    _wallet   = new ethers.Wallet(ORACLE_PRIVATE_KEY, _provider);
    _eamm     = new ethers.Contract(GHOST_EAMM_ADDRESS, EAMM_ABI, _wallet);
  }
  return _eamm;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SyncResult {
  status:  'synced' | 'skipped' | 'failed';
  txHash:  string | null;
  message?: string;
}

/**
 * Call GhostEAMM.resolveMarket() on Sepolia.
 *
 * Idempotent: if the market is already resolved the tx is skipped.
 * Non-blocking: called in the background after quorum — does not gate finalization.
 */
export async function resolveEammMarket(
  marketId: string,
  outcome:  boolean,
): Promise<SyncResult> {
  if (!ORACLE_PRIVATE_KEY || !GHOST_EAMM_ADDRESS) {
    console.warn('[EAMM] Skipping resolveMarket — ORACLE_PRIVATE_KEY or GHOST_EAMM_ADDRESS not set');
    return { status: 'skipped', txHash: null };
  }

  try {
    const eamm = getEamm();

    const [currentStatus] = await eamm.getMarketMeta(BigInt(marketId)) as [number, boolean, bigint];
    if (Number(currentStatus) === 1) {
      console.log(`[EAMM] Market ${marketId} already resolved — skipping`);
      return { status: 'synced', txHash: null };
    }

    console.log(`[EAMM] Resolving market ${marketId} (outcome=${outcome})…`);
    const tx      = await eamm.resolveMarket(BigInt(marketId), outcome);
    console.log(`[EAMM] resolveMarket TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[EAMM] Market ${marketId} resolved — block ${receipt.blockNumber}`);
    console.log(`[EAMM] Etherscan: https://sepolia.etherscan.io/tx/${tx.hash}`);

    return { status: 'synced', txHash: tx.hash as string };
  } catch (err) {
    const message = (err as Error).message ?? '';
    console.warn(`[EAMM] resolveMarket failed (non-fatal): ${message}`);
    return { status: 'failed', txHash: null, message };
  }
}

/**
 * Grant the oracle wallet re-encryption access to a user's position.
 *
 * Called after resolveMarket confirms so the oracle can read the winner's
 * euint64 position via the Zama gateway and compute the exact payout amount.
 *
 * In practice, the gateway re-encryption call is made off-chain by the oracle
 * service and the resulting plaintext amount is included in the signed settlement.
 */
export async function grantPositionAccess(
  marketId: string,
  userAddress: string,
): Promise<{ txHash: string | null }> {
  if (!ORACLE_PRIVATE_KEY || !GHOST_EAMM_ADDRESS) {
    return { txHash: null };
  }

  try {
    const eamm          = getEamm();
    const oracleAddress = _wallet!.address;

    const hasPos = await eamm.hasPosition(BigInt(marketId), userAddress);
    if (!hasPos) {
      return { txHash: null };
    }

    const tx      = await eamm.grantPositionAccess(BigInt(marketId), userAddress, oracleAddress);
    const receipt = await tx.wait();
    console.log(
      `[EAMM] grantPositionAccess(${userAddress}) — block ${receipt.blockNumber} TX: ${tx.hash}`,
    );
    return { txHash: tx.hash as string };
  } catch (err) {
    console.warn(`[EAMM] grantPositionAccess failed: ${(err as Error).message}`);
    return { txHash: null };
  }
}
