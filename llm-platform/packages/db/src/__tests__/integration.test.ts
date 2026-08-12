// ─── Integration test: ingest → search round-trip ───────────────────────────
// Requires: running Postgres (docker compose up) + valid API key for embeddings.
// Run with: pnpm test:integration  (uses vitest.integration.config.ts)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, closeDb } from '../client.js';
import { documents, chunks } from '../schema.js';
import { ingestFile } from '../ingest.js';
import { semanticSearch } from '../search.js';
import { eq } from 'drizzle-orm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../seed');

describe('ingest → search integration', () => {
  // Use a single well-known file as the test fixture
  const fixtureFile = path.join(FIXTURE_DIR, 'mewtwo-and-mew.md');

  async function removeFixtureDocuments() {
    const existing = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.sourceUri, path.resolve(fixtureFile)));

    for (const doc of existing) {
      await db.delete(chunks).where(eq(chunks.documentId, doc.id));
      await db.delete(documents).where(eq(documents.id, doc.id));
    }
  }

  beforeAll(removeFixtureDocuments);

  afterAll(async () => {
    // Also clean up on the way out. `sourceUri` is an absolute path, so when
    // the corpus was ingested from a different checkout location this test's
    // ingest adds a *duplicate* document rather than matching the existing one
    // — and leaving it behind pollutes retrieval for everything downstream.
    await removeFixtureDocuments();
    await closeDb();
  });

  it('ingests a file and creates chunks with embeddings', async () => {
    const result = await ingestFile(fixtureFile);

    expect(result.skipped).toBe(false);
    expect(result.chunksCreated).toBeGreaterThan(0);
    expect(result.title).toContain('Mewtwo');

    // Verify chunks exist in the database
    const dbChunks = await db
      .select()
      .from(chunks)
      .innerJoin(documents, eq(chunks.documentId, documents.id))
      .where(eq(documents.sourceUri, path.resolve(fixtureFile)));

    expect(dbChunks.length).toBe(result.chunksCreated);

    // Each chunk should have a 1536-dim embedding
    for (const row of dbChunks) {
      expect(row.chunks.embedding).toHaveLength(1536);
    }
  });

  it('skips re-ingestion of unchanged file (idempotency)', async () => {
    const result = await ingestFile(fixtureFile);

    expect(result.skipped).toBe(true);
    expect(result.chunksCreated).toBe(0);
  });

  it('returns the expected chunk for a semantic query', async () => {
    // Query about genetic engineering — should match Mewtwo content
    // Note: uses different wording than the source text
    const results = await semanticSearch(
      'which pokemon was artificially created through genetic engineering in a laboratory?',
      5,
    );

    expect(results.length).toBeGreaterThan(0);

    // The top result should be from the Mewtwo document
    const topResult = results[0]!;
    expect(topResult.documentTitle).toContain('Mewtwo');
    expect(topResult.similarity).toBeGreaterThan(0.5);
  });

  it('returns identical ordering for the same query (determinism)', async () => {
    const query = 'tell me about the clone pokemon';

    const results1 = await semanticSearch(query, 5);
    const results2 = await semanticSearch(query, 5);

    expect(results1.length).toBe(results2.length);
    for (let i = 0; i < results1.length; i++) {
      expect(results1[i]!.chunkId).toBe(results2[i]!.chunkId);
      expect(results1[i]!.similarity).toBeCloseTo(results2[i]!.similarity, 6);
    }
  });
});
