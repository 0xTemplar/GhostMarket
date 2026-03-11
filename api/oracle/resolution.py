"""
Resolution session manager.

Owns the state machine for a single market resolution run:
  collecting → quorum_reached → uploading → finalized

Coordinates 7 agents concurrently, streams progress to WebSocket
subscribers, and calls the TypeScript oracle service for chain
interactions (Synapse uploads, OracleAgentRegistry, ERC-8004).
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine

import httpx

from .agents import AGENTS, run_agent_decision, Attestation

# ── Types ──────────────────────────────────────────────────────────────────────

AgentStatus = str  # idle | fetching | attesting | submitted | slashed

@dataclass
class AgentState:
    id:              int
    name:            str
    source:          str
    reputation:      int  = 80
    status:          AgentStatus = "idle"
    vote:            bool | None = None
    reasoning:       str  = ""
    storacha_cid:    str | None = None
    filecoin_cid:    str | None = None
    attested_at:     int | None = None   # unix ms
    erc8004_id:      int | None = None


@dataclass
class LogEntry:
    ts:         int             # unix ms
    agent:      str | None
    message:    str
    tx_hash:    str | None = None
    cid:        str | None = None

    def to_dict(self) -> dict:
        return {
            "ts":      self.ts,
            "agent":   self.agent,
            "message": self.message,
            "txHash":  self.tx_hash,
            "cid":     self.cid,
        }


@dataclass
class ResolutionSession:
    market_id:          int
    market_question:    str
    phase:              str = "pending"   # pending|collecting|quorum_reached|uploading|finalized|failed
    agents:             list[AgentState] = field(default_factory=list)
    yes_votes:          int = 0
    no_votes:           int = 0
    outcome:            bool | None = None
    final_evidence_cid: str | None = None
    calibration_tx:     str | None = None
    flow_tx:            str | None = None
    started_at:         int = field(default_factory=lambda: int(time.time() * 1000))
    finalized_at:       int | None = None
    log:                list[LogEntry] = field(default_factory=list)

    # Registered WebSocket send callbacks
    _subscribers: list[Callable[[dict], Coroutine]] = field(default_factory=list, repr=False)

    def subscribe(self, send_fn: Callable[[dict], Coroutine]):
        self._subscribers.append(send_fn)

    def unsubscribe(self, send_fn: Callable[[dict], Coroutine]):
        self._subscribers = [s for s in self._subscribers if s is not send_fn]

    async def _broadcast(self, msg: dict):
        dead = []
        for fn in self._subscribers:
            try:
                await fn(msg)
            except Exception:
                dead.append(fn)
        for fn in dead:
            self.unsubscribe(fn)

    def _log(self, message: str, agent: str | None = None, tx_hash: str | None = None, cid: str | None = None) -> LogEntry:
        entry = LogEntry(ts=int(time.time() * 1000), agent=agent, message=message, tx_hash=tx_hash, cid=cid)
        self.log.append(entry)
        return entry

    async def _emit_log(self, message: str, agent: str | None = None, tx_hash: str | None = None, cid: str | None = None):
        entry = self._log(message, agent, tx_hash, cid)
        await self._broadcast({"type": "log", "marketId": self.market_id, "payload": entry.to_dict()})

    async def _emit_agent(self, agent_state: AgentState):
        await self._broadcast({
            "type":     "agent_update",
            "marketId": self.market_id,
            "payload": {
                "id":          agent_state.id,
                "name":        agent_state.name,
                "source":      agent_state.source,
                "reputation":  agent_state.reputation,
                "status":      agent_state.status,
                "vote":        agent_state.vote,
                "reasoning":   agent_state.reasoning,
                "storachaCid": agent_state.storacha_cid,
                "filecoinCid": agent_state.filecoin_cid,
                "attestedAt":  agent_state.attested_at,
            },
        })

    def to_dict(self) -> dict:
        return {
            "marketId":        self.market_id,
            "marketQuestion":  self.market_question,
            "phase":           self.phase,
            "yesVotes":        self.yes_votes,
            "noVotes":         self.no_votes,
            "outcome":         self.outcome,
            "finalEvidenceCid": self.final_evidence_cid,
            "calibrationTx":  self.calibration_tx,
            "startedAt":       self.started_at,
            "finalizedAt":     self.finalized_at,
            "agents": [{
                "id":          a.id,
                "name":        a.name,
                "source":      a.source,
                "reputation":  a.reputation,
                "status":      a.status,
                "vote":        a.vote,
                "storachaCid": a.storacha_cid,
                "filecoinCid": a.filecoin_cid,
                "attestedAt":  a.attested_at,
            } for a in self.agents],
            "log": [e.to_dict() for e in self.log[-100:]],
        }


# ── Oracle service proxy (calls TypeScript oracle/ service) ───────────────────

ORACLE_SERVICE_URL = "http://localhost:8080"

async def _call_oracle_service(path: str, payload: dict | None = None) -> dict | None:
    """
    Call the TypeScript oracle service for chain interactions
    (Synapse uploads, OracleAgentRegistry, Storacha, ERC-8004).
    Returns None gracefully if the service is not running.
    """
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            if payload is not None:
                r = await client.post(f"{ORACLE_SERVICE_URL}{path}", json=payload)
            else:
                r = await client.get(f"{ORACLE_SERVICE_URL}{path}")
            if r.status_code == 200:
                return r.json()
    except Exception as e:
        print(f"[OracleService] {path} failed: {e}")
    return None


# ── Storacha peer-read helpers ────────────────────────────────────────────────

# Agent IDs that wait for peers before voting (Storacha Track 2 — coordination)
PEER_READING_AGENTS = {5, 7}   # Shade (5) and Vex (7)
MIN_PEERS_BEFORE_READ = 3      # wait for at least 3 submissions before reading

async def _fetch_peer_evidence(
    session: ResolutionSession,
    reader_name: str,
) -> list[dict]:
    """
    Read already-submitted agents' Storacha CIDs from the oracle service,
    returning parsed evidence objects. Called by Shade and Vex before voting.
    """
    peers = [
        a for a in session.agents
        if a.status == "submitted" and a.storacha_cid
    ]
    if not peers:
        return []

    peer_data = []
    for peer in peers[:4]:   # read up to 4 peer submissions
        result = await _call_oracle_service(f"/oracle/storacha/read/{peer.storacha_cid}")
        if result and "evidence" in result:
            peer_data.append({
                "agentName": peer.name,
                "source":    peer.source,
                "vote":      "YES" if result["evidence"].get("vote") else "NO",
                "reasoning": result["evidence"].get("reasoning", ""),
            })

    if peer_data:
        await session._emit_log(
            f"{reader_name} read {len(peer_data)} peer attestations from Storacha "
            f"({', '.join(p['agentName'] for p in peer_data)})",
            agent=reader_name,
        )

    return peer_data


# ── Per-agent task ─────────────────────────────────────────────────────────────

async def _run_agent_task(session: ResolutionSession, agent_state: AgentState):
    """Full decision loop for one agent within a resolution session."""

    # Staggered start so agents don't all fire at the same moment
    await asyncio.sleep(1.0 + agent_state.id * 0.7 + (time.time() % 1.0))

    # ── FETCHING ────────────────────────────────────────────────────────────────
    agent_state.status = "fetching"
    await _emit_agent_and_log(session, agent_state,
        f"fetching data from {agent_state.source}")

    # Shade (5) and Vex (7) wait for earlier agents to submit,
    # then read their evidence from Storacha before voting.
    # This is the load-bearing multi-agent coordination behaviour (Storacha Track 2).
    peer_evidence: list[dict] = []
    if agent_state.id in PEER_READING_AGENTS:
        # Poll until enough peers have submitted or timeout (30s)
        wait_label = "cross-referencing" if agent_state.id == 5 else "auditing peers"
        await session._emit_log(
            f"{agent_state.name} waiting for peer attestations before voting ({wait_label})...",
            agent=agent_state.name,
        )
        for _ in range(30):
            submitted = sum(1 for a in session.agents if a.status == "submitted")
            if submitted >= MIN_PEERS_BEFORE_READ:
                break
            await asyncio.sleep(1)

        peer_evidence = await _fetch_peer_evidence(session, agent_state.name)

    # Run LLM decision (fetches real data + incorporates peer evidence)
    attestation: Attestation = await run_agent_decision(
        agent_id=agent_state.id,
        market_question=session.market_question,
        market_id=session.market_id,
        peer_evidence=peer_evidence if peer_evidence else None,
    )

    # ── ATTESTING ───────────────────────────────────────────────────────────────
    agent_state.status    = "attesting"
    agent_state.vote      = attestation.vote
    agent_state.reasoning = attestation.reasoning
    await _emit_agent_and_log(session, agent_state,
        f'attested {"YES" if attestation.vote else "NO"} — "{attestation.reasoning[:80]}..."')

    # Write intermediate evidence to Storacha (via TypeScript oracle service)
    storacha_result = await _call_oracle_service("/oracle/storacha/upload", {
        "agentId":   agent_state.id,
        "marketId":  session.market_id,
        "evidence": {
            "source":    attestation.source,
            "timestamp": attestation.timestamp,
            "claim":     "YES" if attestation.vote else "NO",
            "vote":      attestation.vote,
            "dataHash":  attestation.data_hash,
            "reasoning": attestation.reasoning,
        },
    })

    if storacha_result and storacha_result.get("cid"):
        agent_state.storacha_cid = storacha_result["cid"]
        await session._emit_log(
            f"evidence → Storacha CID: {agent_state.storacha_cid[:24]}...",
            agent=agent_state.name,
            cid=agent_state.storacha_cid,
        )

    # Submit attestation to OracleAgentRegistry on Calibration
    attest_result = await _call_oracle_service("/oracle/registry/attest", {
        "agentId":   agent_state.id,
        "marketId":  session.market_id,
        "vote":      attestation.vote,
        "storachaCid": agent_state.storacha_cid or "",
    })

    if attest_result and attest_result.get("txHash"):
        await session._emit_log(
            "attestation → Calibration testnet",
            agent=agent_state.name,
            tx_hash=attest_result["txHash"],
        )

    # ── SUBMITTED ───────────────────────────────────────────────────────────────
    agent_state.status     = "submitted"
    agent_state.attested_at = int(time.time() * 1000)
    await _emit_agent_and_log(session, agent_state, "attestation submitted")

    # Update vote counts and check quorum
    session.yes_votes = sum(1 for a in session.agents if a.vote is True)
    session.no_votes  = sum(1 for a in session.agents if a.vote is False)

    if session.phase == "collecting" and (session.yes_votes >= 5 or session.no_votes >= 5):
        await _finalize(session)


async def _emit_agent_and_log(session: ResolutionSession, agent: AgentState, message: str):
    await session._emit_agent(agent)
    await session._emit_log(message, agent=agent.name)


# ── Finalization ───────────────────────────────────────────────────────────────

async def _finalize(session: ResolutionSession):
    if session.phase != "collecting":
        return
    session.phase   = "quorum_reached"
    session.outcome = session.yes_votes >= 5

    outcome_str = "YES" if session.outcome else "NO"
    await session._emit_log(
        f"QUORUM REACHED {session.yes_votes}/7 — outcome: {outcome_str}"
    )
    await session._broadcast({
        "type":     "quorum_reached",
        "marketId": session.market_id,
        "payload": {
            "yesVotes": session.yes_votes,
            "noVotes":  session.no_votes,
            "outcome":  session.outcome,
        },
    })

    # Upload finalized evidence bundle to Filecoin via Synapse SDK
    session.phase = "uploading"
    await session._emit_log("uploading finalized evidence bundle to Filecoin via Synapse SDK...")

    bundle_result = await _call_oracle_service("/oracle/synapse/upload-bundle", {
        "marketId":  session.market_id,
        "outcome":   session.outcome,
        "yesVotes":  session.yes_votes,
        "noVotes":   session.no_votes,
        "agents": [{
            "id":          a.id,
            "name":        a.name,
            "vote":        a.vote,
            "storachaCid": a.storacha_cid,
            "reasoning":   a.reasoning,
        } for a in session.agents if a.vote is not None],
    })

    if bundle_result and bundle_result.get("pieceCid"):
        session.final_evidence_cid = bundle_result["pieceCid"]
        session.calibration_tx     = bundle_result.get("calibrationTx")
        await session._emit_log(
            f"evidence bundle → Filecoin Piece CID: {session.final_evidence_cid}",
            cid=session.final_evidence_cid,
        )
        if session.calibration_tx:
            await session._emit_log(
                f"OracleAgentRegistry updated → Calibration tx: {session.calibration_tx[:20]}...",
                tx_hash=session.calibration_tx,
            )

    # Upload reputation snapshots + post ERC-8004 feedback
    await session._emit_log("uploading reputation snapshots to Filecoin + updating ERC-8004...")
    rep_result = await _call_oracle_service("/oracle/reputation/update", {
        "marketId": session.market_id,
        "outcome":  session.outcome,
        "agents": [{
            "id":         a.id,
            "name":       a.name,
            "vote":       a.vote,
            "reputation": a.reputation,
            "erc8004Id":  a.erc8004_id,
        } for a in session.agents if a.vote is not None],
        "evidenceCid": session.final_evidence_cid or "",
    })

    if rep_result and rep_result.get("updates"):
        for update in rep_result["updates"]:
            agent = next((a for a in session.agents if a.id == update["agentId"]), None)
            if agent:
                agent.reputation = update["newScore"]
                await session._emit_agent(agent)

    # Finalize
    session.phase       = "finalized"
    session.finalized_at = int(time.time() * 1000)
    await session._emit_log(
        "market FINALIZED — settlement delivery to Flow pending (Phase 6)"
    )
    await session._broadcast({
        "type":     "finalized",
        "marketId": session.market_id,
        "payload": {
            "outcome":         session.outcome,
            "finalEvidenceCid": session.final_evidence_cid,
            "calibrationTx":   session.calibration_tx,
        },
    })


# ── Public entry point ─────────────────────────────────────────────────────────

async def run_resolution(session: ResolutionSession):
    """
    Start the resolution for a session. Runs all 7 agent tasks concurrently.
    Call this in a background task after creating and storing the session.
    """
    session.phase = "collecting"

    # Restore agent reputation from Storacha checkpoints (Track 1 — Persistent Memory).
    # The oracle service loads checkpoints on startup; we query it here so the
    # Python layer reflects the same restored state.
    base_agents = []
    for a in AGENTS:
        checkpoint = await _call_oracle_service(f"/oracle/storacha/checkpoint/{a.id}")
        rep = 80
        if checkpoint and checkpoint.get("source") == "storacha-checkpoint":
            rep = checkpoint.get("reputationScore", 80)
            # Only log "resumed" for agents that actually have a checkpoint
            await session._emit_log(
                f"{a.name} resumed from Storacha checkpoint (reputation: {rep})",
                agent=a.name,
            )
        base_agents.append(AgentState(id=a.id, name=a.name, source=a.source, reputation=rep))

    session.agents = base_agents

    await session._emit_log(
        f'resolution started for market {session.market_id} — 7 agents initializing'
    )
    await session._broadcast({
        "type": "session_init", "marketId": session.market_id, "payload": session.to_dict()
    })

    await asyncio.gather(
        *[_run_agent_task(session, agent) for agent in session.agents],
        return_exceptions=True,
    )

    if session.phase == "collecting":
        session.phase = "failed"
        await session._emit_log("resolution failed — quorum not reached within timeout")
