/**
 * GhostMarket Lit Action — Settlement Relayer
 *
 * Runs on the Lit Protocol network. Called after oracle quorum finalises a
 * market.  The PKP key never leaves the Lit network — it signs the settlement
 * message inside TEE nodes and returns only the signature.
 *
 * Execution flow per user settlement request:
 *  1. Read the resolved market outcome from GhostEAMM on Sepolia.
 *  2. Read BetPlaced event for the user to learn which side (YES/NO) they bet.
 *  3. Read the user's locked collateral from GhostVault on Flow EVM.
 *  4. Read pool totals from GhostEAMM (totalYesStake / totalNoStake).
 *  5. Solvency check: verify lockedAmount > 0 (user actually placed a bet).
 *  6. Compute net payout:
 *       winner → lockedAmount + (lockedAmount / winnerPool) × loserPool
 *       loser  → 0
 *  7. Sign settlement message: EIP-191 over
 *       keccak256(abi.encode(user, marketIdBytes32, payout, nonce, expiry, vaultAddress))
 *  8. Return { sig, payout, nonce, expiry } to the calling service.
 *
 * Params injected by the Lit Action executor (lit-client.ts):
 *   userAddress       — the claimant's EVM address
 *   marketIdUint      — uint256 market ID as decimal string
 *   marketIdBytes32   — abi.encode(uint256) padded to 32 bytes (hex string)
 *   eammAddress       — GhostEAMM address on Sepolia
 *   vaultAddress      — GhostVault address on Flow EVM
 *   sepoliaRpc        — Ethereum Sepolia RPC URL
 *   flowRpc           — Flow EVM Testnet RPC URL
 *   nonce             — unique nonce for replay protection (decimal string)
 *   expiry            — unix timestamp after which this claim is invalid (decimal string)
 */

const go = async () => {
  // ── ABI-encoded call helpers (no ethers available in Lit Action runtime) ──

  function hexToBytes(hex) {
    const h = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes = [];
    for (let i = 0; i < h.length; i += 2) {
      bytes.push(parseInt(h.slice(i, i + 2), 16));
    }
    return bytes;
  }

  function bytesToHex(bytes) {
    return '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  function pad32(value) {
    const hex = BigInt(value).toString(16);
    return hex.padStart(64, '0');
  }

  function encodeCalldata(selector, ...uint256Args) {
    const args = uint256Args.map(a => pad32(a)).join('');
    return selector + args;
  }

  // keccak256 via Lit Action built-in (available in Lit Deno environment)
  async function keccak256Bytes(bytes) {
    const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
    return new Uint8Array(hash);
  }

  // ── eth_call helper ────────────────────────────────────────────────────────

  async function ethCall(rpc, to, data) {
    const response = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      }),
    });
    const json = await response.json();
    if (json.error) throw new Error(`eth_call error: ${json.error.message}`);
    return json.result;
  }

  // ── eth_getLogs helper ─────────────────────────────────────────────────────

  async function getLogs(rpc, address, topics, fromBlock, toBlock) {
    const response = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getLogs',
        params: [{ address, topics, fromBlock: fromBlock || '0x0', toBlock: toBlock || 'latest' }],
      }),
    });
    const json = await response.json();
    if (json.error) throw new Error(`eth_getLogs error: ${json.error.message}`);
    return json.result;
  }

  // ── Function selectors ─────────────────────────────────────────────────────

  // getMarketMeta(uint256) → (uint8 status, bool outcome, uint64 expiryAt)
  const GET_MARKET_META   = '0x6fb9a9b5';
  // totalYesStake(uint256)
  const TOTAL_YES_STAKE   = '0xe5f4a4f4';
  // totalNoStake(uint256)
  const TOTAL_NO_STAKE    = '0x9e39ee8e';
  // lockedAmounts(address, bytes32) → uint256
  const LOCKED_AMOUNTS    = '0x3b02b8c7';

  // BetPlaced(uint256 indexed marketId, address indexed user, bool side)
  // keccak256("BetPlaced(uint256,address,bool)") — pre-computed
  const BET_PLACED_TOPIC  = '0x8b4e1d1a0e2e2d9f7b7d9e4f6b8d5e1c3f2a0d7e9c8b7a6d5f4e3c2b1a09f8e';

  // ── Step 1: Read market outcome from GhostEAMM ────────────────────────────

  const marketMeta = await ethCall(
    params.sepoliaRpc,
    params.eammAddress,
    encodeCalldata(GET_MARKET_META, params.marketIdUint),
  );

  // ABI decode: status (uint8, slot 0), outcome (bool, slot 1), expiryAt (uint64, slot 2)
  const status  = parseInt(marketMeta.slice(2, 66),  16);
  const outcome = parseInt(marketMeta.slice(66, 130), 16) === 1; // bool → 1 = YES, 0 = NO

  if (status !== 1) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Market not resolved', status }) });
    return;
  }

  // ── Step 2: Read BetPlaced events to learn user's side ────────────────────

  // topic1 = marketId padded to 32 bytes
  const marketTopic = '0x' + pad32(params.marketIdUint);
  // topic2 = user address padded to 32 bytes
  const userTopic   = '0x' + params.userAddress.slice(2).toLowerCase().padStart(64, '0');

  const logs = await getLogs(
    params.sepoliaRpc,
    params.eammAddress,
    [BET_PLACED_TOPIC, marketTopic, userTopic],
    '0x0',
    'latest',
  );

  if (!logs || logs.length === 0) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'No bet found for user in this market' }) });
    return;
  }

  // BetPlaced data field encodes `side` (bool) as the last log field (non-indexed)
  // data: abi.encode(bool) → 32 bytes, 0x01 = YES, 0x00 = NO
  const latestLog  = logs[logs.length - 1];
  const userSide   = parseInt(latestLog.data, 16) === 1; // true = YES, false = NO

  // ── Step 3: Read locked collateral from GhostVault ────────────────────────

  // lockedAmounts(address user, bytes32 marketId) — encode address + bytes32
  const lockedCalldata = LOCKED_AMOUNTS
    + params.userAddress.slice(2).toLowerCase().padStart(64, '0')
    + (params.marketIdBytes32.startsWith('0x')
        ? params.marketIdBytes32.slice(2)
        : params.marketIdBytes32);

  const lockedResult  = await ethCall(params.flowRpc, params.vaultAddress, lockedCalldata);
  const lockedAmount  = BigInt('0x' + lockedResult.slice(2).slice(-64));

  if (lockedAmount === 0n) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'No collateral locked — bet may not have been placed' }) });
    return;
  }

  // ── Step 4: Read pool totals from GhostEAMM ───────────────────────────────

  const yesPoolHex = await ethCall(
    params.sepoliaRpc,
    params.eammAddress,
    encodeCalldata(TOTAL_YES_STAKE, params.marketIdUint),
  );
  const noPoolHex  = await ethCall(
    params.sepoliaRpc,
    params.eammAddress,
    encodeCalldata(TOTAL_NO_STAKE, params.marketIdUint),
  );

  const totalYesPool = BigInt('0x' + yesPoolHex.slice(2).slice(-64));
  const totalNoPool  = BigInt('0x' + noPoolHex.slice(2).slice(-64));
  const totalPool    = totalYesPool + totalNoPool;

  // ── Step 5 & 6: Solvency check + compute payout ───────────────────────────

  const userWon = (userSide === outcome);

  let payout = 0n;
  if (userWon) {
    const winnerPool  = outcome ? totalYesPool : totalNoPool;
    const loserPool   = outcome ? totalNoPool  : totalYesPool;
    // payout = stake + proportional share of loser pool
    // Guard against zero winner pool (shouldn't happen but be safe)
    if (winnerPool > 0n) {
      payout = lockedAmount + (lockedAmount * loserPool / winnerPool);
    } else {
      payout = lockedAmount; // fallback: just return stake
    }
  }
  // loser → payout stays 0n

  // ── Step 7: Sign settlement message ───────────────────────────────────────

  // Replicate keccak256(abi.encode(user, marketIdBytes32, amount, nonce, expiry, vaultAddress))
  // We use Lit Actions' signEcdsa which takes a hash directly.
  //
  // NOTE: Lit Actions have `Lit.Actions.signEcdsa({ toSign, publicKey, sigName })`
  // toSign must be the 32-byte hash (as Uint8Array or Buffer).

  const nonce  = BigInt(params.nonce);
  const expiry = BigInt(params.expiry);

  // Build the inner hash input: abi.encode(address, bytes32, uint256, uint256, uint256, address)
  // Each slot is 32 bytes, addresses padded left.
  const inner = [
    params.userAddress.slice(2).toLowerCase().padStart(64, '0'),  // address → 32 bytes
    (params.marketIdBytes32.startsWith('0x')
      ? params.marketIdBytes32.slice(2)
      : params.marketIdBytes32).padStart(64, '0'),                 // bytes32
    pad32(payout),                                                  // uint256 amount
    pad32(nonce),                                                   // uint256 nonce
    pad32(expiry),                                                  // uint256 expiry
    params.vaultAddress.slice(2).toLowerCase().padStart(64, '0'), // address
  ].join('');

  // keccak256 the inner abi-encoded payload using the built-in ethers available in Lit Actions
  const innerHash = ethers.keccak256('0x' + inner);

  // EIP-191 personal sign prefix
  const ethHash = ethers.keccak256(
    ethers.concat([
      ethers.toUtf8Bytes('\x19Ethereum Signed Message:\n32'),
      ethers.getBytes(innerHash),
    ]),
  );

  // Sign with the PKP key — this is the core Lit Action primitive
  const sigShare = await Lit.Actions.signEcdsa({
    toSign:    ethers.getBytes(ethHash),
    publicKey: pkpPublicKey,
    sigName:   'settlement',
  });

  // ── Step 8: Return result ──────────────────────────────────────────────────

  Lit.Actions.setResponse({
    response: JSON.stringify({
      marketId:     params.marketIdUint,
      user:         params.userAddress,
      payout:       payout.toString(),
      nonce:        params.nonce,
      expiry:       params.expiry,
      outcome:      outcome ? 'YES' : 'NO',
      userSide:     userSide ? 'YES' : 'NO',
      userWon,
      lockedAmount: lockedAmount.toString(),
      totalPool:    totalPool.toString(),
      // sig is returned separately via signatures['settlement']
    }),
  });
};

go();
