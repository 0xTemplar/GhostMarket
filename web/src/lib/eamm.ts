/**
 * eamm.ts — @zama-fhe/relayer-sdk client-side encryption + GhostEAMM helpers.
 *
 * Chain: Ethereum Sepolia (chain 11155111).
 * Zama Protocol runs ON Ethereum Sepolia — ZamaEthereumConfig wires
 * GhostEAMM to the Sepolia FHEVM gateway at compile time.
 *
 * The relayer-sdk is NEVER statically imported here. It is loaded dynamically
 * inside `initFhevm()` which only runs in the browser (client components).
 * This keeps the SDK + its WASM out of the Next.js server bundle entirely.
 */

// Local type alias — avoids a static import at the module level.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FhevmInstance = any;
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type WalletClient,
} from 'viem';
import { sepolia } from 'viem/chains';

// ─── Contract config ──────────────────────────────────────────────────────────

export const GHOST_EAMM_ADDRESS = (
  process.env.NEXT_PUBLIC_GHOST_EAMM_ADDRESS ?? ''
) as `0x${string}`;

export const GHOST_EAMM_ABI = [
  // Write
  {
    name: 'placeBet',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'marketId',   type: 'uint256' },
      { name: 'side',       type: 'bool'    },
      { name: 'encAmount',  type: 'bytes32' }, // externalEuint64 is ABI-encoded as bytes32
      { name: 'inputProof', type: 'bytes'   },
    ],
    outputs: [],
  },
  // Views
  {
    name: 'getUserPositionHandles',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'marketId', type: 'uint256' },
      { name: 'user',     type: 'address' },
    ],
    outputs: [
      { name: 'yesHandle', type: 'bytes32' },
      { name: 'noHandle',  type: 'bytes32' },
    ],
  },
  {
    name: 'getMarketMeta',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [
      { name: 'status',   type: 'uint8'  },
      { name: 'outcome',  type: 'bool'   },
      { name: 'expiryAt', type: 'uint64' },
    ],
  },
  // Events
  {
    name: 'BetPlaced',
    type: 'event',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'user',     type: 'address', indexed: true },
      { name: 'side',     type: 'bool',    indexed: false },
    ],
  },
] as const;

// ─── Public client (read-only, Ethereum Sepolia) ─────────────────────────────

export const zamaPublicClient = createPublicClient({
  chain: sepolia,
  transport: http(
    process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org'
  ),
});

// ─── fhevmjs singleton ────────────────────────────────────────────────────────

let _fhevmInstance: FhevmInstance | null = null;

/**
 * Lazily initialise the @zama-fhe/relayer-sdk instance.
 *
 * Uses the SDK's bundled SepoliaConfig so contract addresses are always
 * in sync with the deployed Zama infrastructure — no manual address
 * management required.  Falls back to SepoliaConfigV2 if the base
 * relayer URL is unavailable (the v2 endpoint is served at /v2 and is
 * more stable under load).
 *
 * The singleton is cleared on failure so a page-level retry re-initialises
 * rather than returning a broken instance.
 *
 * Optional env var:
 *   NEXT_PUBLIC_SEPOLIA_RPC_URL — private Alchemy/Infura RPC for reliability.
 *
 * Docs: https://docs.zama.org/protocol/relayer-sdk-guides/fhevm-relayer/initialization
 */
export async function initFhevm(): Promise<FhevmInstance> {
  if (_fhevmInstance) return _fhevmInstance;

  // Dynamic import keeps the SDK + its WASM out of the SSR bundle entirely.
  const { createInstance, SepoliaConfig, SepoliaConfigV2, initSDK } =
    await import('@zama-fhe/relayer-sdk/web');

  // initSDK() MUST be called before createInstance().
  // It fetches and instantiates both WASM modules (tfhe_bg.wasm + kms_lib_bg.wasm).
  // Without this, wasm$1.__wbindgen_malloc is undefined and all crypto calls crash
  // with the misleading "wrong relayer url" error message.
  await initSDK();

  const network =
    process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';

  // Try base SepoliaConfig first; if the relayer is unreachable fall back
  // to the versioned /v2 endpoint which has been more stable in practice.
  try {
    _fhevmInstance = await createInstance({ ...SepoliaConfig, network });
  } catch {
    _fhevmInstance = null; // ensure we don't cache a broken instance
    _fhevmInstance = await createInstance({ ...SepoliaConfigV2, network });
  }

  return _fhevmInstance;
}

/** Clear the cached instance — call this if encryption fails so the next
 *  attempt re-initialises rather than reusing a potentially broken instance. */
export function resetFhevmInstance(): void {
  _fhevmInstance = null;
}

// ─── Encryption ───────────────────────────────────────────────────────────────

export interface EncryptedInput {
  /** ABI-encoded euint64 handle (bytes32) — passed as `encAmount` to placeBet. */
  handle:     `0x${string}`;
  /** Proof bytes — passed as `inputProof` to placeBet. */
  inputProof: `0x${string}`;
}

/**
 * Encrypt a bet amount for submission to GhostEAMM.
 *
 * The resulting (handle, inputProof) pair is the FHE-encrypted representation
 * of `amount` bound to (contractAddress, userAddress).  No other party can
 * read the plaintext from these bytes.
 *
 * @param provider        EIP-1193 provider from Privy.
 * @param contractAddress GhostEAMM address on Sepolia.
 * @param userAddress     Caller's EVM address.
 * @param amount          Bet amount in USDC base units (6 decimals, bigint).
 *                        e.g. parseUnits("10", 6) for a 10 USDC bet.
 */
export async function encryptBetInput(
  provider:        unknown,
  contractAddress: `0x${string}`,
  userAddress:     `0x${string}`,
  amount:          bigint,
): Promise<EncryptedInput> {
  const instance = await initFhevm();

  const buffer = instance.createEncryptedInput(contractAddress, userAddress);
  // add64 matches the euint64 type in the Solidity contract.
  buffer.add64(amount);
  const ciphertexts = await buffer.encrypt();

  // handles[0] and inputProof may be hex strings or Uint8Arrays depending on SDK version.
  const toHex = (v: string | Uint8Array) =>
    typeof v === 'string' ? v : `0x${Buffer.from(v).toString('hex')}`;

  const handle     = toHex(ciphertexts.handles[0]) as `0x${string}`;
  const inputProof = toHex(ciphertexts.inputProof)  as `0x${string}`;

  return { handle, inputProof };
}

// ─── Write helpers ────────────────────────────────────────────────────────────

/**
 * Submit an encrypted bet to GhostEAMM on the Zama devnet.
 *
 * @param walletClient  viem WalletClient connected to Zama devnet.
 * @param marketId      GhostMarket market ID.
 * @param side          true = YES, false = NO.
 * @param encrypted     Output from `encryptBetInput`.
 * @returns             Transaction hash.
 */
export async function placeEncryptedBet(
  walletClient: WalletClient,
  marketId:     number,
  side:         boolean,
  encrypted:    EncryptedInput,
): Promise<`0x${string}`> {
  const [account] = await walletClient.getAddresses();

  const { request } = await zamaPublicClient.simulateContract({
    address: GHOST_EAMM_ADDRESS,
    abi:     GHOST_EAMM_ABI,
    functionName: 'placeBet',
    args:    [BigInt(marketId), side, encrypted.handle, encrypted.inputProof],
    account,
  });

  return walletClient.writeContract(request);
}

// ─── Gateway decryption ───────────────────────────────────────────────────────

/**
 * Decrypt one or more encrypted handles that the calling user has ACL access to.
 *
 * The flow:
 *  1. Generate a one-shot keypair.
 *  2. Ask the user to sign an EIP-712 reencryption authorisation (single pop-up,
 *     regardless of how many handles are batched).
 *  3. The KMS gateway re-encrypts each handle under the ephemeral public key.
 *  4. Decrypt locally and return a map of handle → plaintext bigint.
 *
 * All handles must have been granted to `userAddress` via `FHE.allow()` in the
 * relevant contract, otherwise the gateway rejects the request.
 *
 * @param walletClient  viem WalletClient (must be the owner of the handles).
 * @param handles       Array of { handle, contractAddress } pairs.
 * @param userAddress   EVM address that owns the handles.
 */
export async function userDecryptHandles(
  walletClient: WalletClient,
  handles: Array<{ handle: `0x${string}`; contractAddress: `0x${string}` }>,
  userAddress: `0x${string}`,
): Promise<Record<`0x${string}`, bigint>> {
  const instance = await initFhevm();

  const { publicKey, privateKey } = instance.generateKeypair() as {
    publicKey: string;
    privateKey: string;
  };

  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays   = 1;

  const contractAddresses = [...new Set(handles.map((h) => h.contractAddress))];

  const eip712 = instance.createEIP712(
    publicKey,
    contractAddresses,
    startTimestamp,
    durationDays,
  ) as { domain: unknown; types: unknown; primaryType: string; message: unknown };

  const signature = await walletClient.signTypedData({
    account:     userAddress,
    domain:      eip712.domain as Parameters<WalletClient['signTypedData']>[0]['domain'],
    types:       eip712.types  as Parameters<WalletClient['signTypedData']>[0]['types'],
    primaryType: eip712.primaryType,
    message:     eip712.message as Parameters<WalletClient['signTypedData']>[0]['message'],
  });

  const results = await instance.userDecrypt(
    handles,
    privateKey,
    publicKey,
    signature,
    contractAddresses,
    userAddress,
    startTimestamp,
    durationDays,
  ) as Record<`0x${string}`, bigint>;

  return results;
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

export interface PositionHandles {
  yesHandle: `0x${string}`;
  noHandle:  `0x${string}`;
}

/**
 * Read a user's encrypted position handles from GhostEAMM.
 * The handles are opaque bytes32 values; only an ACL-permitted address
 * can gateway-decrypt them (see `grantPositionAccess` in the contract).
 */
export async function readEammPositionHandles(
  marketId:    number,
  userAddress: `0x${string}`,
): Promise<PositionHandles> {
  const [yesHandle, noHandle] = await zamaPublicClient.readContract({
    address:      GHOST_EAMM_ADDRESS,
    abi:          GHOST_EAMM_ABI,
    functionName: 'getUserPositionHandles',
    args:         [BigInt(marketId), userAddress],
  }) as [`0x${string}`, `0x${string}`];

  return { yesHandle, noHandle };
}

export interface EammMarketMeta {
  status:   number;   // 0 Active | 1 Resolved | 2 Cancelled
  outcome:  boolean;
  expiryAt: number;   // unix seconds
}

export async function readEammMarketMeta(marketId: number): Promise<EammMarketMeta> {
  const [status, outcome, expiryAt] = await zamaPublicClient.readContract({
    address:      GHOST_EAMM_ADDRESS,
    abi:          GHOST_EAMM_ABI,
    functionName: 'getMarketMeta',
    args:         [BigInt(marketId)],
  }) as [number, boolean, bigint];

  return { status, outcome, expiryAt: Number(expiryAt) };
}

// ─── Convenience: build a WalletClient for Zama devnet from Privy provider ───

/**
 * Wrap a Privy EIP-1193 provider into a viem WalletClient targeting Sepolia.
 * Used in the bet slip to sign the `placeBet` transaction on GhostEAMM.
 */
export function buildZamaWalletClient(provider: unknown): WalletClient {
  return createWalletClient({
    chain:     sepolia,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transport: custom(provider as any),
  });
}

/** True if the GhostEAMM address is configured in the environment. */
export function isEammDeployed(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_GHOST_EAMM_ADDRESS);
}
