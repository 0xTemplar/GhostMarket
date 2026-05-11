/**
 * oracle-signer.ts — Direct EIP-712 settlement signer.
 *
 *  After oracle quorum:
 *   1. eamm-resolver.ts calls GhostEAMM.resolveMarket() on Sepolia.
 *   2. eamm-resolver.ts grants position access and reads Zama gateway.
 *   3. This module signs the EIP-712 settlement message with the oracle wallet.
 *   4. The signed claim is served to the user who submits it to GhostVault.claimPayout().
 *
 * The oracle wallet IS the settlementSigner in GhostVault — set at deploy time.
 * To rotate the signer, call GhostVault.setSettlementSigner() from the owner.
 */

import { ethers } from 'ethers';

// ── Environment ───────────────────────────────────────────────────────────────

const ORACLE_PRIVATE_KEY  = process.env.ORACLE_PRIVATE_KEY ?? '';
const SEPOLIA_RPC_URL     = process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';
const GHOST_VAULT_ADDRESS = process.env.GHOST_VAULT_ADDRESS ?? '';

// ── EIP-712 domain + typehash — must match GhostVault.sol exactly ─────────────

const DOMAIN_NAME    = 'GhostVault';
const DOMAIN_VERSION = '1';
const CHAIN_ID       = 11155111; // Ethereum Sepolia

const CLAIM_TYPE = {
  Claim: [
    { name: 'user',         type: 'address' },
    { name: 'marketId',     type: 'bytes32' },
    { name: 'amountHandle', type: 'bytes32' },
    { name: 'nonce',        type: 'uint256' },
    { name: 'expiry',       type: 'uint256' },
  ],
};

// ── Signer singleton ──────────────────────────────────────────────────────────

let _wallet: ethers.Wallet | null = null;

function getOracleWallet(): ethers.Wallet {
  if (!ORACLE_PRIVATE_KEY) {
    throw new Error('ORACLE_PRIVATE_KEY not set — cannot sign settlement messages');
  }
  if (!_wallet) {
    const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
    _wallet = new ethers.Wallet(ORACLE_PRIVATE_KEY, provider);
  }
  return _wallet;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SignSettlementParams {
  userAddress:    string;
  marketIdUint:   string;   // decimal string, e.g. "21"
  marketIdBytes32: string;  // 0x-padded 32-byte hex
  nonce:          string;
  expiry:         string;
  payout:         string;   // wei as decimal string
}

export interface SignedSettlement {
  sig:           string;
  payout:        string;
  nonce:         string;
  expiry:        string;
  signerAddress: string;
  path:          'oracle';
}

/**
 * Sign an EIP-712 settlement claim with the oracle wallet.
 *
 * The signature is valid for GhostVault.claimPayout() on Sepolia.
 * The vault verifies: recovered address == settlementSigner (oracle wallet).
 */
export async function signSettlement(
  params: SignSettlementParams,
): Promise<SignedSettlement> {
  const wallet = getOracleWallet();

  const domain = {
    name:              DOMAIN_NAME,
    version:           DOMAIN_VERSION,
    chainId:           CHAIN_ID,
    verifyingContract: GHOST_VAULT_ADDRESS as `0x${string}`,
  };

  const value = {
    user:         params.userAddress,
    marketId:     params.marketIdBytes32,
    amountHandle: params.payout,
    nonce:        BigInt(params.nonce),
    expiry:       BigInt(params.expiry),
  };

  const sig = await wallet.signTypedData(domain, CLAIM_TYPE, value);

  return {
    sig,
    payout:        params.payout,
    nonce:         params.nonce,
    expiry:        params.expiry,
    signerAddress: wallet.address,
    path:          'oracle',
  };
}

/**
 * Generate a fresh nonce + expiry pair for a settlement message.
 * Nonce: random 48-bit integer (fits safely in uint256).
 * Expiry: 24 hours from now.
 */
export function freshNonceExpiry(): { nonce: string; expiry: string } {
  const nonce  = String(Math.floor(Math.random() * 2 ** 48));
  const expiry = String(Math.floor(Date.now() / 1000) + 86400); // 24h
  return { nonce, expiry };
}

/**
 * Return the oracle wallet's address (the on-chain settlementSigner).
 * Used to verify that the vault's recorded signer matches the current key.
 */
export function getOracleSignerAddress(): string {
  return getOracleWallet().address;
}
