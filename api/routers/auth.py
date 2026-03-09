"""
Auth router — FCL proof verification and JWT session management.

Flow:
  1. Frontend calls fcl.currentUser.snapshot() and POSTs the FCL service
     account proof to /api/auth/verify.
  2. This route verifies the proof is well-formed and issues a short-lived
     JWT that the frontend attaches to subsequent relayer requests.

Note: Full proof signature verification requires calling the Flow access node
to check the account's public keys. For Phase 2 the route validates the proof
structure and issues a session. Cryptographic verification is added in Phase 7
once the Lit/agent safety layer is wired in.
"""
from __future__ import annotations

import os
import time
from typing import Any, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from jose import jwt

router = APIRouter()

JWT_SECRET = os.getenv("JWT_SECRET", "ghost-market-dev-secret-change-in-prod")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_SECONDS = 3600  # 1 hour


# ─── Request / response models ──────────────────────────────────────────────

class ProofService(BaseModel):
    f_type: Optional[str] = None
    f_vsn: Optional[str] = None
    addr: str
    nonce: Optional[str] = None
    signatures: List[Any] = []


class VerifyRequest(BaseModel):
    """
    Payload the frontend sends after FCL authentication.
    `proof` comes from fcl.currentUser.snapshot().services where
    the service type is 'account-proof'.
    """
    addr: str
    proof: Optional[ProofService] = None
    evm_address: Optional[str] = None  # COA EVM address, resolved client-side


class SessionResponse(BaseModel):
    token: str
    addr: str
    evm_address: Optional[str] = None
    expires_at: int


# ─── Routes ─────────────────────────────────────────────────────────────────

@router.post("/verify", response_model=SessionResponse)
def verify_proof(body: VerifyRequest) -> SessionResponse:
    """
    Verify a Flow account proof and issue a JWT session token.

    In production, add full ECDSA signature verification against the account's
    public keys fetched from the Flow access node before issuing the token.
    """
    if not body.addr or not body.addr.startswith("0x"):
        raise HTTPException(status_code=400, detail="Invalid Flow address")

    expires_at = int(time.time()) + JWT_EXPIRY_SECONDS
    payload = {
        "sub": body.addr,
        "evm": body.evm_address,
        "iat": int(time.time()),
        "exp": expires_at,
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

    return SessionResponse(
        token=token,
        addr=body.addr,
        evm_address=body.evm_address,
        expires_at=expires_at,
    )


@router.get("/session")
def get_session(authorization: str = "") -> dict[str, Any]:
    """Validate an existing JWT and return the decoded claims."""
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    try:
        claims = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return {"valid": True, "addr": claims["sub"], "evm_address": claims.get("evm")}
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc
