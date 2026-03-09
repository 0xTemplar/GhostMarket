# GhostMarket

Confidential dark-pool prediction markets with shielded execution. Phase 1: product skeleton (Next.js + FastAPI, mocked data).

## Quick start

### Frontend (Next.js)

```bash
cd web
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You can browse markets, open a market, open the bet slip, and view the portfolio (mocked).

### Backend (FastAPI)

```bash
cd /Users/ghostxd/Desktop/GhostMarket
python -m venv .venv
source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r api/requirements.txt
uvicorn api.main:app --reload
```

API: [http://localhost:8000](http://localhost:8000). Docs: [http://localhost:8000/docs](http://localhost:8000/docs).

- `GET /api/health` — health check
- `GET /api/markets` — list markets
- `GET /api/markets/{id}` — get market
- `GET /api/portfolio` — list positions (mocked)

## Phase 1 definition of done

- [x] Next.js app shell, homepage with market cards
- [x] Market detail page, bet slip UI
- [x] Portfolio page with mock positions
- [x] FastAPI backend skeleton with mock endpoints
- [x] User can browse markets, open a market, open bet slip, see mock portfolio

## Next phases (see implementation.md)

- Phase 2: Flow auth, vault, deposit/claim
- Phase 3: Market lifecycle, resolution, non-private flow
- Phase 4: FHE / confidential execution (eAMM, fhevmjs)
- Phase 5+: Oracle resolution, Storacha, Lit settlement, agent controls
