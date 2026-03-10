/**
 * eamm.ts — Phase 4: @zama-fhe/relayer-sdk client-side encryption + GhostEAMM helpers.
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
  parseEther,
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
 * Uses SepoliaConfig (built-in) for all FHEVM contract addresses and gateway.
 * Call once per session; subsequent calls return the cached instance.
 *
 * Optional env var:
 *   NEXT_PUBLIC_SEPOLIA_RPC_URL — private Alchemy/Infura RPC for reliability.
 *
 * Docs: https://docs.zama.org/protocol/relayer-sdk-guides/fhevm-relayer/initialization
 *
 * @param provider  EIP-1193 provider (unused with relayer-sdk but kept for API compatibility).
 */
export async function initFhevm(provider: unknown): Promise<FhevmInstance> {
  if (_fhevmInstance) return _fhevmInstance;

  // Dynamic import keeps the SDK out of the SSR bundle entirely.
  // Use the /web subpath — tree-shakes Node.js internals out of the browser bundle.
  const { createInstance } = await import('@zama-fhe/relayer-sdk/web');

  // These addresses match @fhevm/solidity ZamaConfig.sol used when GhostEAMM was compiled.
  // The SDK's built-in SepoliaConfig points to a newer, not-yet-live deployment.
  // Source: https://docs.zama.org/protocol/solidity-guides/smart-contract/configure/contract_addresses
  _fhevmInstance = await createInstance({
    aclContractAddress:                        '0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D',
    kmsContractAddress:                        '0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A',
    inputVerifierContractAddress:              '0xBBC1fFCdc7C316aAAd72E807D9b0272BE8F84DA0',
    verifyingContractAddressDecryption:        '0x5D8BD78e2ea6bbE41f26dFe9fdaEAa349e077478',
    verifyingContractAddressInputVerification: '0x483b9dE06E4E4C7D35CCf5837A1668487406D955',
    chainId:        11155111,
    gatewayChainId: 10901,
    relayerUrl:     'https://relayer.testnet.zama.org',
    network:        process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org',
  });

  return _fhevmInstance;
}

// ─── Encryption ───────────────────────────────────────────────────────────────

export interface EncryptedInput {
  /** ABI-encoded euint64 handle (bytes32) — passed as `encAmount` to placeBet. */
  handle:     `0x${string}`;
  /** Proof bytes — passed as `inputProof` to placeBet. */
  inputProof: `0x${string}`;
}

/**
 * Encrypt a bet amount (in wei) for submission to GhostEAMM.
 *
 * The resulting (handle, inputProof) pair is the FHE-encrypted representation
 * of `amountWei` bound to (contractAddress, userAddress).  No other party can
 * read the plaintext from these bytes.
 *
 * @param provider        EIP-1193 provider from Privy (unused with relayer-sdk but kept for API compat).
 * @param contractAddress GhostEAMM address on Sepolia.
 * @param userAddress     Caller's EVM address.
 * @param amountWei       Bet amount in wei (bigint).  Max ≈ 1.8 × 10^19.
 */
export async function encryptBetInput(
  provider:        unknown,
  contractAddress: `0x${string}`,
  userAddress:     `0x${string}`,
  amountWei:       bigint,
): Promise<EncryptedInput> {
  const instance = await initFhevm(provider);

  const buffer = instance.createEncryptedInput(contractAddress, userAddress);
  // add64 matches the euint64 type in the Solidity contract.
  buffer.add64(amountWei);
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

// ─── Util: FLOW amount → wei bigint ──────────────────────────────────────────

/** Convert a human-readable FLOW string (e.g. "1.5") to wei bigint. */
export function toWei(flowAmount: string): bigint {
  return parseEther(flowAmount);
}

/** True if the GhostEAMM address is configured in the environment. */
export function isEammDeployed(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_GHOST_EAMM_ADDRESS);
}
