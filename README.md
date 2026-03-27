# GhostMarket

GhostMarket is a confidential prediction market that uses Fully Homomorphic Encryption to hide order intent, position size, and balances during execution. Flow serves as the consumer layer for walletless onboarding, collateral custody, and scheduled market resolution via Cadence. Zama powers the encrypted eAMM engine, implementing 8 distinct FHE primitives—notably combining FHE.gt and FHE.select to enforce minimum-bet guards homomorphically without ever leaking plaintext amounts. Lit Protocol executes cross-chain TEE settlement without relying on a vulnerable token bridge. Finally, Filecoin and Storacha provide verifiable oracle memory, with ERC-8004 creating the portable identity trail every agent leaves behind.

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

https://testnet.flowscan.io/contract/A.59403984ca469d1c.GhostVaultResolverHandler
