/**
 * lit-client.ts — Lit Protocol V1 (Naga) settlement signing client.
 *
 * Provides `signSettlement()` which either:
 *   A) Executes the registered Lit Action via a Lit PKP on Naga Dev (production path), or
 *   B) Signs with SETTLEMENT_SIGNER_PRIVATE_KEY directly (demo / dev fallback).
 *
 * Uses @lit-protocol/lit-client (Naga V1 SDK) — the required technology for the
 * Lit Protocol bounty at PL_Genesis. Targets nagaDev (free, no payment required).
 *
 * Lit PKP setup:
 *   1. Mint a PKP: https://explorer.litprotocol.com/pkps (Naga Dev network)
 *   2. Upload lit-action.js to IPFS via Pinata; note the CID
 *   3. Grant your LIT_AUTH_PRIVATE_KEY EOA permission to use the PKP
 *   4. Set the PKP ETH address as GhostVault.settlementSigner via update-settlement-signer.ts
 *   5. Set LIT_AUTH_PRIVATE_KEY, LIT_PKP_PUBLIC_KEY, LIT_PKP_ETH_ADDRESS, LIT_ACTION_IPFS_CID in .env
 */

import { ethers }               from 'ethers';
import dotenv                   from 'dotenv';
import { createLitClient }      from '@lit-protocol/lit-client';
import { nagaDev }              from '@lit-protocol/networks';
import {
  createAuthManager,
  storagePlugins,
  ViemAccountAuthenticator,
}                               from '@lit-protocol/auth';
import { privateKeyToAccount }  from 'viem/accounts';

dotenv.config();

// ── Constants ─────────────────────────────────────────────────────────────────

const SEPOLIA_RPC_URL       = process.env.SEPOLIA_RPC_URL       ?? 'https://rpc.sepolia.org';
const FLOW_RPC_URL          = process.env.FLOW_RPC_URL          ?? 'https://testnet.evm.nodes.onflow.org';
const GHOST_EAMM_ADDRESS    = process.env.GHOST_EAMM_ADDRESS    ?? '';
const GHOST_VAULT_ADDRESS   = process.env.GHOST_VAULT_ADDRESS   ?? '0xAf470490b2462DC7359605B8e5D731CbB7816B55';
const SETTLEMENT_SIGNER_KEY = process.env.SETTLEMENT_SIGNER_PRIVATE_KEY ?? '';

// Lit Protocol Naga V1 config — required for the Lit bounty track
const LIT_AUTH_PRIVATE_KEY  = process.env.LIT_AUTH_PRIVATE_KEY
                              ?? process.env.CALIBRATION_PRIVATE_KEY
                              ?? SETTLEMENT_SIGNER_KEY;
const LIT_PKP_PUBLIC_KEY    = process.env.LIT_PKP_PUBLIC_KEY   ?? '';
const LIT_PKP_ETH_ADDRESS   = process.env.LIT_PKP_ETH_ADDRESS  ?? '';
const LIT_ACTION_IPFS_CID   = process.env.LIT_ACTION_IPFS_CID  ?? '';
const LIT_ACTION_MODE       = (process.env.LIT_ACTION_MODE ?? 'safe').toLowerCase();
const SETTLEMENT_SIGNATURE_MODE = (process.env.SETTLEMENT_SIGNATURE_MODE ?? 'eip191').toLowerCase();

// Auth storage path for session caching between oracle invocations
const LIT_STORAGE_PATH      = process.env.LIT_STORAGE_PATH     ?? './lit-auth-storage';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SettlementSignInput {
  userAddress:     string;
  marketIdUint:    string;   // uint256 as decimal string
  marketIdBytes32: string;   // abi.encode(uint256) as 0x-prefixed hex
  nonce:           string;   // decimal string
  expiry:          string;   // unix seconds as decimal string
  betTxHash?:      string;   // optional: the tx where BetPlaced was emitted — resolves to exact block for tight eth_getLogs range
}

export interface SettlementSignOutput {
  sig:           string;   // 65-byte ECDSA signature (hex)
  payout:        string;   // net payout in wei (decimal string)
  nonce:         string;
  expiry:        string;
  signerAddress: string;
  path:          'lit' | 'deployer';
}

// ── ABI fragments for on-chain reads ─────────────────────────────────────────

const EAMM_ABI = [
  'function getMarketMeta(uint256 marketId) external view returns (uint8 status, bool outcome, uint64 expiryAt)',
  'function hasPosition(uint256 marketId, address user) external view returns (bool)',
  'event BetPlaced(uint256 indexed marketId, address indexed user, bool indexed side)',
  'function totalYesStake(uint256 marketId) external view returns (uint256)',
  'function totalNoStake(uint256 marketId) external view returns (uint256)',
];

const VAULT_ABI = [
  'function lockedAmounts(address user, bytes32 marketId) external view returns (uint256)',
  'function settlementSigner() external view returns (address)',
];

async function getVaultSettlementSigner(): Promise<string> {
  const flowProvider = new ethers.JsonRpcProvider(FLOW_RPC_URL);
  const vault = new ethers.Contract(GHOST_VAULT_ADDRESS, VAULT_ABI, flowProvider);
  const signer = await vault.settlementSigner();
  return String(signer);
}

// ── EIP-712 signing helpers (must match GhostVault CLAIM_TYPEHASH) ────────────

const CLAIM_TYPES = {
  Claim: [
    { name: 'user', type: 'address' },
    { name: 'marketId', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
  ],
};

export async function buildSettlementSignature(
  signer:          ethers.Wallet,
  user:            string,
  marketIdBytes32: string,
  payout:          bigint,
  nonce:           bigint,
  expiry:          bigint,
  vaultAddress:    string,
  chainId:         bigint,
): Promise<string> {
  if (SETTLEMENT_SIGNATURE_MODE !== 'eip712') {
    const inner = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'bytes32', 'uint256', 'uint256', 'uint256', 'address'],
        [user, marketIdBytes32, payout, nonce, expiry, vaultAddress],
      ),
    );
    return signer.signMessage(ethers.getBytes(inner));
  }

  const domain = {
    name: 'GhostVault',
    version: '1',
    chainId,
    verifyingContract: vaultAddress,
  };
  return signer.signTypedData(domain, CLAIM_TYPES, {
    user,
    marketId: marketIdBytes32,
    amount: payout,
    nonce,
    expiry,
  });
}

// How many blocks back to search for BetPlaced events.
// Default covers ~69 days on Sepolia (12 s/block × 500 000 = 69.4 days).
// Override with MARKET_LOOKBACK_BLOCKS in oracle/.env if markets are older.
const MARKET_LOOKBACK_BLOCKS = Number(process.env.MARKET_LOOKBACK_BLOCKS ?? '500000');
// Maximum block span per eth_getLogs request.
// Keep 10 for Alchemy free tier compatibility.
const BET_LOG_SCAN_CHUNK_SIZE = Math.max(1, Number(process.env.BET_LOG_SCAN_CHUNK_SIZE ?? '10'));
const BET_PLACED_TOPIC = ethers.id('BetPlaced(uint256,address,bool)');

/**
 * Resolve the `fromBlock` (hex string) for the BetPlaced eth_getLogs query.
 *
 * Strategy (in priority order):
 *  1. If `betTxHash` is provided → fetch its receipt and return that exact block.
 *     Result is a 1-block window — works on Alchemy free tier or any plan.
 *  2. Otherwise → return currentBlock - MARKET_LOOKBACK_BLOCKS.
 *     Requires an Alchemy plan that supports the range (PAYG+).
 *
 * Never returns genesis/0x0 — querying the full chain history is always wrong.
 */
async function getLogsFromBlock(betTxHash?: string): Promise<{ fromBlock: string; toBlock: string }> {
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  // #region agent log
  fetch('http://127.0.0.1:7884/ingest/fbd2257e-f2ff-467e-b558-4abfac1502be',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'37e9d3'},body:JSON.stringify({sessionId:'37e9d3',runId:'logs-range',hypothesisId:'H3-H4',location:'lit-client.ts:getLogsFromBlock-entry',message:'Computing bet log block range',data:{hasBetTxHash:Boolean(betTxHash),betTxHashPrefix:betTxHash?.slice(0,18) ?? null,rpcUrlHost:(() => { try { return new URL(SEPOLIA_RPC_URL).host; } catch { return 'invalid-url'; } })(),lookbackBlocks:MARKET_LOOKBACK_BLOCKS},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  if (betTxHash) {
    const receipt = await provider.getTransactionReceipt(betTxHash);
    if (!receipt) {
      // #region agent log
      fetch('http://127.0.0.1:7884/ingest/fbd2257e-f2ff-467e-b558-4abfac1502be',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'37e9d3'},body:JSON.stringify({sessionId:'37e9d3',runId:'logs-range',hypothesisId:'H4',location:'lit-client.ts:getLogsFromBlock-missing-receipt',message:'betTxHash receipt not found',data:{betTxHashPrefix:betTxHash.slice(0,18)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      throw new Error(`Could not find receipt for betTxHash ${betTxHash}`);
    }
    const hex = '0x' + receipt.blockNumber.toString(16);
    console.log(`[Lit] Bet tx resolved to Sepolia block ${receipt.blockNumber} — using exact 1-block range`);
    // #region agent log
    fetch('http://127.0.0.1:7884/ingest/fbd2257e-f2ff-467e-b558-4abfac1502be',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'37e9d3'},body:JSON.stringify({sessionId:'37e9d3',runId:'logs-range',hypothesisId:'H4',location:'lit-client.ts:getLogsFromBlock-exact',message:'Using exact bet block range',data:{fromBlock:hex,toBlock:hex,blockNumber:receipt.blockNumber},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return { fromBlock: hex, toBlock: hex };
  }

  const currentBlock = await provider.getBlockNumber();
  const fromBlock    = Math.max(0, currentBlock - MARKET_LOOKBACK_BLOCKS);
  const hex          = '0x' + fromBlock.toString(16);
  console.log(`[Lit] No betTxHash — using lookback range: ${hex} → latest (~${MARKET_LOOKBACK_BLOCKS} blocks)`);
  // #region agent log
  fetch('http://127.0.0.1:7884/ingest/fbd2257e-f2ff-467e-b558-4abfac1502be',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'37e9d3'},body:JSON.stringify({sessionId:'37e9d3',runId:'logs-range',hypothesisId:'H3',location:'lit-client.ts:getLogsFromBlock-lookback',message:'Using lookback log range',data:{fromBlock:hex,toBlock:'latest',currentBlock,lookbackBlocks:MARKET_LOOKBACK_BLOCKS},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  return { fromBlock: hex, toBlock: 'latest' };
}

function marketTopic(marketIdUint: string): string {
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(marketIdUint)), 32);
}

function addressTopic(userAddress: string): string {
  return ethers.zeroPadValue(userAddress, 32);
}

async function getBetPlacedLogs(
  provider: ethers.JsonRpcProvider,
  marketIdUint: string,
  userAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<ethers.Log[]> {
  return provider.getLogs({
    address: GHOST_EAMM_ADDRESS,
    topics: [BET_PLACED_TOPIC, marketTopic(marketIdUint), addressTopic(userAddress)],
    fromBlock,
    toBlock,
  });
}

async function findLatestBetPlacedLog(
  provider: ethers.JsonRpcProvider,
  marketIdUint: string,
  userAddress: string,
  betTxHash?: string,
): Promise<ethers.Log> {
  if (betTxHash) {
    const receipt = await provider.getTransactionReceipt(betTxHash);
    if (!receipt) throw new Error(`Could not find receipt for betTxHash ${betTxHash}`);

    const exactBlockLogs = await getBetPlacedLogs(
      provider,
      marketIdUint,
      userAddress,
      receipt.blockNumber,
      receipt.blockNumber,
    );

    const exactTxLog = exactBlockLogs.find(
      (log) => log.transactionHash.toLowerCase() === betTxHash.toLowerCase(),
    );
    if (exactTxLog) return exactTxLog;

    if (exactBlockLogs.length > 0) return exactBlockLogs[exactBlockLogs.length - 1];
    throw new Error(`No BetPlaced log found at betTxHash block ${receipt.blockNumber}`);
  }

  const latest = await provider.getBlockNumber();
  const oldest = Math.max(0, latest - MARKET_LOOKBACK_BLOCKS);

  for (let to = latest; to >= oldest; to -= BET_LOG_SCAN_CHUNK_SIZE) {
    const from = Math.max(oldest, to - BET_LOG_SCAN_CHUNK_SIZE + 1);
    const logs = await getBetPlacedLogs(provider, marketIdUint, userAddress, from, to);
    if (logs.length > 0) {
      return logs[logs.length - 1];
    }
  }

  throw new Error(
    `No bet found for user ${userAddress} in market ${marketIdUint} within last ${MARKET_LOOKBACK_BLOCKS} blocks`,
  );
}

// ── On-chain reads ─────────────────────────────────────────────────────────────

async function readOnChainSettlementData(input: SettlementSignInput) {
  const sepoliaProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const flowProvider    = new ethers.JsonRpcProvider(FLOW_RPC_URL);

  const eamm  = new ethers.Contract(GHOST_EAMM_ADDRESS, EAMM_ABI, sepoliaProvider);
  const vault = new ethers.Contract(GHOST_VAULT_ADDRESS, VAULT_ABI, flowProvider);

  // Market outcome
  const [status, outcome] = await eamm.getMarketMeta(BigInt(input.marketIdUint));
  if (Number(status) !== 1) {
    throw new Error(`Market ${input.marketIdUint} is not resolved (status: ${status})`);
  }

  // User's bet side — read from BetPlaced logs.
  // Strategy:
  // - betTxHash provided: exact 1-block query + tx-hash match
  // - no betTxHash: backward chunk scan in <=10-block windows (Alchemy free-tier safe)
  const latestLog = await findLatestBetPlacedLog(
    sepoliaProvider,
    input.marketIdUint,
    input.userAddress,
    input.betTxHash,
  );
  const userSide = parseInt(latestLog.topics[3] ?? '0x0', 16) === 1;
  if (!input.betTxHash) {
    console.log(
      `[Settlement] Auto-discovered betTxHash: ${latestLog.transactionHash} (block ${latestLog.blockNumber})`,
    );
  }

  // Locked collateral from GhostVault.
  // Some Flow EVM nodes may return an execution error for missing entries;
  // treat that as zero locked so settlement signing remains available.
  let lockedAmount = 0n;
  try {
    lockedAmount = await vault.lockedAmounts(input.userAddress, input.marketIdBytes32);
  } catch {
    console.warn('[Settlement] lockedAmounts read failed — treating as 0 locked');
  }

  // Pool totals from GhostEAMM (public mappings)
  let totalYesPool = 0n;
  let totalNoPool  = 0n;
  try {
    totalYesPool = await eamm.totalYesStake(BigInt(input.marketIdUint));
    totalNoPool  = await eamm.totalNoStake(BigInt(input.marketIdUint));
  } catch {
    console.warn('[Settlement] totalYesStake/totalNoStake not available — using 1:1 payout');
    totalYesPool = lockedAmount;
    totalNoPool  = lockedAmount;
  }

  return { outcome, userSide, lockedAmount, totalYesPool, totalNoPool };
}

// ── Payout computation ─────────────────────────────────────────────────────────

function computePayout(
  outcome:      boolean,
  userSide:     boolean,
  lockedAmount: bigint,
  totalYesPool: bigint,
  totalNoPool:  bigint,
): bigint {
  const userWon    = userSide === outcome;
  if (!userWon) return 0n;

  const winnerPool = outcome ? totalYesPool : totalNoPool;
  const loserPool  = outcome ? totalNoPool  : totalYesPool;

  if (winnerPool === 0n) return lockedAmount;
  return lockedAmount + (lockedAmount * loserPool / winnerPool);
}

// ── Lit Protocol V1 (Naga) path ────────────────────────────────────────────────

async function signViaLitAction(input: SettlementSignInput): Promise<SettlementSignOutput> {
  if (!LIT_AUTH_PRIVATE_KEY) {
    throw new Error('LIT_AUTH_PRIVATE_KEY (or CALIBRATION_PRIVATE_KEY) must be set for Lit path');
  }

  console.log('[Lit] Connecting to Naga Dev network…');

  // 1. Create Lit client on nagaDev (free — no payment or capacity credits required)
  const litClient = await createLitClient({ network: nagaDev });

  // 2. Create auth manager with Node.js file-based session storage
  //    Sessions are cached between oracle calls to avoid re-authenticating every time.
  const authManager = createAuthManager({
    storage: storagePlugins.localStorageNode({
      appName:     'ghost-oracle',
      networkName: 'naga-dev',
      storagePath: LIT_STORAGE_PATH,
    }),
  });

  // 3. Create viem account from the oracle's private key
  const account  = privateKeyToAccount(LIT_AUTH_PRIVATE_KEY as `0x${string}`);
  const authData = await ViemAccountAuthenticator.authenticate(account);

  console.log(`[Lit] Authenticated as EOA: ${account.address}`);

  // 4. Build auth context for the PKP
  //    This authorises the oracle EOA to execute Lit Actions on behalf of the PKP.
  //    Sessions are cached via localStorageNode and reused until expiry.
  const authContext = await authManager.createPkpAuthContext({
    authData,
    pkpPublicKey: LIT_PKP_PUBLIC_KEY,
    authConfig: {
      resources: [
        ['lit-action-execution', '*'],
        ['pkp-signing',          '*'],
      ],
      expiration: new Date(Date.now() + 3_600_000).toISOString(), // 1 hour
      statement:  'GhostMarket oracle settlement signing',
      domain:     'ghost-oracle.local',
    },
    litClient,
  });

  console.log('[Lit] Auth context created — preparing settlement payload…');

  // Compute settlement data in Node to keep Lit Action deterministic and sign-only.
  const { outcome, userSide, lockedAmount, totalYesPool, totalNoPool } =
    await readOnChainSettlementData(input);
  const payout = computePayout(outcome, userSide, lockedAmount, totalYesPool, totalNoPool);

  // Must exactly match GhostVault EIP-712 domain + CLAIM_TYPEHASH.
  const flowProvider = new ethers.JsonRpcProvider(FLOW_RPC_URL);
  const flowNetwork = await flowProvider.getNetwork();
  const toSign = SETTLEMENT_SIGNATURE_MODE === 'eip712'
    ? ethers.TypedDataEncoder.hash(
      {
        name: 'GhostVault',
        version: '1',
        chainId: flowNetwork.chainId,
        verifyingContract: GHOST_VAULT_ADDRESS,
      },
      CLAIM_TYPES,
      {
        user: input.userAddress,
        marketId: input.marketIdBytes32,
        amount: payout,
        nonce: BigInt(input.nonce),
        expiry: BigInt(input.expiry),
      },
    )
    : ethers.hashMessage(
      ethers.getBytes(
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'bytes32', 'uint256', 'uint256', 'uint256', 'address'],
            [
              input.userAddress,
              input.marketIdBytes32,
              payout,
              BigInt(input.nonce),
              BigInt(input.expiry),
              GHOST_VAULT_ADDRESS,
            ],
          ),
        ),
      ),
    );

  // Optional strict mode: Lit Action re-checks resolution + bet log + lock state
  // before signing. Falls back to safe mode when required strict inputs are absent.
  let effectiveMode: 'safe' | 'strict' = LIT_ACTION_MODE === 'strict' ? 'strict' : 'safe';
  let strictJsParams: Record<string, string> = {};
  if (effectiveMode === 'strict') {
    if (!input.betTxHash) {
      console.warn('[Lit] LIT_ACTION_MODE=strict but betTxHash missing; using safe mode');
      effectiveMode = 'safe';
    } else {
      const sepoliaProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
      const receipt = await sepoliaProvider.getTransactionReceipt(input.betTxHash);
      if (!receipt) {
        console.warn('[Lit] strict mode could not resolve betTxHash receipt; using safe mode');
        effectiveMode = 'safe';
      } else {
        strictJsParams = {
          sepoliaRpc:      SEPOLIA_RPC_URL,
          flowRpc:         FLOW_RPC_URL,
          eammAddress:     GHOST_EAMM_ADDRESS,
          vaultAddress:    GHOST_VAULT_ADDRESS,
          marketIdBytes32: input.marketIdBytes32,
          betTxHash:       input.betTxHash,
          betBlockHex:     '0x' + receipt.blockNumber.toString(16),
        };
      }
    }
  }

  // #region agent log
  fetch('http://127.0.0.1:7884/ingest/fbd2257e-f2ff-467e-b558-4abfac1502be',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'37e9d3'},body:JSON.stringify({sessionId:'37e9d3',hypothesisId:'A',location:'lit-client.ts:262',message:'executeJs called',data:{ipfsId:LIT_ACTION_IPFS_CID,mode:effectiveMode,pkpPublicKeySet:!!LIT_PKP_PUBLIC_KEY,pkpPublicKeyLen:LIT_PKP_PUBLIC_KEY.length,userAddress:input.userAddress,marketIdUint:input.marketIdUint,payout:payout.toString()},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  // 5. Execute the Lit Action (pinned to IPFS as lit-action.js).
  //    The action only signs `toSign`; no chain calls happen inside the TEE.
  const response = await litClient.executeJs({
    ipfsId:      LIT_ACTION_IPFS_CID,
    authContext,
    jsParams: {
      mode:            effectiveMode,
      userAddress:     input.userAddress,
      marketIdUint:    input.marketIdUint,
      payout:          payout.toString(),
      nonce:           input.nonce,
      expiry:          input.expiry,
      pkpPublicKey:    LIT_PKP_PUBLIC_KEY,
      toSign,
      ...strictJsParams,
    },
  });

  // #region agent log
  fetch('http://127.0.0.1:7884/ingest/fbd2257e-f2ff-467e-b558-4abfac1502be',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'37e9d3'},body:JSON.stringify({sessionId:'37e9d3',hypothesisId:'A-B-C',location:'lit-client.ts:285',message:'executeJs returned',data:{responseType:typeof response.response,responseValue:JSON.stringify(response.response)?.slice(0,300),sigKeys:Object.keys((response.signatures as Record<string,unknown>)??{})},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  // Naga V1 SDK may return response.response as an already-parsed object or as a JSON string
  const actionResponse: Record<string, unknown> = typeof response.response === 'string'
    ? JSON.parse(response.response)
    : (response.response as Record<string, unknown>);
  if (actionResponse.error) {
    throw new Error(`Lit Action error: ${actionResponse.error}`);
  }

  // 6. Reconstruct 65-byte ECDSA signature from r, s, recid
  //    Lit Actions return signatures via Lit.Actions.signEcdsa({sigName: 'settlement'})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sigShare = (response.signatures as Record<string, any>)?.['settlement'];
  if (!sigShare) throw new Error('Lit Action did not return a settlement signature');

  let sigHex = '';
  if (typeof sigShare.signature === 'string') {
    const rawSig = sigShare.signature.startsWith('0x') ? sigShare.signature : '0x' + sigShare.signature;
    const recid  = typeof sigShare.recoveryId === 'number'
      ? sigShare.recoveryId
      : Number(sigShare.recoveryId ?? 0);
    if (rawSig.length === 130) {
      const v = recid === 1 ? 28 : 27;
      sigHex = `${rawSig}${v.toString(16).padStart(2, '0')}`;
    } else {
      sigHex = rawSig;
    }
  } else {
    const r = sigShare.r.startsWith('0x') ? sigShare.r : '0x' + sigShare.r;
    const s = sigShare.s.startsWith('0x') ? sigShare.s : '0x' + sigShare.s;
    const v = sigShare.recid ? 28 : 27;
    sigHex = ethers.hexlify(ethers.concat([r, s, `0x${v.toString(16).padStart(2, '0')}`]));
  }

  console.log(`[Lit] Settlement signed via PKP — payout: ${payout.toString()} wei`);

  return {
    sig:           sigHex,
    payout:        (actionResponse.payout as string) ?? payout.toString(),
    nonce:         input.nonce,
    expiry:        input.expiry,
    signerAddress: LIT_PKP_ETH_ADDRESS,
    path:          'lit',
  };
}

// ── Deployer key fallback path ─────────────────────────────────────────────────

async function signViaDeployerKey(input: SettlementSignInput): Promise<SettlementSignOutput> {
  if (!SETTLEMENT_SIGNER_KEY) {
    throw new Error('SETTLEMENT_SIGNER_PRIVATE_KEY not set and Lit Protocol not configured');
  }

  const signer = new ethers.Wallet(SETTLEMENT_SIGNER_KEY);

  const { outcome, userSide, lockedAmount, totalYesPool, totalNoPool } =
    await readOnChainSettlementData(input);

  const payout = computePayout(outcome, userSide, lockedAmount, totalYesPool, totalNoPool);

  const sig = await buildSettlementSignature(
    signer,
    input.userAddress,
    input.marketIdBytes32,
    payout,
    BigInt(input.nonce),
    BigInt(input.expiry),
    GHOST_VAULT_ADDRESS,
    (await new ethers.JsonRpcProvider(FLOW_RPC_URL).getNetwork()).chainId,
  );

  return {
    sig,
    payout:        payout.toString(),
    nonce:         input.nonce,
    expiry:        input.expiry,
    signerAddress: signer.address,
    path:          'deployer',
  };
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Sign a settlement message for a user claiming their payout.
 *
 * Uses the Lit Action PKP (Naga V1 SDK, nagaDev network) when
 * LIT_PKP_PUBLIC_KEY, LIT_PKP_ETH_ADDRESS, and LIT_ACTION_IPFS_CID are all set.
 * Falls back to SETTLEMENT_SIGNER_PRIVATE_KEY for testnet demos.
 */
export async function signSettlement(input: SettlementSignInput): Promise<SettlementSignOutput> {
  const litConfigured =
    LIT_PKP_PUBLIC_KEY.length  > 0 &&
    LIT_PKP_ETH_ADDRESS.length > 0 &&
    LIT_ACTION_IPFS_CID.length > 0;
  const onChainSigner = (await getVaultSettlementSigner()).toLowerCase();
  const litSigner = LIT_PKP_ETH_ADDRESS.toLowerCase();
  const deployerSigner = SETTLEMENT_SIGNER_KEY
    ? new ethers.Wallet(SETTLEMENT_SIGNER_KEY).address.toLowerCase()
    : '';

  if (litConfigured && onChainSigner === litSigner) {
    try {
      return await signViaLitAction(input);
    } catch (err) {
      // #region agent log
      fetch('http://127.0.0.1:7884/ingest/fbd2257e-f2ff-467e-b558-4abfac1502be',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'37e9d3'},body:JSON.stringify({sessionId:'37e9d3',hypothesisId:'A-B-C-D',location:'lit-client.ts:catch',message:'Lit Action threw error',data:{errorMsg:(err as Error).message,ipfsId:LIT_ACTION_IPFS_CID},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      console.warn('[Lit] Lit Action failed, falling back to deployer key:', (err as Error).message);
    }
  }

  if (SETTLEMENT_SIGNER_KEY && onChainSigner === deployerSigner) {
    console.log('[Settlement] Signing with deployer key (matches on-chain settlementSigner)');
    return signViaDeployerKey(input);
  }

  if (litConfigured && onChainSigner !== litSigner) {
    throw new Error(
      `Vault settlementSigner mismatch: on-chain=${onChainSigner}, litPKP=${litSigner}. ` +
      'Update GhostVault.settlementSigner to LIT_PKP_ETH_ADDRESS or switch oracle signing key to match.',
    );
  }

  throw new Error(
    `No signing key matches GhostVault.settlementSigner (${onChainSigner}). ` +
    'Configure LIT_PKP_ETH_ADDRESS or SETTLEMENT_SIGNER_PRIVATE_KEY to the same address.',
  );
}

/**
 * Build a fresh nonce + expiry pair for a settlement request.
 * Nonce = Date.now() in milliseconds ensures uniqueness across claims.
 * Expiry = 24 hours from now (long enough for a user to submit on-chain).
 */
export function freshNonceExpiry(): { nonce: string; expiry: string } {
  return {
    nonce:  Date.now().toString(),
    expiry: (Math.floor(Date.now() / 1000) + 86_400).toString(), // 24 h
  };
}
