// ─── knowledge service — HTTP layer (Pattern 2: LLM service) ─────────────────
// Exposes POST /ask → grounded, cited answer over the RAG pipeline.
// Usage: pnpm --filter @app/knowledge dev   (or `pnpm knowledge` from root)

import './load-env.js';
import './zod-jitless.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '@app/shared';
import { closeDb } from '@app/db';
import { ask } from './pipeline.js';

const log = logger.child({ module: 'knowledge-server' });
const app = new Hono();

const AskRequest = z.object({
  q: z.string().min(1, 'q must be a non-empty string').max(2000),
});

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/ask', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = AskRequest.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      400,
    );
  }

  try {
    const result = await ask(parsed.data.q);
    return c.json(result);
  } catch (err) {
    log.error({ err }, 'ask failed');
    return c.json({ error: 'Internal error' }, 500);
  }
});

const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port }, (info) => {
  log.info(`knowledge service listening on http://localhost:${info.port}`);
  log.info('Try: curl -s localhost:%d/ask -H "content-type: application/json" -d \'{"q":"how was Mewtwo created?"}\'', info.port);
});

// Graceful shutdown so the DB pool closes cleanly.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    log.info(`${signal} received — shutting down`);
    await closeDb();
    process.exit(0);
  });
}
