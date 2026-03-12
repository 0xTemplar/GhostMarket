/**
 * setup-lit-pkp.ts — One-time Lit Protocol PKP setup for GhostMarket oracle.
 *
 * Mints a PKP on Naga Dev (free, no payment required, no explorer UI needed)
 * and grants the Lit Action permission to sign with it.
 *
 * Safe to re-run: if LIT_PKP_PUBLIC_KEY is already set in .env the mint step
 * is skipped and only the permitted action is added.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.json scripts/setup-lit-pkp.ts
 *   # or:
 *   npm run lit:setup
 *
 * Required env vars (in oracle/.env):
 *   CALIBRATION_PRIVATE_KEY (or LIT_AUTH_PRIVATE_KEY) — oracle EOA key
 *
 * Optional (set before running to also add permitted action):
 *   LIT_ACTION_IPFS_CID    — IPFS CID from running: npm run lit:pin
 *   LIT_PKP_PUBLIC_KEY     — if already minted, skips mint step
 */

import dotenv                       from 'dotenv';
import { createLitClient }          from '@lit-protocol/lit-client';
import { nagaDev }                  from '@lit-protocol/networks';
import { ViemAccountAuthenticator } from '@lit-protocol/auth';
import { privateKeyToAccount }      from 'viem/accounts';

dotenv.config();

const LIT_AUTH_PRIVATE_KEY = (
  process.env.LIT_AUTH_PRIVATE_KEY ??
  process.env.CALIBRATION_PRIVATE_KEY ??
  ''
) as `0x${string}`;

const LIT_ACTION_IPFS_CID  = process.env.LIT_ACTION_IPFS_CID  ?? '';
const EXISTING_PKP_PUBKEY  = process.env.LIT_PKP_PUBLIC_KEY   ?? '';

async function main() {
  if (!LIT_AUTH_PRIVATE_KEY || !LIT_AUTH_PRIVATE_KEY.startsWith('0x')) {
    console.error('\n❌  Set CALIBRATION_PRIVATE_KEY (or LIT_AUTH_PRIVATE_KEY) in oracle/.env');
    process.exit(1);
  }

  const account = privateKeyToAccount(LIT_AUTH_PRIVATE_KEY);
  console.log(`\n🔑  Oracle EOA: ${account.address}`);

  // ── 1. Connect to Naga Dev ──────────────────────────────────────────────────
  // Naga Dev is centralized and free. PKPs are minted via the SDK, not the
  // explorer (explorer.litprotocol.com only shows Datil networks).
  console.log('\n⏳  Connecting to Lit Protocol Naga Dev…');
  const litClient = await createLitClient({ network: nagaDev });
  console.log('✅  Connected to Naga Dev');

  // ── 2. Authenticate with EOA ────────────────────────────────────────────────
  console.log('\n⏳  Authenticating EOA…');
  const authData = await ViemAccountAuthenticator.authenticate(account);
  console.log('✅  Authenticated');

  let pkpPublicKey: string;
  let pkpEthAddress: string;
  let pkpTokenId: string;

  // ── 3. Mint PKP (skipped if LIT_PKP_PUBLIC_KEY already set) ────────────────
  if (EXISTING_PKP_PUBKEY) {
    // PKP already minted — just add the permitted action if not yet added.
    // Uses the pubkey identifier so we don't need the tokenId in .env.
    console.log(`\n✅  PKP already minted (LIT_PKP_PUBLIC_KEY is set) — skipping mint`);
    pkpPublicKey  = EXISTING_PKP_PUBKEY;
    pkpEthAddress = process.env.LIT_PKP_ETH_ADDRESS ?? '';
    pkpTokenId    = ''; // not needed when identifying by pubkey
  } else {
    console.log('\n⏳  Minting new PKP on Naga Dev (free)…');
    // mintWithAuth registers the EOA as auth method with sign-anything scope (scope 1).
    // The SDK always sends the PKP to itself (sendPkpToItself: true is hardcoded).
    // sign-anything scope is sufficient for executeJs without addPermittedAction.
    const mintResult = await litClient.mintWithAuth({
      account,
      authData,
      scopes: ['sign-anything'],
    });

    // Walk all likely property paths — SDK returns vary by version
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = mintResult;
    const candidate = r?.pkpData ?? r?.data ?? r;

    pkpPublicKey  =
      candidate?.publicKey   ??
      candidate?.pubkey      ??
      candidate?.pkpPublicKey ??
      r?.publicKey ?? r?.pubkey ?? '';

    pkpEthAddress =
      candidate?.ethAddress  ??
      candidate?.pkpEthAddress ??
      r?.ethAddress ?? '';

    // tokenId may be a BigInt — convert to string for downstream use
    const rawTokenId = candidate?.tokenId ?? candidate?.pkpTokenId ?? r?.tokenId ?? '';
    pkpTokenId = rawTokenId !== '' ? String(rawTokenId) : '';

    if (!pkpPublicKey) {
      // Safely serialize with BigInt support
      const safe = JSON.stringify(mintResult, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v, 2);
      console.error('\n❌  Could not extract PKP info. Full result:');
      console.error(safe);
      process.exit(1);
    }

    console.log('✅  PKP minted successfully');
    console.log(`    Public key:  ${pkpPublicKey}`);
    console.log(`    ETH address: ${pkpEthAddress}`);
    console.log(`    Token ID:    ${pkpTokenId}`);
  }

  // ── 4. Add Lit Action as permitted signer ───────────────────────────────────
  if (!LIT_ACTION_IPFS_CID) {
    console.log('\n⚠️   LIT_ACTION_IPFS_CID not set — skipping permitted action step.');
    console.log('    Pin the Lit Action first:');
    console.log('      npm run lit:pin   (requires PINATA_JWT in .env)');
    console.log('    Then re-run this script with LIT_ACTION_IPFS_CID set.');
  } else {
    console.log(`\n⏳  Adding Lit Action as permitted signer…`);
    console.log(`    IPFS CID: ${LIT_ACTION_IPFS_CID}`);
    try {
      const permissionsManager = await litClient.getPKPPermissionsManager({
        pkpIdentifier: pkpTokenId
          ? { tokenId: pkpTokenId }
          : { publicKey: pkpPublicKey },
        account,
      });

      await permissionsManager.addPermittedAction({
        ipfsId: LIT_ACTION_IPFS_CID,
        scopes: ['sign-anything'],
      });
      console.log('✅  Lit Action permitted on PKP');
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('Not PKP NFT owner')) {
        // mintWithAuth always sends the PKP to itself (SDK default, cannot be overridden).
        // This means addPermittedAction via the EOA fails — but it is NOT required.
        // The EOA auth method was registered with sign-anything scope (scope 1), which
        // grants lit-action-execution:* in the session sig. executeJs will still work.
        console.log('\n⚠️   addPermittedAction skipped (PKP owns itself — SDK default).');
        console.log('    This is fine: EOA auth method has sign-anything scope, which');
        console.log('    grants Lit Action execution rights without an explicit permit.');
      } else {
        console.warn('\n⚠️   Could not add permitted action:', msg);
        console.warn('    Re-run this script to retry.');
      }
    }
  }

  // ── 5. Print env vars ───────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  Paste into oracle/.env:');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`LIT_PKP_PUBLIC_KEY=${pkpPublicKey}`);
  console.log(`LIT_PKP_ETH_ADDRESS=${pkpEthAddress}`);
  console.log('════════════════════════════════════════════════════════════');

  if (!EXISTING_PKP_PUBKEY) {
    console.log('\n📋  Next steps:');
    console.log('  1. Copy the vars above into oracle/.env');
    if (!LIT_ACTION_IPFS_CID) {
      console.log('  2. Pin the Lit Action:  npm run lit:pin');
      console.log('  3. Re-run this script to add the permitted action');
      console.log('  4. Set PKP as vault signer: cd contracts && npx ts-node scripts/update-settlement-signer.ts');
    } else {
      console.log('  2. Set PKP as vault signer: cd contracts && npx ts-node scripts/update-settlement-signer.ts');
      console.log('  3. Start the oracle: npm run dev');
    }
  }
}

main().catch(err => {
  const msg = err?.message ?? String(err);
  console.error('\n❌  Setup failed:', msg);
  process.exit(1);
});
