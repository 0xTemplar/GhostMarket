from typing import List, Optional

from fastapi import APIRouter, HTTPException

from api.data import MOCK_MARKETS
from api.models import Market

router = APIRouter()


@router.get("", response_model=List[Market])
def list_markets(status: Optional[str] = None):
    """List markets, optionally filtered by status."""
    out = MOCK_MARKETS
    if status:
        out = [m for m in out if m.status.value == status]
    return out


@router.get("/{market_id}", response_model=Market)
def get_market(market_id: str):
    """Get a single market by id."""
    for m in MOCK_MARKETS:
        if m.id == market_id:
            return m
    raise HTTPException(status_code=404, detail="Market not found")
