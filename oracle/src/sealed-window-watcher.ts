/**
 * sealed-window-watcher.ts — GhostEAMM sealed-bid window auto-settlement.
 *
 * Polls GhostEAMM for sealed windows whose `endsAt` has passed but whose
 * `settled` flag is still false.  When found:
 *
 *   1. Calls `settleSealedWindow(marketId, windowIdx)` — grants the on-chain
 *      `resolver` ACL on the post-window pool handles (`FHE.allow`, not `msg.sender`).
 *
 *   2. Gateway-decrypts both pool handles via the Zama KMS (re-encryption
 *      pattern: generate ephemeral keypair → sign EIP-712 → userDecrypt).
 *
 *   3. Calls `publishWindowPrice(marketId, windowIdx, yesTotal, noTotal)` —
 *      emits `PriceRevealed` on-chain so the frontend can animate the reveal.
 *
 * The watcher is a singleton interval started by `startSealedWindowWatcher()`
 * and stopped by `stopSealedWindowWatcher()`.  It is wired into the oracle's
 * HTTP server startup in `index.ts`.
 *
 * Requires:
 *   ORACLE_PRIVATE_KEY | SEPOLIA_PRIVATE_KEY | SETTLEMENT_SIGNER_PRIVATE_KEY — EOA for settle/publish
 *   EAMM_RESOLVER_PRIVATE_KEY — (optional) must match GhostEAMM.resolver() for KMS userDecrypt
 *   GHOST_EAMM_ADDRESS  — deployed GhostEAMM on Sepolia
 *   SEPOLIA_RPC_URL     — (optional) Alchemy / Infura RPC
 *   WATCHED_MARKETS     — (optional) comma-separated market IDs to watch;
 *                         if unset, only markets with active windows are
 *                         detected via `SealedWindowOpened` events.
 */

import { ethers, type TypedDataDomain, type TypedDataField } from 'ethers';
import {
  createInstance,
  SepoliaConfig,
  SepoliaConfigV2,
} from '@zama-fhe/relayer-sdk/node';
import {
  getEammResolverPrivateKey,
  getSepoliaOraclePrivateKey,
} from './sepolia-keys';

// ── Environment ───────────────────────────────────────────────────────────────

const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';
const GHOST_EAMM_ADDRESS = process.env.GHOST_EAMM_ADDRESS ?? '';
const POLL_INTERVAL_MS = Number(process.env.WINDOW_POLL_MS ?? 10_000); // 10 s

// ── ABIs ──────────────────────────────────────────────────────────────────────

const EAMM_ABI = [
  'function resolver() external view returns (address)',
  'function getSealedWindowCount(uint256 marketId) external view returns (uint256)',
  'function getSealedWindow(uint256 marketId, uint256 windowIdx) external view returns (uint64 startsAt, uint64 endsAt, bool settled, bytes32 yesPoolSnapshot, bytes32 noPoolSnapshot)',
  'function getPoolHandles(uint256 marketId) external view returns (bytes32 yesPool, bytes32 noPool)',
  'function settleSealedWindow(uint256 marketId, uint256 windowIdx) external',
  'function publishWindowPrice(uint256 marketId, uint256 windowIdx, uint64 yesTotal, uint64 noTotal) external',
  'event SealedWindowOpened(uint256 indexed marketId, uint256 windowIdx, uint64 startsAt, uint64 endsAt)',
];

// ── Singleton state ───────────────────────────────────────────────────────────

let _provider: ethers.JsonRpcProvider | null = null;
let _txWallet: ethers.Wallet | null = null;
let _decryptWallet: ethers.Wallet | null = null;
let _eamm: ethers.Contract | null = null;
let _fhevm: Awaited<ReturnType<typeof createInstance>> | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Markets we're watching.  Populated from `WATCHED_MARKETS` env var and
 * dynamically extended whenever a `SealedWindowOpened` event is observed.
 */
const watchedMarkets = new Set<string>(
  (process.env.WATCHED_MARKETS ?? '').split(',').filter(Boolean),
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getEamm(): ethers.Contract {
  const txKey = getSepoliaOraclePrivateKey();
  if (!txKey) {
    throw new Error(
      'Sepolia oracle key not set (ORACLE_PRIVATE_KEY, SEPOLIA_PRIVATE_KEY, or SETTLEMENT_SIGNER_PRIVATE_KEY)',
    );
  }
  const resolverKey = getEammResolverPrivateKey();
  if (!resolverKey) {
    throw new Error(
      'EAMM_RESOLVER_PRIVATE_KEY or Sepolia oracle key required for sealed-window KMS decrypt',
    );
  }
  if (!GHOST_EAMM_ADDRESS) throw new Error('GHOST_EAMM_ADDRESS not set');
  if (!_eamm) {
    _provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
    _txWallet = new ethers.Wallet(txKey, _provider);
    _decryptWallet = new ethers.Wallet(resolverKey, _provider);
    _eamm = new ethers.Contract(GHOST_EAMM_ADDRESS, EAMM_ABI, _txWallet);
  }
  return _eamm;
}

/** Logs ACL configuration at startup so operators can verify the decrypt path. */
async function warnIfDecryptSignerNotResolver(): Promise<void> {
  try {
    const eamm = getEamm();
    const onChain = (await eamm.resolver()) as string;
    const owner = (await eamm.owner()) as string;
    const decAddr = _decryptWallet!.address;
    const txAddr = _txWallet!.address;

    if (ethers.getAddress(decAddr) === ethers.getAddress(onChain)) {
      console.log(
        `[SealedWindow] Decrypt signer === on-chain resolver (${decAddr}) ✓`,
      );
      return;
    }

    // If the tx sender is owner, settleSealedWindow will FHE.allow(pool, msg.sender)
    // in addition to resolver, so userDecrypt with the oracle EOA still works.
    if (ethers.getAddress(txAddr) === ethers.getAddress(owner)) {
      console.log(
        `[SealedWindow] Decrypt signer (${decAddr}) != resolver (${onChain}), ` +
          `but tx signer is owner — settleSealedWindow grants msg.sender ACL ✓`,
      );
      return;
    }

    // Neither case — userDecrypt will fail.
    console.warn(
      `[SealedWindow] ⚠ Decrypt signer (${decAddr}) is neither the on-chain resolver (${onChain}) ` +
        `nor the contract owner (${owner}). Set EAMM_RESOLVER_PRIVATE_KEY to the resolver key, ` +
        `or ensure the tx signer is the contract owner.`,
    );
  } catch {
    /* non-fatal */
  }
}

async function getFhevm() {
  if (_fhevm) return _fhevm;
  const network = SEPOLIA_RPC_URL;
  try {
    _fhevm = await createInstance({ ...SepoliaConfig, network });
  } catch {
    _fhevm = await createInstance({ ...SepoliaConfigV2, network });
  }
  return _fhevm;
}

/**
 * Decrypt a single euint64 handle granted to `GhostEAMM.resolver()`.
 *
 * Uses the userDecrypt re-encryption pattern:
 *   1. Generate ephemeral keypair.
 *   2. Sign EIP-712 authorisation with the **resolver** EOA (`EAMM_RESOLVER_PRIVATE_KEY`).
 *   3. KMS re-encrypts handle under the ephemeral key → oracle decrypts locally.
 */
async function decryptHandle(
  handle: string,
  contractAddress: string,
): Promise<bigint> {
  const instance = await getFhevm();
  const wallet = _decryptWallet!;

  const { publicKey, privateKey } = instance.generateKeypair() as {
    publicKey: string;
    privateKey: string;
  };

  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 1;

  const eip712 = instance.createEIP712(
    publicKey,
    [contractAddress],
    startTimestamp,
    durationDays,
  ) as unknown as {
    domain: TypedDataDomain;
    types: Record<string, TypedDataField[]>;
    primaryType: string;
    message: Record<string, unknown>;
  };

  // Relayer SDK includes EIP712Domain in `types`; ethers v6 rejects that as ambiguous
  // with the separate `domain` argument — strip it like viem does internally.
  const { EIP712Domain: _ignored, ...structTypes } = eip712.types;

  const signature = await wallet.signTypedData(
    eip712.domain,
    structTypes,
    eip712.message,
  );

  const results = (await instance.userDecrypt(
    [{ handle, contractAddress }],
    privateKey,
    publicKey,
    signature,
    [contractAddress],
    wallet.address,
    startTimestamp,
    durationDays,
  )) as Record<string, bigint>;

  const key = handle.startsWith('0x')
    ? (handle as `0x${string}`)
    : (`0x${handle}` as `0x${string}`);
  return results[key] ?? 0n;
}

// ── Core poll loop ────────────────────────────────────────────────────────────

async function checkAndSettleWindows(): Promise<void> {
  if (
    !getSepoliaOraclePrivateKey() ||
    !getEammResolverPrivateKey() ||
    !GHOST_EAMM_ADDRESS
  )
    return;

  const eamm = getEamm();
  const latest = await eamm.runner!.provider!.getBlock('latest');
  const nowSecs = BigInt(latest!.timestamp);

  for (const marketIdStr of watchedMarkets) {
    const marketId = BigInt(marketIdStr);

    try {
      const count = (await eamm.getSealedWindowCount(marketId)) as bigint;
      if (count === 0n) continue;

      // Only check the latest window — earlier settled windows are already done.
      const windowIdx = count - 1n;
      const [, endsAt, settled] = (await eamm.getSealedWindow(
        marketId,
        windowIdx,
      )) as [bigint, bigint, boolean, string, string];

      if (settled || nowSecs < endsAt) continue;

      console.log(
        `[SealedWindow] Market ${marketIdStr} window ${windowIdx}: expired — settling…`,
      );

      // Step 1: settle (grants ACL to oracle wallet on pool handles).
      const settleTx = await eamm.settleSealedWindow(marketId, windowIdx);
      await settleTx.wait();
      console.log(
        `[SealedWindow] Settled window ${windowIdx} for market ${marketIdStr} — TX: ${settleTx.hash}`,
      );

      // Step 2: gateway-decrypt the post-window pool totals.
      const [yesHandle, noHandle] = (await eamm.getPoolHandles(marketId)) as [
        string,
        string,
      ];
      const [yesTotal, noTotal] = await Promise.all([
        decryptHandle(yesHandle, GHOST_EAMM_ADDRESS),
        decryptHandle(noHandle, GHOST_EAMM_ADDRESS),
      ]);

      console.log(
        `[SealedWindow] Market ${marketIdStr} window ${windowIdx}: ` +
          `yesTotal=${yesTotal} noTotal=${noTotal} (USDC base units)`,
      );

      // Step 3: publish decrypted price on-chain → emits PriceRevealed.
      const publishTx = await eamm.publishWindowPrice(
        marketId,
        windowIdx,
        yesTotal,
        noTotal,
      );
      await publishTx.wait();
      console.log(
        `[SealedWindow] PriceRevealed published for market ${marketIdStr} ` +
          `window ${windowIdx} — TX: ${publishTx.hash}`,
      );
    } catch (err) {
      console.warn(
        `[SealedWindow] Error processing market ${marketIdStr}: ${(err as Error).message}`,
      );
    }
  }
}

// ── Event listener for dynamic market discovery ───────────────────────────────

function listenForNewWindows(): void {
  if (
    !getSepoliaOraclePrivateKey() ||
    !getEammResolverPrivateKey() ||
    !GHOST_EAMM_ADDRESS
  )
    return;
  const eamm = getEamm();

  eamm.on('SealedWindowOpened', (marketId: bigint) => {
    const id = marketId.toString();
    if (!watchedMarkets.has(id)) {
      console.log(`[SealedWindow] Discovered new market to watch: ${id}`);
      watchedMarkets.add(id);
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startSealedWindowWatcher(): void {
  if (
    !getSepoliaOraclePrivateKey() ||
    !getEammResolverPrivateKey() ||
    !GHOST_EAMM_ADDRESS
  ) {
    console.warn(
      '[SealedWindow] Watcher disabled — oracle key, resolver/decrypt key, or GHOST_EAMM_ADDRESS not set',
    );
    return;
  }

  listenForNewWindows();
  void warnIfDecryptSignerNotResolver();

  _pollTimer = setInterval(() => {
    checkAndSettleWindows().catch((err) => {
      console.warn('[SealedWindow] Poll error:', (err as Error).message);
    });
  }, POLL_INTERVAL_MS);

  console.log(
    `[SealedWindow] Watcher started — polling every ${POLL_INTERVAL_MS / 1000}s`,
  );

  // Run once immediately.
  void checkAndSettleWindows();
}

export function stopSealedWindowWatcher(): void {
  if (_pollTimer !== null) {
    clearInterval(_pollTimer);
    _pollTimer = null;
    console.log('[SealedWindow] Watcher stopped');
  }
}
