"""
Relayer router — gas sponsorship proxy for Ethereum Sepolia.

Architecture:
  Users hold an embedded Privy wallet on Sepolia. They sign transactions
  directly — there is no gasless gateway. This relayer provides two helpers:

  POST /api/relayer/tx
    Forward a pre-signed EVM transaction to the Sepolia RPC.
    Useful for cases where the frontend cannot reach the RPC directly.

  POST /api/relayer/deposit
    Backend EOA calls GhostVault.depositFor(user) on behalf of a user,
    paying Sepolia gas from the relayer wallet (dev/testing only).

Environment variables:
  SEPOLIA_RPC_URL       Sepolia JSON-RPC endpoint (default: public)
  RELAYER_PRIVATE_KEY   Backend relayer EOA private key (optional)
  GHOST_VAULT_ADDRESS   Deployed GhostVault contract address
"""
from __future__ import annotations

import os

import httpx
from eth_account import Account
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from web3 import Web3

router = APIRouter()

SEPOLIA_RPC_URL     = os.getenv("SEPOLIA_RPC_URL", "https://rpc.sepolia.org")
RELAYER_PRIVATE_KEY = os.getenv("RELAYER_PRIVATE_KEY", "")
GHOST_VAULT_ADDRESS = os.getenv("GHOST_VAULT_ADDRESS", "")

VAULT_ABI = [
    {
        "name": "depositFor",
        "type": "function",
        "stateMutability": "payable",
        "inputs": [{"name": "user", "type": "address"}],
        "outputs": [],
    },
]


# ─── Request / response models ────────────────────────────────────────────────

class RawTxRequest(BaseModel):
    raw_tx: str  # hex-encoded signed transaction (0x-prefixed)


class DepositRequest(BaseModel):
    user_address: str   # EVM address of the user
    amount_eth:   str   # Amount in ETH as a decimal string, e.g. "0.05"


class RelayResponse(BaseModel):
    tx_hash: str
    mode:    str


# ─── Forward raw TX ───────────────────────────────────────────────────────────

@router.post("/tx", response_model=RelayResponse)
async def relay_raw_tx(body: RawTxRequest) -> RelayResponse:
    """Forward a pre-signed transaction to the Sepolia JSON-RPC node."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_sendRawTransaction",
        "params": [body.raw_tx],
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(SEPOLIA_RPC_URL, json=payload)
        resp.raise_for_status()
        result = resp.json()

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"].get("message", "RPC error"))

    return RelayResponse(tx_hash=result.get("result", ""), mode="sepolia-rpc")


# ─── Backend EOA deposit relay ────────────────────────────────────────────────

@router.post("/deposit", response_model=RelayResponse)
def relay_deposit(body: DepositRequest) -> RelayResponse:
    """Backend wallet calls depositFor(user) on GhostVault — dev/testing helper."""
    if not RELAYER_PRIVATE_KEY:
        raise HTTPException(status_code=503, detail="RELAYER_PRIVATE_KEY not set.")
    if not GHOST_VAULT_ADDRESS:
        raise HTTPException(status_code=503, detail="GHOST_VAULT_ADDRESS not set.")

    try:
        amount_wei = Web3.to_wei(float(body.amount_eth), "ether")
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid amount: {exc}") from exc

    w3 = Web3(Web3.HTTPProvider(SEPOLIA_RPC_URL))
    relayer = Account.from_key(RELAYER_PRIVATE_KEY)
    vault = w3.eth.contract(
        address=Web3.to_checksum_address(GHOST_VAULT_ADDRESS),
        abi=VAULT_ABI,
    )

    nonce = w3.eth.get_transaction_count(relayer.address)
    tx = vault.functions.depositFor(
        Web3.to_checksum_address(body.user_address)
    ).build_transaction({
        "from":     relayer.address,
        "value":    amount_wei,
        "nonce":    nonce,
        "gas":      80_000,
        "gasPrice": w3.eth.gas_price,
    })

    signed  = relayer.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    return RelayResponse(tx_hash=tx_hash.hex(), mode="backend-eoa")
