/**
 * vault-reporter.ts — Oracle-side utility for reporting market outcomes to
 * GhostVault on Flow EVM.
 *
 * Payout model:
 *   - Winners receive their exact locked stake back.
 *   - Losers receive 0.
 *
 * Pool-depth aggregates (total YES / NO locked) are never written to GhostVault.
 * They remain FHE-encrypted inside GhostEAMM on Sepolia throughout the market
 * lifecycle — including after resolution. This keeps the privacy boundary clean.
 *
 * computeExpectedPayout() is live on-chain after reportOutcome() confirms, so
 * any claim signed by the oracle is validated against that formula. The oracle
 * cannot manipulate individual payout amounts.
 */

import { ethers } from 'ethers';
import dotenv      from 'dotenv';

dotenv.config();

const FLOW_RPC_URL        = process.env.FLOW_RPC_URL ?? 'https://testnet.evm.nodes.onflow.org';
const GHOST_VAULT_ADDRESS = process.env.GHOST_VAULT_ADDRESS ?? '';
// reportOutcome() is onlyOwner — must use the vault deployer key, not the settlement signer key
const ORACLE_PRIVATE_KEY  = process.env.VAULT_OWNER_PRIVATE_KEY ?? process.env.SETTLEMENT_SIGNER_PRIVATE_KEY ?? '';

const VAULT_ABI = [
  'function reportOutcome(bytes32 marketId, bool outcome) external',
  'function isResolved(bytes32 marketId) external view returns (bool)',
];

export interface VaultOutcomeSync {
  status:  'synced' | 'skipped' | 'failed' | 'already_set';
  txHash:  string | null;
  message: string;
}

/**
 * Report the oracle-determined market outcome to GhostVault on Flow EVM.
 *
 * @param marketIdUint  GhostEAMM uint256 market ID (as decimal string).
 * @param outcome       true = YES won, false = NO won.
 */
export async function reportOutcomeToVault(
  marketIdUint: string,
  outcome:      boolean,
): Promise<VaultOutcomeSync> {
  if (!GHOST_VAULT_ADDRESS || !ORACLE_PRIVATE_KEY) {
    return {
      status:  'skipped',
      txHash:  null,
      message: 'GHOST_VAULT_ADDRESS or SETTLEMENT_SIGNER_PRIVATE_KEY not configured',
    };
  }

  const marketIdBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(marketIdUint)), 32);

  try {
    const provider = new ethers.JsonRpcProvider(FLOW_RPC_URL);
    const wallet   = new ethers.Wallet(ORACLE_PRIVATE_KEY, provider);
    const vault    = new ethers.Contract(GHOST_VAULT_ADDRESS, VAULT_ABI, wallet);

    const alreadySet: boolean = await vault.isResolved(marketIdBytes32).catch(() => false);
    if (alreadySet) {
      return {
        status:  'already_set',
        txHash:  null,
        message: `GhostVault outcome already reported for market ${marketIdUint}`,
      };
    }

    console.log(
      `[VaultReporter] Reporting outcome ${outcome ? 'YES' : 'NO'} for market ${marketIdUint}…`,
    );

    const tx = await vault.reportOutcome(marketIdBytes32, outcome);
    console.log(`[VaultReporter] TX submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[VaultReporter] Confirmed in block ${receipt.blockNumber}`);

    return {
      status:  'synced',
      txHash:  tx.hash as string,
      message: `Outcome ${outcome ? 'YES' : 'NO'} reported to GhostVault (block ${receipt.blockNumber})`,
    };
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown error';
    console.error('[VaultReporter] reportOutcome failed:', msg);
    return {
      status:  'failed',
      txHash:  null,
      message: msg,
    };
  }
}
