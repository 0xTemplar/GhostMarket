/**
 * server.ts — Cadence Adapter HTTP microservice.
 *
 * Exposes a single POST /schedule endpoint that the oracle calls fire-and-forget
 * after quorum to schedule a Cadence delivery on Flow Testnet.
 *
 * Port: 8093 (configurable via CADENCE_ADAPTER_PORT)
 *
 * Endpoints:
 *   GET  /health              — liveness check
 *   POST /schedule            — schedule a GhostVault outcome delivery
 *     body: { marketId: string, outcome: boolean }
 *     response: ScheduleResult { status, txId, message }
 */

import express       from 'express';
import cors          from 'cors';
import dotenv        from 'dotenv';
import { scheduleVaultDelivery } from './scheduler';

dotenv.config();

const app  = express();
const PORT = Number(process.env.CADENCE_ADAPTER_PORT ?? 8093);

app.use(cors());
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:  'ok',
    service: 'ghost-cadence-adapter',
    configured: !!(
      process.env.CADENCE_ACCOUNT_ADDRESS &&
      process.env.CADENCE_PRIVATE_KEY     &&
      process.env.CADENCE_HANDLER_CONTRACT_ADDRESS
    ),
  });
});

// ── Schedule ──────────────────────────────────────────────────────────────────

app.post('/schedule', async (req, res) => {
  const { marketId, outcome } = req.body as { marketId?: string; outcome?: boolean };

  if (!marketId || outcome === undefined) {
    res.status(400).json({ error: 'marketId (string) and outcome (boolean) are required' });
    return;
  }

  console.log(`[CadenceAdapter] Schedule request — market ${marketId}, outcome=${outcome}`);

  const result = await scheduleVaultDelivery(marketId, outcome);

  const statusCode = result.status === 'failed' ? 500 : 200;
  res.status(statusCode).json(result);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n=== GhostMarket Cadence Adapter ===`);
  console.log(`HTTP  : http://localhost:${PORT}/health`);
  console.log(`POST  : http://localhost:${PORT}/schedule`);
  console.log(`\nConfigured: ${!!(process.env.CADENCE_ACCOUNT_ADDRESS && process.env.CADENCE_PRIVATE_KEY)}`);
  console.log(`Adapter ready.\n`);
});
