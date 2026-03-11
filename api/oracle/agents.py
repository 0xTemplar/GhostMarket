"""
Oracle agent definitions and LLM-powered reasoning.

Each agent has:
  - A name and personality that shapes its LLM system prompt
  - A primary data source it fetches from
  - An async reason() method that uses an LLM to decide YES or NO

If OPENAI_API_KEY is not set, agents fall back to a deterministic
heuristic based on the fetched data — so the oracle still works
without LLM creds, just less interesting.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from typing import Any
from pathlib import Path

import httpx
from dotenv import load_dotenv

# Load api/.env if present
load_dotenv(Path(__file__).parent.parent / ".env")

# ── Agent definitions ──────────────────────────────────────────────────────────

@dataclass
class AgentDefinition:
    id:          int
    name:        str
    source:      str
    personality: str   # used in LLM system prompt


AGENTS: list[AgentDefinition] = [
    AgentDefinition(
        id=1, name="Cipher", source="Binance",
        personality=(
            "You are Cipher, a data-driven oracle agent. "
            "You only trust top-tier centralised exchange feeds and on-chain data. "
            "You are precise, terse, and never speculate beyond the data."
        ),
    ),
    AgentDefinition(
        id=2, name="Specter", source="CoinGecko",
        personality=(
            "You are Specter, a cautious risk assessor. "
            "You aggregate market-wide data across hundreds of sources. "
            "You require strong consensus signals before voting YES. "
            "When in doubt, you vote NO."
        ),
    ),
    AgentDefinition(
        id=3, name="Wraith", source="Chainlink",
        personality=(
            "You are Wraith, speed-optimised and chain-native. "
            "You prioritise on-chain oracle feeds over off-chain price data. "
            "You fetch fast, reason fast, and commit early."
        ),
    ),
    AgentDefinition(
        id=4, name="Phantom", source="Coinbase",
        personality=(
            "You are Phantom, a contrarian thinker. "
            "You stress-test the consensus and actively probe edge cases. "
            "If the answer seems obvious, you look harder for reasons it might be wrong."
        ),
    ),
    AgentDefinition(
        id=5, name="Shade", source="Kraken",
        personality=(
            "You are Shade, a consensus-seeker. "
            "You cross-reference multiple signals and weight by reliability. "
            "You never attest until you are confident the data tells a clear story."
        ),
    ),
    AgentDefinition(
        id=6, name="Echo", source="OKX",
        personality=(
            "You are Echo, a volume-weighted aggregator. "
            "You synthesise data across sources and weight signals by 24h trading volume. "
            "High-volume confirmation trumps any single data point."
        ),
    ),
    AgentDefinition(
        id=7, name="Vex", source="Bybit",
        personality=(
            "You are Vex, an adversarial tester. "
            "You look for manipulation signals, stale data, and outlier discrepancies. "
            "You distrust any single source and flag suspicious readings before voting."
        ),
    ),
]

AGENT_BY_ID: dict[int, AgentDefinition] = {a.id: a for a in AGENTS}

# ── Attestation result ─────────────────────────────────────────────────────────

@dataclass
class Attestation:
    agent_id:    int
    agent_name:  str
    vote:        bool
    reasoning:   str
    data_hash:   str
    source:      str
    timestamp:   str
    signature:   str = ""   # filled in by registry-client after signing


# ── Data fetchers ──────────────────────────────────────────────────────────────

async def fetch_market_data(agent: AgentDefinition, market_question: str) -> dict[str, Any]:
    """
    Fetch real-world price/event data relevant to the market question.
    Each agent hits its assigned source; results are returned as a dict
    the LLM can reason over.
    """
    data: dict[str, Any] = {
        "source":   agent.source,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            if agent.source == "Binance":
                r = await client.get(
                    "https://api.binance.com/api/v3/ticker/price",
                    params={"symbol": "ETHUSDT"},
                )
                if r.status_code == 200:
                    data["eth_price_usd"] = float(r.json()["price"])

            elif agent.source == "CoinGecko":
                r = await client.get(
                    "https://api.coingecko.com/api/v3/simple/price",
                    params={"ids": "ethereum", "vs_currencies": "usd"},
                )
                if r.status_code == 200:
                    data["eth_price_usd"] = r.json()["ethereum"]["usd"]

            elif agent.source == "Coinbase":
                r = await client.get(
                    "https://api.coinbase.com/v2/prices/ETH-USD/spot"
                )
                if r.status_code == 200:
                    data["eth_price_usd"] = float(r.json()["data"]["amount"])

            elif agent.source == "Kraken":
                r = await client.get(
                    "https://api.kraken.com/0/public/Ticker",
                    params={"pair": "ETHUSD"},
                )
                if r.status_code == 200:
                    result = r.json()["result"]
                    pair_key = list(result.keys())[0]
                    data["eth_price_usd"] = float(result[pair_key]["c"][0])

            elif agent.source == "OKX":
                r = await client.get(
                    "https://www.okx.com/api/v5/market/ticker",
                    params={"instId": "ETH-USDT"},
                    headers={"User-Agent": "GhostMarket-Oracle/1.0"},
                )
                if r.status_code == 200:
                    d = r.json()
                    if d.get("data"):
                        data["eth_price_usd"] = float(d["data"][0]["last"])
                        data["volume_24h"] = float(d["data"][0].get("vol24h", 0))

            elif agent.source == "Bybit":
                r = await client.get(
                    "https://api.bybit.com/v5/market/tickers",
                    params={"category": "spot", "symbol": "ETHUSDT"},
                    headers={"User-Agent": "GhostMarket-Oracle/1.0"},
                )
                if r.status_code == 200:
                    d = r.json()
                    items = d.get("result", {}).get("list", [])
                    if items:
                        data["eth_price_usd"] = float(items[0]["lastPrice"])
                        data["volume_24h"] = float(items[0].get("volume24h", 0))

            elif agent.source == "Chainlink":
                # Use DeFiLlama which aggregates Chainlink + DEX data
                r = await client.get(
                    "https://coins.llama.fi/prices/current/coingecko:ethereum",
                )
                if r.status_code == 200:
                    coins = r.json().get("coins", {})
                    entry = coins.get("coingecko:ethereum", {})
                    if entry.get("price"):
                        data["eth_price_usd"] = float(entry["price"])
                        data["confidence"] = entry.get("confidence", 0)
                        data["note"] = "DeFiLlama aggregated (incl. Chainlink feeds)"

    except Exception as e:
        data["fetch_error"] = str(e)

    return data


# ── LLM reasoning ──────────────────────────────────────────────────────────────

async def reason_with_llm(
    agent: AgentDefinition,
    market_question: str,
    fetched_data: dict[str, Any],
    peer_evidence: list[dict[str, Any]] | None = None,
) -> tuple[bool, str]:
    """
    Ask the LLM to vote YES or NO on the market question, given the fetched data.
    Optionally includes peer_evidence — other agents' Storacha-retrieved attestations
    (used by Shade and Vex for cross-agent coordination).
    Returns (vote: bool, reasoning: str).

    Falls back to a deterministic heuristic if OPENAI_API_KEY is not set.
    """
    api_key = os.getenv("OPENAI_API_KEY")

    if not api_key:
        return _heuristic_vote(agent, market_question, fetched_data, peer_evidence)

    peer_section = ""
    if peer_evidence:
        peer_section = (
            f"\n\nPeer attestations you retrieved from Storacha "
            f"(other agents' evidence — use this to cross-check your analysis):\n"
            + "\n".join(
                f"  - {p['agentName']} ({p['source']}): voted {p['vote']} — \"{p['reasoning']}\""
                for p in peer_evidence
            )
        )

    user_message = (
        f"Market question: {market_question}\n\n"
        f"Data you fetched from {agent.source}:\n"
        f"{json.dumps(fetched_data, indent=2)}"
        f"{peer_section}\n\n"
        f"Based on this data, does the market resolve YES or NO?\n"
        f"Respond in JSON: {{\"vote\": \"YES\" or \"NO\", \"reasoning\": \"<1-2 sentences>\"}}"
    )

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model":       os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
                    "max_tokens":  150,
                    "temperature": 0.2,
                    "messages": [
                        {"role": "system", "content": agent.personality},
                        {"role": "user",   "content": user_message},
                    ],
                },
            )

        if r.status_code == 200:
            content = r.json()["choices"][0]["message"]["content"]
            # Parse the JSON response
            try:
                parsed    = json.loads(content)
                vote      = str(parsed.get("vote", "NO")).upper() == "YES"
                reasoning = str(parsed.get("reasoning", ""))
                return vote, reasoning
            except json.JSONDecodeError:
                # Model didn't return clean JSON — extract YES/NO from text
                vote = "YES" in content.upper()
                return vote, content[:200]

    except Exception as e:
        print(f"[{agent.name}] LLM call failed: {e} — falling back to heuristic")

    return _heuristic_vote(agent, market_question, fetched_data)


def _heuristic_vote(
    agent: AgentDefinition,
    market_question: str,
    fetched_data: dict[str, Any],
    peer_evidence: list[dict[str, Any]] | None = None,
) -> tuple[bool, str]:
    """
    Deterministic fallback when no LLM key is available.
    Uses the fetched price data and a simple threshold check.
    """
    question_lower = market_question.lower()
    price = fetched_data.get("eth_price_usd")

    if price is not None:
        # Extract a dollar threshold from the question e.g. "ETH > $4000 by March"
        import re
        match = re.search(r"\$([0-9,]+)", market_question)
        if match:
            threshold = float(match.group(1).replace(",", ""))
            vote      = price > threshold
            direction = "above" if vote else "below"
            return vote, (
                f"ETH price is ${price:,.0f} from {agent.source}, "
                f"which is {direction} the ${threshold:,.0f} threshold."
            )

        # Generic price-based heuristic
        vote = price > 2000
        return vote, f"ETH price ${price:,.0f} from {agent.source}."

    # No price data — use agent-specific bias
    biases = {
        "Cipher":  True,
        "Specter": False,   # cautious, defaults NO
        "Wraith":  True,
        "Phantom": False,   # contrarian, defaults NO
        "Shade":   True,
        "Echo":    True,
        "Vex":     False,   # adversarial, defaults NO
    }
    vote = biases.get(agent.name, True)
    return vote, f"Heuristic vote from {agent.name} (no price data available)."


# ── Full agent decision cycle ──────────────────────────────────────────────────

async def run_agent_decision(
    agent_id: int,
    market_question: str,
    market_id: int,
    peer_evidence: list[dict[str, Any]] | None = None,
) -> Attestation:
    """
    Full decision cycle for one agent:
      1. Fetch real-world data from assigned source
      2. Optionally read peer evidence from Storacha (Shade, Vex)
      3. Use LLM to reason about the outcome, incorporating peer data
      4. Return a signed Attestation
    """
    agent = AGENT_BY_ID[agent_id]

    data = await fetch_market_data(agent, market_question)
    vote, reasoning = await reason_with_llm(agent, market_question, data, peer_evidence)

    data_hash = hashlib.sha256(
        json.dumps(data, sort_keys=True).encode()
    ).hexdigest()

    return Attestation(
        agent_id=agent_id,
        agent_name=agent.name,
        vote=vote,
        reasoning=reasoning,
        data_hash=f"0x{data_hash}",
        source=agent.source,
        timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
