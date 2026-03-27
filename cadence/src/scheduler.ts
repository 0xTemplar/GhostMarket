/**
 * scheduler.ts — FCL setup and scheduleVaultDelivery() for GhostMarket.
 *
 * After oracle quorum, the oracle service calls POST /schedule on this adapter.
 * This module:
 *   1. Fetches the market's expiryAt from GhostMarket on Flow EVM.
 *   2. Encodes the marketId as bytes32 hex.
 *   3. Calls FlowTransactionScheduler.schedule() via FCL, using the Cadence
 *      account's secp256k1 key to sign.
 *
 * Gracefully returns { status: 'skipped' } if env vars are not configured,
 * so the oracle's existing vault-reporter.ts path remains the fallback.
 */

import * as fcl  from '@onflow/fcl';
import * as t    from '@onflow/types';
import { ethers }    from 'ethers';
import { readFileSync } from 'fs';
import { join }        from 'path';
import dotenv          from 'dotenv';
import { buildAuthorizationFunction } from './signer';

dotenv.config();

// ── Config ────────────────────────────────────────────────────────────────────

const CADENCE_ACCOUNT_ADDRESS = process.env.CADENCE_ACCOUNT_ADDRESS ?? '';
const CADENCE_PRIVATE_KEY     = process.env.CADENCE_PRIVATE_KEY     ?? '';
const CADENCE_KEY_INDEX       = Number(process.env.CADENCE_KEY_INDEX ?? 0);
const FLOW_ACCESS_NODE        = process.env.FLOW_ACCESS_NODE        ?? 'https://rest-testnet.onflow.org';
const FLOW_NETWORK            = process.env.FLOW_NETWORK            ?? 'testnet';
const FLOW_RPC_URL            = process.env.FLOW_RPC_URL            ?? 'https://testnet.evm.nodes.onflow.org';
const GHOST_VAULT_ADDRESS     = process.env.GHOST_VAULT_ADDRESS     ?? '';
const GHOST_MARKET_ADDRESS    = process.env.GHOST_MARKET_ADDRESS    ?? '';
const SCHEDULER_FEE_FLOW      = process.env.CADENCE_SCHEDULER_FEE_FLOW ?? '0.01';

// Contract addresses on Flow Testnet — used by FCL to resolve import "X" aliases.
const FLOW_TRANSACTION_SCHEDULER_ADDR = process.env.FLOW_TRANSACTION_SCHEDULER_ADDR ?? '0x8c5303eaa26202d6';
const GHOST_VAULT_HANDLER_ADDR        = process.env.CADENCE_HANDLER_CONTRACT_ADDRESS ?? '';
const FLOW_TOKEN_ADDR                 = process.env.FLOW_TOKEN_ADDR    ?? '0x7e60df042a9c0868';
const FUNGIBLE_TOKEN_ADDR             = process.env.FUNGIBLE_TOKEN_ADDR ?? '0x9a0766d93b6608b7';

// ── FCL init (called lazily once) ────────────────────────────────────────────

let fclInitialized = false;

function initFcl() {
  if (fclInitialized) return;

  fcl.config({
    'flow.network':   FLOW_NETWORK,
    'accessNode.api': FLOW_ACCESS_NODE,

    // Contract address aliases resolved in Cadence import "X" statements.
    '0xFlowTransactionScheduler':      FLOW_TRANSACTION_SCHEDULER_ADDR,
    '0xFlowTransactionSchedulerUtils': FLOW_TRANSACTION_SCHEDULER_ADDR,
    '0xGhostVaultResolverHandler':     GHOST_VAULT_HANDLER_ADDR,
    '0xEVM':                           FLOW_TRANSACTION_SCHEDULER_ADDR,
    '0xFlowToken':                     FLOW_TOKEN_ADDR,
    '0xFungibleToken':                 FUNGIBLE_TOKEN_ADDR,
  });

  fclInitialized = true;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScheduleResult {
  status:  'scheduled' | 'skipped' | 'failed';
  txId:    string | null;
  message: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isConfigured(): boolean {
  return !!(
    CADENCE_ACCOUNT_ADDRESS &&
    CADENCE_PRIVATE_KEY     &&
    GHOST_VAULT_ADDRESS     &&
    GHOST_MARKET_ADDRESS    &&
    GHOST_VAULT_HANDLER_ADDR
  );
}

/**
 * Read the market's expiryAt timestamp from GhostMarket on Flow EVM.
 * Returns Unix seconds as a number.
 */
async function fetchMarketExpiryAt(marketId: string): Promise<number> {
  const provider = new ethers.JsonRpcProvider(FLOW_RPC_URL);
  const abi = [
    'function markets(uint256) view returns (string,string,string,string,uint64,uint8,uint256,uint256,bool,address)',
  ];
  const market  = new ethers.Contract(GHOST_MARKET_ADDRESS, abi, provider);
  const raw     = await market.markets(BigInt(marketId));
  const expiry  = Number(raw[4]);
  if (!expiry || expiry === 0) throw new Error(`Market ${marketId} has no expiryAt`);
  return expiry;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Schedule a GhostVault.reportOutcome() call to fire at market expiry via
 * FlowTransactionScheduler on Flow Testnet.
 *
 * Returns 'skipped' if the adapter is not fully configured, 'scheduled' on
 * success, or 'failed' with an error message.
 */
export async function scheduleVaultDelivery(
  marketId: string,
  outcome:  boolean,
): Promise<ScheduleResult> {
  if (!isConfigured()) {
    return {
      status:  'skipped',
      txId:    null,
      message: 'Cadence adapter not fully configured — set CADENCE_ACCOUNT_ADDRESS, CADENCE_PRIVATE_KEY, CADENCE_HANDLER_CONTRACT_ADDRESS',
    };
  }

  initFcl();

  // ── Fetch expiryAt ────────────────────────────────────────────────────────
  let expiryAt: number;
  try {
    expiryAt = await fetchMarketExpiryAt(marketId);
  } catch (err) {
    return {
      status:  'failed',
      txId:    null,
      message: `Failed to fetch market expiryAt: ${(err as Error).message}`,
    };
  }

  // Schedule at expiryAt, but always at least 60 s in the future (scheduler
  // rejects timestamps in the past or too close to now).
  const now        = Math.floor(Date.now() / 1000);
  const scheduleAt = Math.max(expiryAt, now + 60);

  // ── Encode args ───────────────────────────────────────────────────────────
  // marketId as bytes32 hex, no 0x (64 chars).
  const marketIdHex    = ethers.zeroPadValue(ethers.toBeHex(BigInt(marketId)), 32).slice(2);
  const ghostVaultHex  = GHOST_VAULT_ADDRESS.toLowerCase().replace(/^0x/, '');
  const timestampUFix  = scheduleAt.toFixed(8);
  const feeUFix        = parseFloat(SCHEDULER_FEE_FLOW).toFixed(8);

  // ── Build FCL auth ────────────────────────────────────────────────────────
  const authFn = buildAuthorizationFunction(
    CADENCE_ACCOUNT_ADDRESS,
    CADENCE_PRIVATE_KEY,
    CADENCE_KEY_INDEX,
  );

  // ── Read Cadence transaction from disk ────────────────────────────────────
  const cadenceTx = readFileSync(
    join(__dirname, '../transactions/schedule-delivery.cdc'),
    'utf8',
  );

  // ── Submit ────────────────────────────────────────────────────────────────
  try {
    const txId = await fcl.mutate({
      cadence: cadenceTx,
      args: (arg: typeof fcl.arg, types: typeof t) => [
        arg(timestampUFix, types.UFix64),
        arg(feeUFix,       types.UFix64),
        arg(marketIdHex,   types.String),
        arg(outcome,       types.Bool),
        arg(ghostVaultHex, types.String),
      ],
      proposer:       authFn,
      payer:          authFn,
      authorizations: [authFn],
      limit:          999,
    });

    const deliveryTime = new Date(scheduleAt * 1000).toISOString();
    console.log(`[CadenceScheduler] Delivery scheduled — market ${marketId} at ${deliveryTime} — Flow tx: ${txId}`);

    return {
      status:  'scheduled',
      txId,
      message: `Cadence delivery scheduled for market ${marketId} at ${deliveryTime} (tx: ${txId})`,
    };
  } catch (err) {
    return {
      status:  'failed',
      txId:    null,
      message: `FCL mutate failed: ${(err as Error).message}`,
    };
  }
}
