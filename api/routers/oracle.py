"""
Oracle router — FastAPI endpoints for oracle resolution and WebSocket streaming.

REST:
  POST /api/oracle/resolve/{market_id}    — trigger resolution
  GET  /api/oracle/status/{market_id}     — get session state
  GET  /api/oracle/agents                 — agent registry info (from TS service)

WebSocket:
  WS   /api/oracle/ws/{market_id}         — live Oracle Room stream
"""

import asyncio
import json
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from api.oracle.resolution import ResolutionSession, run_resolution

router = APIRouter()

# ── In-memory session store ────────────────────────────────────────────────────

_sessions: dict[int, ResolutionSession] = {}

ORACLE_SERVICE_URL = "http://localhost:8080"

# ── Models ─────────────────────────────────────────────────────────────────────

class ResolveRequest(BaseModel):
    market_question: str = "ETH > $3000 by March 31 2026?"


# ── REST endpoints ─────────────────────────────────────────────────────────────

@router.post("/resolve/{market_id}")
async def trigger_resolution(
    market_id: int,
    body: ResolveRequest,
    background_tasks: BackgroundTasks,
):
    if market_id in _sessions:
        existing = _sessions[market_id]
        if existing.phase not in ("finalized", "failed"):
            raise HTTPException(
                status_code=409,
                detail=f"Resolution already in progress (phase: {existing.phase})",
            )

    session = ResolutionSession(
        market_id=market_id,
        market_question=body.market_question,
    )
    _sessions[market_id] = session

    background_tasks.add_task(run_resolution, session)

    return {
        "marketId":  market_id,
        "status":    "started",
        "question":  body.market_question,
        "wsUrl":     f"/api/oracle/ws/{market_id}",
    }


@router.get("/status/{market_id}")
async def get_status(market_id: int):
    session = _sessions.get(market_id)
    if not session:
        raise HTTPException(status_code=404, detail="No resolution session for this market")
    return session.to_dict()


@router.get("/agents")
async def get_agents():
    """Proxy agent registry info from the TypeScript oracle service."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{ORACLE_SERVICE_URL}/oracle/agents")
            if r.status_code == 200:
                return r.json()
    except Exception:
        pass
    # Oracle service not running — return definitions from Python side
    from api.oracle.agents import AGENTS
    return {
        "agents": [
            {"id": a.id, "name": a.name, "source": a.source, "status": "oracle-service-offline"}
            for a in AGENTS
        ]
    }


# ── WebSocket ──────────────────────────────────────────────────────────────────

@router.websocket("/ws/{market_id}")
async def oracle_websocket(ws: WebSocket, market_id: int):
    await ws.accept()

    async def send_fn(msg: dict):
        await ws.send_text(json.dumps(msg))

    # Send current state if session already exists
    session = _sessions.get(market_id)
    if session:
        await send_fn({
            "type":     "session_init",
            "marketId": market_id,
            "payload":  session.to_dict(),
        })
        session.subscribe(send_fn)
    else:
        # Wait for session to be created (client connected before trigger)
        await send_fn({
            "type":     "waiting",
            "marketId": market_id,
            "payload":  {"message": "Waiting for resolution to start..."},
        })

        for _ in range(60):   # wait up to 60s
            await asyncio.sleep(1)
            session = _sessions.get(market_id)
            if session:
                await send_fn({
                    "type":     "session_init",
                    "marketId": market_id,
                    "payload":  session.to_dict(),
                })
                session.subscribe(send_fn)
                break

    try:
        while True:
            # Keep alive — client can send pings
            data = await ws.receive_text()
            if data == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        if session:
            session.unsubscribe(send_fn)
