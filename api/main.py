"""
GhostMarket API — orchestration, policy checks, relayer coordination.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routers import markets, portfolio, auth, relayer
from api.routers import oracle

app = FastAPI(
    title="GhostMarket API",
    description="Confidential prediction markets — backend orchestration",
    version="0.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(markets.router,   prefix="/api/markets",   tags=["markets"])
app.include_router(portfolio.router, prefix="/api/portfolio", tags=["portfolio"])
app.include_router(auth.router,      prefix="/api/auth",      tags=["auth"])
app.include_router(relayer.router,   prefix="/api/relayer",   tags=["relayer"])
app.include_router(oracle.router,    prefix="/api/oracle",    tags=["oracle"])


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "ghost-market-api"}
