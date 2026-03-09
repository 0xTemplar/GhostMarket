from typing import List

from fastapi import APIRouter

from api.data import MOCK_POSITIONS
from api.models import Position

router = APIRouter()


@router.get("", response_model=List[Position])
def list_positions():
    """List positions for the current user (mocked; will be scoped by session later)."""
    return MOCK_POSITIONS
