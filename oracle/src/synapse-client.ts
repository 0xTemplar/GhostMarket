/**
 * synapse-client.ts
 *
 * Wraps @filoz/synapse-sdk v1.0.0 for GhostMarket oracle uploads.
 * Uses dynamic import() because the SDK is ESM-only.
 *
 * Storage modes available via withCDN flag:
 *  - Standard     : withCDN: false (default) — PDP proof-of-storage, USDFC payment rails
 *  - FilBeam/CDN  : withCDN: true  — same PDP backend + CDN layer for fast retrieval
 *  - Filecoin Pin : separate external pinning service (not in this SDK)
 *
 * We use Standard mode. Oracle uploads are permanent evidence bundles,
 * reputation snapshots, slash records, and agent metadata on Filecoin Calibration.
 *
 * ⚠️  Uploads require an active Calibration storage provider. If unavailable
 * (e.g. 502 from the provider), uploads are skipped with a warning and a
 * placeholder CID is returned so the rest of the pipeline proceeds.
 */

import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _synapse: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _storage: any = null;
let _storageUnavailable = false;  // set on first provider failure; avoids repeated pings

async function getSynapse() {
  if (_synapse) return _synapse;

  const privateKey = process.env.CALIBRATION_PRIVATE_KEY;
  const rpcURL     = process.env.CALIBRATION_RPC_URL ?? 'https://filecoin-calibration.drpc.org';

  if (!privateKey) throw new Error('CALIBRATION_PRIVATE_KEY not set in oracle/.env');

  const { Synapse } = await import('@filoz/synapse-sdk');
  _synapse = await Synapse.create({ privateKey, rpcURL, withCDN: false });
  return _synapse;
}

async function getStorage() {
  if (_storageUnavailable) throw new Error('Synapse providers unavailable (cached)');
  if (_storage) return _storage;
  try {
    const synapse = await getSynapse();
    _storage = await synapse.createStorage();
    return _storage;
  } catch (err) {
    _storageUnavailable = true;
    throw err;
  }
}

// Minimum piece size enforced by the Synapse SDK (127 bytes)
const MIN_SIZE = 127;

function padToMinSize(data: Uint8Array): Uint8Array {
  if (data.byteLength >= MIN_SIZE) return data;
  const padded = new Uint8Array(MIN_SIZE);
  padded.set(data);
  return padded;
}

/**
 * Upload arbitrary JSON to Filecoin Onchain Cloud via Synapse SDK (Standard mode).
 * Returns the CommP (Piece CID) string — content-addressed permanent storage.
 *
 * Falls back to a placeholder CID if the storage provider is temporarily down.
 */
export async function uploadToFilecoin(
  payload: object,
  label:   string,
): Promise<string> {
  let storage: ReturnType<typeof getStorage> extends Promise<infer T> ? T : never;
  try {
    storage = await getStorage();
  } catch (err) {
    console.warn(`[Synapse] Provider unavailable — skipping ${label} upload:`, (err as Error).message);
    return `placeholder:${label.replace(/\s+/g, '-')}`;
  }

  const encoder = new TextEncoder();
  const raw  = encoder.encode(JSON.stringify(payload, null, 2));
  const data = padToMinSize(raw);

  console.log(`[Synapse] Uploading ${label} (${data.byteLength} bytes) to Filecoin Calibration...`);

  const preflight = await storage.preflightUpload(data.byteLength);
  if (!preflight.allowanceCheck.sufficient) {
    console.warn(`[Synapse] Insufficient USDFC allowance for ${label}: ${preflight.allowanceCheck.message ?? 'top up your wallet'}`);
    return `placeholder:insufficient-allowance`;
  }

  const { commp } = await storage.upload(data, {
    onUploadComplete: (c: { toString(): string }) =>
      console.log(`[Synapse] ✓ ${label} → CommP: ${c}`),
    onRootAdded: () =>
      console.log(`[Synapse] Root added to proof set`),
    onRootConfirmed: (ids: number[]) =>
      console.log(`[Synapse] Root confirmed, ids: ${ids.join(',')}`),
  });

  return commp.toString();
}

/**
 * Download data from Filecoin by CommP (Piece CID).
 */
export async function downloadFromFilecoin(commp: string): Promise<object> {
  const storage = await getStorage();
  const bytes   = await storage.download(commp);
  const text    = new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

/**
 * Get current USDFC wallet balance for the oracle service account.
 */
export async function getUSDFCBalance(): Promise<string> {
  const synapse  = await getSynapse();
  const raw      = await synapse.payments.walletBalance('USDFC');
  const decimals = synapse.payments.decimals('USDFC');
  return ethers.formatUnits(raw, decimals);
}
