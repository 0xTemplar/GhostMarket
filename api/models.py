"""Shared Pydantic models for GhostMarket API."""
from datetime import datetime
from enum import Enum

from pydantic import BaseModel


class MarketStatus(str, Enum):
    active = "active"
    resolved = "resolved"
    disputed = "disputed"
    pending = "pending"


class Market(BaseModel):
    id: str
    title: str
    description: str
    category: str
    resolution_source: str
    expiry_at: str
    status: MarketStatus
    yes_price: float
    no_price: float
    volume: float
    liquidity: float
    created_at: str


class PositionSide(str, Enum):
    YES = "YES"
    NO = "NO"


class Position(BaseModel):
    id: str
    market_id: str
    market_title: str
    side: PositionSide
    size: float
    avg_price: float
    current_value: float
    status: MarketStatus
    expiry_at: str
