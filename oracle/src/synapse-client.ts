/**
 * synapse-client.ts
 *
 * Wraps @filoz/synapse-sdk v0.39.0 for GhostMarket oracle uploads.
 * Uses dynamic import() because the SDK is ESM-only.
 *
 * Storage modes available via withCDN option:
 *  - Standard     : withCDN: false (default) — PDP proof-of-storage, USDFC payment rails
 *  - FilBeam/CDN  : withCDN: true  — same PDP backend + CDN layer for fast retrieval
 *  - Filecoin Pin : separate external pinning service (not in this SDK)
 *
 * SDK v0.39.0 uses viem (not ethers). Synapse is initialized via Synapse.create()
 * with a privateKeyToAccount + http transport — no browser wallet needed for the oracle.
 *
 * ⚠️  Uploads require an active Calibration storage provider. If unavailable
 * (e.g. 502 from the provider), uploads are skipped with a warning and a
 * placeholder CID is returned so the rest of the pipeline proceeds.
 */

import dotenv from 'dotenv';
dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _synapse: any = null;

const ENABLE_CDN_FALLBACK = (process.env.SYNAPSE_ENABLE_CDN_FALLBACK ?? 'true') === 'true';
const MAX_UPLOAD_ATTEMPTS = Math.max(1, Number(process.env.SYNAPSE_MAX_UPLOAD_ATTEMPTS ?? 4));
const BASE_BACKOFF_MS = Math.max(200, Number(process.env.SYNAPSE_RETRY_BASE_MS ?? 500));
const AUTO_FUND = (process.env.SYNAPSE_AUTO_FUND ?? 'true') === 'true';
const ENABLE_PIN_FALLBACK = (process.env.SYNAPSE_ENABLE_PIN_FALLBACK ?? 'true') === 'true';
const PIN_IPNI_MAX_ATTEMPTS = Math.max(1, Number(process.env.SYNAPSE_PIN_IPNI_MAX_ATTEMPTS ?? 8));
const PIN_IPNI_DELAY_MS = Math.max(1000, Number(process.env.SYNAPSE_PIN_IPNI_DELAY_MS ?? 5000));
const USE_FILECOIN_PIN_CORE_FLOW = (process.env.SYNAPSE_USE_FILECOIN_PIN_CORE_FLOW ?? 'true') === 'true';
const PREFERRED_PROVIDER_ADDRESS = process.env.SYNAPSE_PREFERRED_PROVIDER_ADDRESS?.trim() ?? '';
const PIN_PROVIDER_IDS = (process.env.SYNAPSE_PIN_PROVIDER_IDS ?? '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean)
  .map(v => BigInt(v));

async function getSynapse() {
  if (_synapse) return _synapse;

  const privateKey = process.env.CALIBRATION_PRIVATE_KEY;
  const rpcURL = process.env.CALIBRATION_RPC_URL ?? 'https://filecoin-calibration.drpc.org';

  if (!privateKey) throw new Error('CALIBRATION_PRIVATE_KEY not set in oracle/.env');

  const { Synapse, calibration } = await import('@filoz/synapse-sdk');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { http } = await import('viem');

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const instance = Synapse.create({
    account,
    transport: http(rpcURL),
    chain: calibration,
    withCDN: true,
    source: 'ghost-oracle',
  });

  _synapse = instance;
  return instance;
}

function resetSynapseCache() {
  _synapse = null;
}

// Minimum piece size enforced by the Synapse SDK (127 bytes)
const MIN_SIZE = 127;

function padToMinSize(data: Uint8Array): Uint8Array {
  if (data.byteLength >= MIN_SIZE) return data;
  const padded = new Uint8Array(MIN_SIZE);
  padded.set(data);
  return padded;
}

function isRetriableSynapseError(error: unknown): boolean {
  const message = (error as Error)?.message?.toLowerCase?.() ?? '';
  return (
    message.includes('fetch failed') ||
    message.includes('bad gateway') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('failed ping validation') ||
    message.includes('selectproviderwithping')
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Runs synapse.storage.prepare() and executes any required deposit/approval
 * transaction so the subsequent upload has sufficient funds.
 */
async function ensurePaymentReady(
  synapse: Awaited<ReturnType<typeof getSynapse>>,
  dataSize: bigint,
): Promise<void> {
  const prepare = await synapse.storage.prepare({ dataSize });
  if (!prepare.transaction) return;

  if (!AUTO_FUND) {
    throw new Error(
      `insufficient Filecoin Pay funds (${prepare.transaction.depositAmount.toString()} wei USDFC needed)`,
    );
  }

  console.log(
    `[Synapse] funding Filecoin Pay (deposit: ${prepare.transaction.depositAmount} wei USDFC, includes approval: ${prepare.transaction.includesApproval})...`,
  );
  await prepare.transaction.execute();
}

/**
 * Resolves the preferred provider ID from SYNAPSE_PREFERRED_PROVIDER_ADDRESS
 * if set, so the upload can be directed to a specific provider.
 */
async function resolvePreferredProviderIds(
  synapse: Awaited<ReturnType<typeof getSynapse>>,
): Promise<bigint[] | undefined> {
  if (!PREFERRED_PROVIDER_ADDRESS) return undefined;
  try {
    const info = await synapse.getProviderInfo(PREFERRED_PROVIDER_ADDRESS as `0x${string}`);
    return [info.id];
  } catch {
    console.warn(
      `[Synapse] could not resolve preferred provider ${PREFERRED_PROVIDER_ADDRESS}; using smart selection`,
    );
    return undefined;
  }
}

async function uploadOnce(
  synapse: Awaited<ReturnType<typeof getSynapse>>,
  data: Uint8Array,
  label: string,
  withCDN: boolean,
): Promise<string> {
  const providerIds = await resolvePreferredProviderIds(synapse);
  const tag = `[Synapse${withCDN ? '/CDN' : ''}]`;

  // Resolve as soon as onStored fires — the PieceCID is content-addressed and
  // immutable from this point.  onPiecesAdded / onPiecesConfirmed are dataset
  // bookkeeping steps that may take another 30-60s; they run in the background
  // and do not need to block the caller.
  let resolveOuter!: (cid: string) => void;
  let rejectOuter!:  (err: Error) => void;
  let storedCid = '';

  const outerPromise = new Promise<string>((res, rej) => {
    resolveOuter = res;
    rejectOuter  = rej;
  });

  synapse.storage.upload(data, {
    withCDN,
    ...(providerIds ? { providerIds } : {}),
    callbacks: {
      onStored: (_providerId: bigint, pieceCid: { toString(): string }) => {
        storedCid = pieceCid.toString();
        console.log(`${tag} ✓ ${label} → PieceCID: ${storedCid}`);
        resolveOuter(storedCid);   // ← resolve immediately; don't wait for confirmation
      },
      onPiecesAdded: (tx: string) =>
        console.log(`${tag} Pieces added to data set (tx: ${tx})`),
      onPiecesConfirmed: (dataSetId: bigint) =>
        console.log(`${tag} Confirmed in data set ${dataSetId}`),
    },
  }).then((result: { copies: { retrievalUrl: string; role: string }[]; failures: { error: string }[]; pieceCid: { toString(): string } }) => {
    if (!storedCid) {
      // onStored never fired but upload resolved — shouldn't happen, but handle it
      if (result.copies.length === 0) {
        const reasons = result.failures.map((f) => f.error).join('; ');
        rejectOuter(new Error(`all provider uploads failed: ${reasons || 'unknown reason'}`));
        return;
      }
      resolveOuter(result.pieceCid.toString());
    }
    for (const copy of result.copies) {
      console.log(`${tag} retrieval URL (${copy.role}): ${copy.retrievalUrl}`);
    }
  }).catch((err: Error) => {
    if (!storedCid) {
      // Failed before onStored — reject the caller
      rejectOuter(err);
    } else {
      // Failed after onStored — CID is valid and data is retrievable, but the
      // Filecoin data-set confirmation (PDP proof) did not land on-chain.
      // Log prominently so it can be cross-referenced on Calibration explorer.
      console.error(
        `${tag} ⚠ PDP confirmation failed for ${label} (PieceCID: ${storedCid}): ${err.message}\n` +
        `  Data is still retrievable but on-chain storage proof may be missing.\n` +
        `  Verify at: https://calibration.filfox.info/en/search?q=${storedCid}`,
      );
    }
  });

  return outerPromise;
}

async function uploadWithRetries(
  data: Uint8Array,
  label: string,
  withCDN = false,
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    const synapse = await getSynapse();
    try {
      if (attempt === 1) {
        await ensurePaymentReady(synapse, BigInt(data.byteLength));
      }
      return await uploadOnce(synapse, data, label, withCDN);
    } catch (err) {
      lastError = err as Error;
      const retriable = isRetriableSynapseError(err);
      const canRetry = retriable && attempt < MAX_UPLOAD_ATTEMPTS;
      if (!canRetry) break;
      const backoffMs = BASE_BACKOFF_MS * (2 ** (attempt - 1));
      console.warn(
        `[Synapse${withCDN ? '/CDN' : ''}] upload retry ${attempt}/${MAX_UPLOAD_ATTEMPTS - 1} for ${label}: ${lastError.message}`,
      );
      resetSynapseCache();
      await sleep(backoffMs);
    }
  }

  throw lastError ?? new Error('Synapse upload failed');
}

async function buildPinCar(
  payload: object,
  label: string,
): Promise<{ rootCid: string; carBytes: Uint8Array }> {
  const { CarWriter } = await import('@ipld/car/writer');
  const { importer } = await import('ipfs-unixfs-importer');
  const { CID } = await import('multiformats/cid');

  const encoder = new TextEncoder();
  const raw = encoder.encode(JSON.stringify(payload, null, 2));

  class MemoryBlockstore {
    private readonly blocks = new Map<string, Uint8Array>();

    async put(cid: { toString(): string }, bytes: Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
      if (bytes instanceof Uint8Array) {
        this.blocks.set(cid.toString(), bytes);
        return;
      }
      const chunks: Uint8Array[] = [];
      if (Symbol.asyncIterator in Object(bytes)) {
        for await (const chunk of bytes as AsyncIterable<Uint8Array>) chunks.push(chunk);
      } else {
        for (const chunk of bytes as Iterable<Uint8Array>) chunks.push(chunk);
      }
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      this.blocks.set(cid.toString(), merged);
    }

    async *entries() {
      for (const [key, bytes] of this.blocks.entries()) {
        yield { cid: CID.parse(key), bytes };
      }
    }
  }

  const filePath = `${label.replace(/[^a-zA-Z0-9._-]+/g, '-')}.json`;
  const blockstore = new MemoryBlockstore();
  let rootCid = '';

  async function* source() {
    yield {
      path: filePath,
      content: (async function* () { yield raw; })(),
    };
  }

  for await (const entry of importer(source(), blockstore as never, {
    cidVersion: 1,
    wrapWithDirectory: false,
    rawLeaves: true,
  })) {
    rootCid = entry.cid.toString();
  }

  if (!rootCid) throw new Error('Filecoin Pin CAR build failed (no root CID)');

  const { writer, out } = await CarWriter.create([CID.parse(rootCid)]);
  const chunks: Uint8Array[] = [];
  const collect = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  for await (const { cid, bytes } of blockstore.entries()) {
    await writer.put({ cid, bytes });
  }
  await writer.close();
  await collect;

  const size = chunks.reduce((n, c) => n + c.byteLength, 0);
  const carBytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    carBytes.set(c, offset);
    offset += c.byteLength;
  }

  return { rootCid, carBytes };
}

async function uploadToFilecoinPinCoreFlow(
  payload: object,
  label: string,
): Promise<string> {
  const privateKey = process.env.CALIBRATION_PRIVATE_KEY as `0x${string}` | undefined;
  const rpcUrl = process.env.CALIBRATION_RPC_URL ?? 'https://filecoin-calibration.drpc.org';
  if (!privateKey) throw new Error('CALIBRATION_PRIVATE_KEY not set in oracle/.env');

  // Runtime module loading avoids TS moduleResolution constraints in this CJS project.
  const loadModule = new Function('p', 'return import(p)') as (specifier: string) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const { initializeSynapse, calibration } = await loadModule('filecoin-pin/core/synapse');
  const { checkUploadReadiness, executeUpload } = await loadModule('filecoin-pin/core/upload');
  const { CID } = await import('multiformats/cid');

  const pinSynapse = await initializeSynapse({
    privateKey,
    rpcUrl,
    chain: calibration,
    withCDN: true,
  });

  const { rootCid, carBytes } = await buildPinCar(payload, label);
  const readiness = await checkUploadReadiness({
    synapse: pinSynapse,
    fileSize: carBytes.length,
    autoConfigureAllowances: true,
  });

  if (readiness.status === 'blocked') {
    const suggestions = readiness.suggestions.join('; ') || 'readiness check blocked upload';
    throw new Error(`filecoin-pin readiness blocked: ${suggestions}`);
  }

  const logger = {
    info: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
    debug: (...args: unknown[]) => console.debug(...args),
  };

  const result = await executeUpload(pinSynapse, carBytes, CID.parse(rootCid), {
    logger: logger as never,
    contextId: `oracle-${label}`,
    pieceMetadata: { label, source: 'ghost-oracle' },
    ipniValidation: {
      enabled: true,
      maxAttempts: PIN_IPNI_MAX_ATTEMPTS,
      delayMs: PIN_IPNI_DELAY_MS,
    },
    providerIds: PIN_PROVIDER_IDS.length > 0 ? PIN_PROVIDER_IDS : undefined,
  });

  if (!result.ipniValidated) {
    throw new Error(`filecoin-pin upload completed but IPNI validation failed for root CID ${rootCid}`);
  }
  console.log(`[Filecoin Pin] upload + IPNI validation succeeded for root CID ${rootCid}`);
  return result.pieceCid;
}

/**
 * Upload arbitrary JSON to Filecoin Onchain Cloud via Synapse SDK (Standard mode).
 * Returns the PieceCID string — content-addressed permanent storage.
 *
 * Falls back to a placeholder CID if the storage provider is temporarily down.
 */
export async function uploadToFilecoin(
  payload: object,
  label:   string,
): Promise<string> {
  const encoder = new TextEncoder();
  const raw  = encoder.encode(JSON.stringify(payload, null, 2));
  const data = padToMinSize(raw);

  console.log(`[Synapse] Uploading ${label} (${data.byteLength} bytes) to Filecoin Calibration...`);

  try {
    return await uploadWithRetries(data, label, true);
  } catch (err) {
    const firstError = err as Error;
    if (!ENABLE_CDN_FALLBACK) {
      console.warn(`[Synapse] upload failed for ${label}: ${firstError.message}`);
      return `placeholder:${label.replace(/\s+/g, '-')}`;
    }

    console.warn(`[Synapse] CDN upload failed for ${label}; retrying without CDN: ${firstError.message}`);
    try {
      return await uploadWithRetries(data, label, false);
    } catch (fallbackErr) {
      console.warn(`[Synapse] CDN fallback failed for ${label}: ${(fallbackErr as Error).message}`);
      if (ENABLE_PIN_FALLBACK) {
        try {
          console.warn(
            `[Filecoin Pin] attempting ${USE_FILECOIN_PIN_CORE_FLOW ? 'core upload flow' : 'legacy pin fallback'} for ${label}...`,
          );
          if (USE_FILECOIN_PIN_CORE_FLOW) {
            return await uploadToFilecoinPinCoreFlow(payload, label);
          }
          return await uploadWithRetries((await buildPinCar(payload, label)).carBytes, `${label}-pin-car`, false);
        } catch (pinErr) {
          console.warn(`[Filecoin Pin] fallback failed for ${label}: ${(pinErr as Error).message}`);
        }
      }
      return `placeholder:${label.replace(/\s+/g, '-')}`;
    }
  }
}

/**
 * Download data from Filecoin by PieceCID.
 */
export async function downloadFromFilecoin(pieceCid: string): Promise<object> {
  const synapse = await getSynapse();
  const bytes = await synapse.storage.download({ pieceCid, withCDN: true });
  // Strip null-byte padding added by padToMinSize before JSON parsing.
  const text = new TextDecoder().decode(bytes).replace(/\0+$/, '');
  return JSON.parse(text);
}

/**
 * Get current USDFC wallet balance for the oracle service account.
 */
export async function getUSDFCBalance(): Promise<string> {
  const { formatUnits } = await import('@filoz/synapse-sdk');
  const synapse  = await getSynapse();
  const raw      = await synapse.payments.walletBalance({ token: 'USDFC' });
  const decimals = synapse.payments.decimals();
  return formatUnits(raw, decimals);
}
