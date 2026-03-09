"""
Relayer router — gasless transaction proxy for Flow EVM.

Gasless architecture (Flow-native, no meta-transactions needed):
─────────────────────────────────────────────────────────────────
Flow EVM's unique transaction model allows setting up a custom EVM Gateway
with GAS_PRICE=0 and a funded Service Account. Every EVM transaction routed
through that gateway is automatically sponsored — users sign normally but pay
no gas.

Reference:
https://developers.flow.com/blockchain-development-tutorials/gasless-transactions/sponsored-transactions-evm-endpoint

This relayer provides two modes:

  Mode A — Sponsored RPC proxy (production):
    The signed EVM transaction from the user's FCL wallet is forwarded to a
    custom EVM Gateway running with GAS_PRICE=0.  The gateway's Service
    Account covers all Cadence transaction fees.  No contract changes needed;
    deposit() works as-is.

  Mode B — Backend EOA relay (development / fallback):
    The backend holds a funded relayer wallet and calls depositFor(user)
    directly, paying gas from its own balance.  Useful during development
    before a sponsored gateway is deployed.

Environment variables:
  FLOW_EVM_RPC                 Flow EVM RPC endpoint (default: testnet public node)
  FLOW_EVM_SPONSORED_RPC       Custom sponsored gateway URL (Mode A)
  RELAYER_PRIVATE_KEY          Backend relayer EOA private key (Mode B)
  GHOST_VAULT_ADDRESS          Deployed GhostVault contract address
"""
from __future__ import annotations

import os
from typing import Any

import httpx
from eth_account import Account
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from web3 import Web3

router = APIRouter()

FLOW_EVM_RPC = os.getenv("FLOW_EVM_RPC", "https://testnet.evm.nodes.onflow.org")
FLOW_EVM_SPONSORED_RPC = os.getenv("FLOW_EVM_SPONSORED_RPC", "")
RELAYER_PRIVATE_KEY = os.getenv("RELAYER_PRIVATE_KEY", "")
GHOST_VAULT_ADDRESS = os.getenv("GHOST_VAULT_ADDRESS", "")

# Minimal ABI — only the functions the relayer calls
VAULT_ABI = [
    {
        "name": "depositFor",
        "type": "function",
        "stateMutability": "payable",
        "inputs": [{"name": "user", "type": "address"}],
        "outputs": [],
    },
]


# ─── Request / response models ──────────────────────────────────────────────

class RawTxRequest(BaseModel):
    """
    Mode A: Forward a pre-signed EVM transaction to the sponsored gateway.
    The frontend builds and signs the transaction using the FCL EVM provider,
    then sends the raw hex here rather than directly to the public RPC.
    """
    raw_tx: str  # hex-encoded signed transaction (0x-prefixed)


class DepositRequest(BaseModel):
    """
    Mode B: Backend builds and submits the depositFor() call on behalf of
    the user, paying gas from the relayer wallet.
    """
    user_address: str   # EVM address of the user (COA)
    amount_flow: str    # Amount in FLOW as a decimal string, e.g. "1.5"


class RelayResponse(BaseModel):
    tx_hash: str
    mode: str


# ─── Mode A — Sponsored RPC proxy ────────────────────────────────────────────

@router.post("/tx", response_model=RelayResponse)
async def relay_raw_tx(body: RawTxRequest) -> RelayResponse:
    """
    Forward a signed EVM transaction to the sponsored EVM gateway.
    The gateway's Service Account (configured with COA_KEY + GAS_PRICE=0)
    wraps it in a Cadence transaction and pays all fees.
    """
    target_rpc = FLOW_EVM_SPONSORED_RPC or FLOW_EVM_RPC

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_sendRawTransaction",
        "params": [body.raw_tx],
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(target_rpc, json=payload)
        resp.raise_for_status()
        result = resp.json()

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"].get("message", "RPC error"))

    tx_hash: str = result.get("result", "")
    return RelayResponse(tx_hash=tx_hash, mode="sponsored-rpc" if FLOW_EVM_SPONSORED_RPC else "public-rpc")


# ─── Mode B — Backend EOA relay ──────────────────────────────────────────────

@router.post("/deposit", response_model=RelayResponse)
def relay_deposit(body: DepositRequest) -> RelayResponse:
    """
    Backend calls depositFor(user) on the vault, paying gas from the relayer
    wallet.  Uses Mode B (backend EOA); suitable for development or as a
    fallback before the sponsored gateway is live.
    """
    if not RELAYER_PRIVATE_KEY:
        raise HTTPException(
            status_code=503,
            detail=(
                "Relayer not configured. Set RELAYER_PRIVATE_KEY in the API environment, "
                "or use the /api/relayer/tx endpoint with a sponsored RPC gateway."
            ),
        )
    if not GHOST_VAULT_ADDRESS:
        raise HTTPException(status_code=503, detail="GHOST_VAULT_ADDRESS not set — deploy the contract first.")

    try:
        amount_wei = Web3.to_wei(float(body.amount_flow), "ether")
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid amount: {exc}") from exc

    w3 = Web3(Web3.HTTPProvider(FLOW_EVM_SPONSORED_RPC or FLOW_EVM_RPC))
    relayer = Account.from_key(RELAYER_PRIVATE_KEY)
    vault = w3.eth.contract(
        address=Web3.to_checksum_address(GHOST_VAULT_ADDRESS),
        abi=VAULT_ABI,
    )

    nonce = w3.eth.get_transaction_count(relayer.address)
    tx = vault.functions.depositFor(
        Web3.to_checksum_address(body.user_address)
    ).build_transaction({
        "from": relayer.address,
        "value": amount_wei,
        "nonce": nonce,
        "gas": 80_000,
        "gasPrice": w3.eth.gas_price,
    })

    signed = relayer.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)

    return RelayResponse(tx_hash=tx_hash.hex(), mode="backend-eoa")


@router.post("/withdraw", response_model=RelayResponse)
def relay_withdraw(body: DepositRequest) -> RelayResponse:
    """
    Stub — withdraw relay path mirrors deposit but calls withdraw().
    In Phase 2 users can also call withdraw() directly via the FCL EVM
    provider; this route is available for fully gasless flows.
    """
    raise HTTPException(
        status_code=501,
        detail=(
            "Withdraw relay not yet implemented. "
            "Use /api/relayer/tx to forward a pre-signed withdraw() call "
            "through the sponsored RPC gateway instead."
        ),
    )
