/**
 * lit-smoke-test.ts
 *
 * Minimal known-good Lit Protocol signing flow for GhostMarket:
 * - Connect to Naga Dev
 * - Authenticate EOA
 * - Create PKP auth context
 * - executeJs with inline Lit Action (no RPC calls)
 * - Sign a simple message via PKP and verify recovered address
 *
 * Usage:
 *   npm run lit:smoke
 *   npm run lit:smoke -- "custom message"
 */

import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { createLitClient } from '@lit-protocol/lit-client';
import { nagaDev } from '@lit-protocol/networks';
import {
  createAuthManager,
  storagePlugins,
  ViemAccountAuthenticator,
} from '@lit-protocol/auth';
import { privateKeyToAccount } from 'viem/accounts';

dotenv.config();

const LIT_AUTH_PRIVATE_KEY = (
  process.env.LIT_AUTH_PRIVATE_KEY ??
  process.env.CALIBRATION_PRIVATE_KEY ??
  process.env.SETTLEMENT_SIGNER_PRIVATE_KEY ??
  ''
) as `0x${string}`;

const LIT_PKP_PUBLIC_KEY  = process.env.LIT_PKP_PUBLIC_KEY ?? '';
const LIT_PKP_ETH_ADDRESS = process.env.LIT_PKP_ETH_ADDRESS ?? '';
const LIT_STORAGE_PATH    = process.env.LIT_STORAGE_PATH ?? './lit-auth-storage';

function fail(msg: string): never {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

async function main() {
  if (!LIT_AUTH_PRIVATE_KEY || !LIT_AUTH_PRIVATE_KEY.startsWith('0x')) {
    fail('Missing LIT_AUTH_PRIVATE_KEY (or CALIBRATION_PRIVATE_KEY / SETTLEMENT_SIGNER_PRIVATE_KEY) in oracle/.env');
  }
  if (!LIT_PKP_PUBLIC_KEY) fail('Missing LIT_PKP_PUBLIC_KEY in oracle/.env');
  if (!LIT_PKP_ETH_ADDRESS) fail('Missing LIT_PKP_ETH_ADDRESS in oracle/.env');

  const account = privateKeyToAccount(LIT_AUTH_PRIVATE_KEY);
  const testMessage = process.argv.slice(2).join(' ').trim() || `ghost-lit-smoke-${Date.now()}`;

  console.log('\n=== Lit Protocol Smoke Test ===');
  console.log(`EOA:            ${account.address}`);
  console.log(`PKP Address:    ${LIT_PKP_ETH_ADDRESS}`);
  console.log(`PKP PubKey:     ${LIT_PKP_PUBLIC_KEY.slice(0, 18)}...`);
  console.log(`Test message:   ${testMessage}`);

  console.log('\n1) Connecting to Naga Dev...');
  const litClient = await createLitClient({ network: nagaDev });

  console.log('2) Authenticating EOA...');
  const authData = await ViemAccountAuthenticator.authenticate(account);

  console.log('3) Creating PKP auth context...');
  const authManager = createAuthManager({
    storage: storagePlugins.localStorageNode({
      appName: 'ghost-oracle-smoke',
      networkName: 'naga-dev',
      storagePath: LIT_STORAGE_PATH,
    }),
  });

  const authContext = await authManager.createPkpAuthContext({
    authData,
    pkpPublicKey: LIT_PKP_PUBLIC_KEY,
    authConfig: {
      resources: [
        ['lit-action-execution', '*'],
        ['pkp-signing', '*'],
      ],
      expiration: new Date(Date.now() + 15 * 60_000).toISOString(),
      statement: 'GhostMarket Lit smoke test',
      domain: 'ghost-oracle.local',
    },
    litClient,
  });

  console.log('4) Executing inline Lit Action sign test...');

  const litActionCode = `
const go = async () => {
  const message = jsParams.message;
  const messageHash = ethers.utils.hashMessage(message);

  await Lit.Actions.signEcdsa({
    toSign: ethers.utils.arrayify(messageHash),
    publicKey: jsParams.pkpPublicKey,
    sigName: 'smoke',
  });

  Lit.Actions.setResponse({
    response: JSON.stringify({
      ok: true,
      message,
      messageHash,
    }),
  });
};
go();
`;

  const result = await litClient.executeJs({
    code: litActionCode,
    authContext,
    jsParams: {
      message: testMessage,
      pkpPublicKey: LIT_PKP_PUBLIC_KEY,
    },
  });

  const payload = typeof result.response === 'string'
    ? JSON.parse(result.response)
    : result.response;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sigShare = (result.signatures as Record<string, any>)?.smoke;
  if (!sigShare) {
    fail('Lit Action returned no signature at signatures.smoke');
  }

  const normalizeHex = (value: unknown, field: string): string => {
    if (typeof value === 'string') {
      return value.startsWith('0x') ? value : `0x${value}`;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      return `0x${BigInt(value).toString(16)}`;
    }
    fail(`Signature field '${field}' missing or invalid. Raw share: ${JSON.stringify(sigShare)}`);
  };

  let signature = '';
  if (typeof sigShare.signature === 'string') {
    const rawSig = normalizeHex(sigShare.signature, 'signature');
    const recid = typeof sigShare.recoveryId === 'number'
      ? sigShare.recoveryId
      : Number(sigShare.recoveryId ?? 0);

    // Some Lit SDK responses return r||s without v (64-byte hex + separate recoveryId).
    // Convert to canonical 65-byte ECDSA signature expected by ethers recover helpers.
    if (rawSig.length === 130) {
      const v = recid === 1 ? 28 : 27;
      signature = `${rawSig}0x`.replace('0x0x', '0x'); // keep ts happy then override below
      signature = `${rawSig}${v.toString(16).padStart(2, '0')}`;
    } else {
      signature = rawSig;
    }
  } else {
    const r = normalizeHex(sigShare.r, 'r');
    const s = normalizeHex(sigShare.s, 's');
    const recid = typeof sigShare.recid === 'number'
      ? sigShare.recid
      : Number(sigShare.recoveryId ?? sigShare.recid ?? 0);
    const v = recid === 1 ? 28 : 27;
    signature = ethers.hexlify(
      ethers.concat([r, s, `0x${v.toString(16).padStart(2, '0')}`]),
    );
  }

  const recovered = ethers.recoverAddress(payload.messageHash as string, signature).toLowerCase();
  const expected = LIT_PKP_ETH_ADDRESS.toLowerCase();
  const ok = recovered === expected;

  console.log('\n5) Verifying signature...');
  console.log(`Message hash:    ${payload.messageHash}`);
  console.log(`Recovered addr:  ${recovered}`);
  console.log(`Expected PKP:    ${expected}`);
  console.log(`Signature:       ${signature}`);

  if (!ok) {
    fail('Signature verification mismatch. Lit signing path is not healthy yet.');
  }

  console.log('\n✅ Smoke test PASSED');
  console.log('   Lit auth + executeJs + PKP signing are working end-to-end.');
  console.log('   You can now layer your settlement logic on top with confidence.');
}

main().catch((err) => {
  fail(`Smoke test failed: ${err?.message ?? String(err)}`);
});
