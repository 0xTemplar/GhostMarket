/**
 * test-filcdn.ts
 *
 * Tests filcdn.io retrieval URL for a previously uploaded piece.
 * Usage: npx tsx --tsconfig tsconfig.json scripts/test-filcdn.ts [pieceCid]
 *
 * Defaults to the PieceCID from the last successful smoke test.
 */
import dotenv from 'dotenv';
dotenv.config();

const PIECE_CID = process.argv[2] ?? 'bafkzcibcaabdtxnxumlsb7xsf3s3gisinfp5eiew6ga3kertjlcl7rdq4x6wocy';

async function main() {
  console.log(`\n=== FilCDN retrieval test ===`);
  console.log(`PieceCID: ${PIECE_CID}\n`);

  const { Synapse, calibration } = await import('@filoz/synapse-sdk');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { http } = await import('viem');

  const privateKey = process.env.CALIBRATION_PRIVATE_KEY as `0x${string}`;
  const rpcURL = process.env.CALIBRATION_RPC_URL ?? 'https://filecoin-calibration.drpc.org';
  const account = privateKeyToAccount(privateKey);

  const synapse = Synapse.create({
    account,
    transport: http(rpcURL),
    chain: calibration,
    withCDN: true,
    source: 'filcdn-test',
  });

  // ── 1. Find data sets that contain our piece ──────────────────────────────
  console.log('[1] Finding data sets...');
  const dataSets = await synapse.storage.findDataSets();
  console.log(`    Found ${dataSets.length} data set(s)`);

  for (const ds of dataSets) {
    console.log(`\n    DataSet ${ds.dataSetId} | provider=${ds.serviceProvider} | CDN=${ds.withCDN}`);

    const ctx = await synapse.storage.createContext({
      dataSetId: ds.dataSetId,
      serviceProvider: ds.serviceProvider,
      withCDN: true,
    });

    // Check if piece is in this dataset
    let hasPiece = false;
    try {
      hasPiece = await ctx.hasPiece({ pieceCid: PIECE_CID });
    } catch {
      // skip
    }

    if (!hasPiece) {
      console.log(`    → piece not in this data set, skipping`);
      continue;
    }

    // Get piece status + URL
    const status = await ctx.pieceStatus({ pieceCid: PIECE_CID });
    console.log(`    ✓ Piece found!`);
    console.log(`      exists            : ${status.exists}`);
    console.log(`      retrievalUrl      : ${status.retrievalUrl}`);
    console.log(`      lastProven        : ${status.dataSetLastProven}`);
    console.log(`      nextProofDue      : ${status.dataSetNextProofDue}`);

    // Also get the CDN URL via getPieceUrl
    const { PieceCID: PieceCIDClass } = await import('@filoz/synapse-sdk') as any;
    let cdnUrl: string | null = null;
    try {
      const pieceCidObj = PieceCIDClass ? new PieceCIDClass(PIECE_CID) : null;
      if (pieceCidObj) {
        cdnUrl = ctx.getPieceUrl(pieceCidObj);
        console.log(`      getPieceUrl()     : ${cdnUrl}`);
      }
    } catch {
      // PieceCID class might not be directly exported
    }

    // ── 2. Fetch the retrieval URL ──────────────────────────────────────────
    const urlToFetch = status.retrievalUrl ?? cdnUrl;
    if (urlToFetch) {
      console.log(`\n[2] Fetching: ${urlToFetch}`);
      try {
        const res = await fetch(urlToFetch, { signal: AbortSignal.timeout(15_000) });
        console.log(`    HTTP ${res.status} ${res.statusText}`);
        if (res.ok) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          const text = new TextDecoder().decode(bytes).replace(/\0+$/, '');
          console.log(`    ✓ Content (first 200 chars): ${text.slice(0, 200)}`);
        } else {
          const body = await res.text().catch(() => '');
          console.warn(`    ✗ Non-OK response body: ${body.slice(0, 200)}`);
        }
      } catch (err) {
        console.warn(`    ✗ Fetch failed: ${(err as Error).message}`);
      }
    } else {
      console.log('\n[2] No retrieval URL available yet (CDN sync may still be in progress).');
    }

    // ── 3. Also try constructing URL manually from provider address ──────────
    console.log(`\n[3] Manual filcdn.io URL probe...`);
    const addr = ds.serviceProvider.toLowerCase().replace(/^0x/, '');
    const manualUrl = `https://${addr}.calibration.filcdn.io/${PIECE_CID}`;
    console.log(`    URL: ${manualUrl}`);
    try {
      const res = await fetch(manualUrl, { signal: AbortSignal.timeout(10_000) });
      console.log(`    HTTP ${res.status} ${res.statusText}`);
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const text = new TextDecoder().decode(bytes).replace(/\0+$/, '');
        console.log(`    ✓ filcdn.io fetch succeeded! Content: ${text.slice(0, 200)}`);
      } else {
        const body = await res.text().catch(() => '');
        console.warn(`    Body: ${body.slice(0, 300)}`);
      }
    } catch (err) {
      console.warn(`    ✗ Fetch failed: ${(err as Error).message}`);
    }

    break; // only test first matching dataset
  }

  console.log('\n=== Done ===\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
