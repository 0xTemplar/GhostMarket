/**
 * GhostMarket Lit Action — dual mode signer.
 *
 * Modes:
 * - safe   (default): sign-only, no RPC calls in Lit Action.
 * - strict: deterministic pre-sign checks in Lit Action, then sign.
 */

const GET_MARKET_META_SELECTOR = '0x2882224f'; // getMarketMeta(uint256)
const LOCKED_AMOUNTS_SELECTOR  = '0xcf57e428'; // lockedAmounts(address,bytes32)
const BET_PLACED_TOPIC         = '0x33c65b946c0ea6ac285a37d6cc603f46002718bc959723973487890e29a3bce3';

function pad32(value) {
  const hex = BigInt(value).toString(16);
  return hex.padStart(64, '0');
}

function normalizeAddressTopic(addr) {
  return `0x${addr.slice(2).toLowerCase().padStart(64, '0')}`;
}

async function rpcCall(rpc, method, params) {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(`${method} failed: ${json.error.message}`);
  return json.result;
}

async function strictPrechecks() {
  const required = [
    'sepoliaRpc', 'flowRpc', 'eammAddress', 'vaultAddress', 'marketIdUint',
    'marketIdBytes32', 'userAddress', 'betTxHash', 'betBlockHex',
  ];
  for (const k of required) {
    if (!jsParams[k]) throw new Error(`strict mode missing jsParams.${k}`);
  }

  const marketIdTopic = `0x${pad32(jsParams.marketIdUint)}`;
  const userTopic = normalizeAddressTopic(jsParams.userAddress);

  // 1) Market must be resolved.
  const marketMeta = await rpcCall(
    jsParams.sepoliaRpc,
    'eth_call',
    [{ to: jsParams.eammAddress, data: GET_MARKET_META_SELECTOR + pad32(jsParams.marketIdUint) }, 'latest'],
  );
  const status = parseInt((marketMeta || '0x').slice(2, 66) || '0', 16);
  if (status !== 1) throw new Error(`strict check failed: market not resolved (status=${status})`);

  // 2) Exact BetPlaced log must exist at provided block + txHash.
  const logs = await rpcCall(
    jsParams.sepoliaRpc,
    'eth_getLogs',
    [{
      address: jsParams.eammAddress,
      fromBlock: jsParams.betBlockHex,
      toBlock: jsParams.betBlockHex,
      topics: [BET_PLACED_TOPIC, marketIdTopic, userTopic],
    }],
  );
  const tx = jsParams.betTxHash.toLowerCase();
  const hasExactBet = Array.isArray(logs) && logs.some((l) =>
    (l.transactionHash || '').toLowerCase() === tx
  );
  if (!hasExactBet) throw new Error('strict check failed: BetPlaced not found for provided betTxHash');

  // 3) User must have locked collateral in vault.
  const lockedData = LOCKED_AMOUNTS_SELECTOR
    + jsParams.userAddress.slice(2).toLowerCase().padStart(64, '0')
    + (jsParams.marketIdBytes32.startsWith('0x')
      ? jsParams.marketIdBytes32.slice(2)
      : jsParams.marketIdBytes32).padStart(64, '0');

  const lockedResult = await rpcCall(
    jsParams.flowRpc,
    'eth_call',
    [{ to: jsParams.vaultAddress, data: lockedData }, 'latest'],
  );
  const lockedAmount = BigInt(lockedResult || '0x0');
  if (lockedAmount <= 0n) {
    throw new Error('strict check failed: locked collateral is zero');
  }
}

const go = async () => {
  try {
    if (!jsParams.toSign) {
      throw new Error('Missing jsParams.toSign');
    }
    if (!jsParams.pkpPublicKey) {
      throw new Error('Missing jsParams.pkpPublicKey');
    }

    const mode = (jsParams.mode || 'safe').toLowerCase();
    if (mode === 'strict') {
      await strictPrechecks();
    }

    await Lit.Actions.signEcdsa({
      toSign: ethers.utils.arrayify(jsParams.toSign),
      publicKey: jsParams.pkpPublicKey,
      sigName: 'settlement',
    });

    Lit.Actions.setResponse({
      response: JSON.stringify({
        ok: true,
        marketId: String(jsParams.marketIdUint ?? ''),
        user: String(jsParams.userAddress ?? ''),
        payout: String(jsParams.payout ?? '0'),
        nonce: String(jsParams.nonce ?? ''),
        expiry: String(jsParams.expiry ?? ''),
        mode,
      }),
    });
  } catch (err) {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        error: err && err.message ? err.message : String(err),
      }),
    });
  }
};

go();
