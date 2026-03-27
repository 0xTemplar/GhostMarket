/**
 * signer.ts — Flow secp256k1 signing using ethers + Node.js built-in crypto.
 *
 * Flow supports two signing algorithms: P-256 and secp256k1. When you generate
 * your oracle Cadence account key with --sig-algo ECDSA_secp256k1, the same
 * private key format used in Ethereum/ethers works here, with one difference:
 * Flow hashes the signing payload with SHA3-256, not keccak-256.
 *
 * Node.js 20+ ships sha3-256 in the built-in crypto module, so no extra
 * dependencies are needed — ethers is already in this package for ethers.Wallet.
 */

import { createHash } from 'crypto';
import { ethers } from 'ethers';

/**
 * Sign a Flow transaction payload.
 *
 * FCL calls this with the hex-encoded message to sign (the tagged transaction
 * hash). We SHA3-256 hash it and sign with secp256k1, returning r+s as hex.
 */
export function signFlowMessage(privateKey: string, hexMessage: string): string {
  const msgBuf = Buffer.from(hexMessage, 'hex');
  const hash   = createHash('sha3-256').update(msgBuf).digest();

  const normalizedKey = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
  const wallet        = new ethers.Wallet(normalizedKey);
  const sig           = wallet.signingKey.sign(hash);

  // Flow expects r+s concatenated, no 0x prefix (64 bytes total).
  return sig.r.slice(2) + sig.s.slice(2);
}

/**
 * Build an FCL authorization function backed by a local secp256k1 private key.
 *
 * @param address   Cadence account address (with or without 0x)
 * @param privateKey secp256k1 private key (hex, with or without 0x)
 * @param keyIndex  Key index on the account (default 0)
 */
export function buildAuthorizationFunction(
  address:    string,
  privateKey: string,
  keyIndex  = 0,
) {
  return async (account: Record<string, unknown>) => ({
    ...account,
    tempId: `${address}-${keyIndex}`,
    addr:   address,
    keyId:  keyIndex,
    signingFunction: async ({ message }: { message: string }) => ({
      addr:      address,
      keyId:     keyIndex,
      signature: signFlowMessage(privateKey, message),
    }),
  });
}
