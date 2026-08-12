// ─── Graph build pipeline ───────────────────────────────────────────────────
//
// seed ground truth → extract over un-extracted chunks → resolve names to
// entities → write edges with provenance → garbage-collect orphans.

import { eq, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { chunks } from '../schema.js';
import { mapWithConcurrency } from '../concurrency.js';
import {
  entities,
  edges,
  edgeChunks,
  chunkEntities,
  chunkExtractions,
} from './schema.js';
import { entityKey } from './vocab.js';
import {
  extractFromChunk,
  PROMPT_VERSION,
  type ChunkExtraction,
} from './extract.js';
import { resolveEntities, type EntityCandidate } from './resolve.js';
import { seedTypeChart } from './seed.js';
import { logger } from '@app/shared';

const log = logger.child({ module: 'graph:build' });

/** Extraction calls in flight at once. */
const EXTRACT_CONCURRENCY = 4;

export interface BuildGraphOptions {
  /** Re-extract every chunk even if the ledger says it's current. */
  force?: boolean;
  /** Override the extraction model. */
  model?: string;
  /** Skip the type-chart seed (it's idempotent; mostly useful in tests). */
  skipSeed?: boolean;
}

export interface BuildGraphResult {
  chunksTotal: number;
  chunksExtracted: number;
  chunksSkipped: number;
  chunksFailed: number;
  entitiesResolved: {
    exact: number;
    alias: number;
    embedding: number;
    created: number;
  };
  edgesWritten: number;
  mentionsWritten: number;
  orphanEdgesDropped: number;
  orphanEntitiesDropped: number;
}

export async function buildGraph(
  opts: BuildGraphOptions = {},
): Promise<BuildGraphResult> {
  if (!opts.skipSeed) {
    await seedTypeChart();
  }

  // ── Which chunks need extraction? ───────────────────────────────────
  // The ledger is what makes "zero LLM calls on an unchanged corpus" true —
  // without it, a chunk that legitimately yields no entities is re-extracted
  // forever because there's nothing to show it was ever visited.
  const allChunks = await db
    .select({ id: chunks.id, text: chunks.text })
    .from(chunks);

  const ledger = await db
    .select({
      chunkId: chunkExtractions.chunkId,
      promptVersion: chunkExtractions.promptVersion,
    })
    .from(chunkExtractions);

  const currentVersion = new Set(
    ledger
      .filter((r) => r.promptVersion === PROMPT_VERSION)
      .map((r) => r.chunkId),
  );

  const todo = opts.force
    ? allChunks
    : allChunks.filter((c) => !currentVersion.has(c.id));

  log.info(
    {
      total: allChunks.length,
      toExtract: todo.length,
      skipped: allChunks.length - todo.length,
      promptVersion: PROMPT_VERSION,
    },
    'Starting graph build',
  );

  const result: BuildGraphResult = {
    chunksTotal: allChunks.length,
    chunksExtracted: 0,
    chunksSkipped: allChunks.length - todo.length,
    chunksFailed: 0,
    entitiesResolved: { exact: 0, alias: 0, embedding: 0, created: 0 },
    edgesWritten: 0,
    mentionsWritten: 0,
    orphanEdgesDropped: 0,
    orphanEntitiesDropped: 0,
  };

  if (todo.length > 0) {
    // ── Extract ───────────────────────────────────────────────────────
    let done = 0;
    const extractions = await mapWithConcurrency(
      todo,
      EXTRACT_CONCURRENCY,
      async (chunk) => {
        const out = await extractFromChunk(chunk.id, chunk.text, {
          ...(opts.model ? { model: opts.model } : {}),
        });
        done++;
        log.info(
          { progress: `${done}/${todo.length}`, chunkId: chunk.id },
          out
            ? `✓ extracted ${out.entities.length} entities, ${out.relations.length} relations`
            : '✗ extraction failed',
        );
        return out;
      },
    );

    const successful = extractions.filter(
      (e): e is ChunkExtraction => e !== null,
    );
    result.chunksExtracted = successful.length;
    result.chunksFailed = extractions.length - successful.length;

    // ── Resolve every name across the whole batch at once ─────────────
    const candidates: EntityCandidate[] = [];
    for (const ex of successful) {
      for (const e of ex.entities) {
        candidates.push({ name: e.name, type: e.type, aliases: e.aliases });
      }
      // Relation endpoints are guaranteed to be declared entities by
      // extract.ts's cleaning pass, so they need no separate collection.
    }

    const { idByKey, stats } = await resolveEntities(candidates);
    result.entitiesResolved = stats;

    // ── Write mentions, edges, provenance, ledger ─────────────────────
    for (const ex of successful) {
      const written = await writeExtraction(ex, idByKey);
      result.mentionsWritten += written.mentions;
      result.edgesWritten += written.edges;
    }
  }

  // ── Garbage collection ──────────────────────────────────────────────
  const gc = await collectOrphans();
  result.orphanEdgesDropped = gc.edgesDropped;
  result.orphanEntitiesDropped = gc.entitiesDropped;

  log.info(result, 'Graph build complete');
  return result;
}

// ─── Writing one chunk's extraction ─────────────────────────────────────────

async function writeExtraction(
  extraction: ChunkExtraction,
  idByKey: Map<string, string>,
): Promise<{ mentions: number; edges: number }> {
  const { chunkId } = extraction;

  const mentionRows = extraction.entities
    .map((e) => idByKey.get(entityKey(e.type, e.name)))
    .filter((id): id is string => Boolean(id))
    .map((entityId) => ({ chunkId, entityId, mentions: 1 }));

  // Dedupe: the composite PK rejects a batch containing the same pair twice.
  const uniqueMentions = [
    ...new Map(mentionRows.map((r) => [r.entityId, r])).values(),
  ];

  let edgesWritten = 0;

  await db.transaction(async (tx) => {
    // Re-extraction replaces this chunk's contribution rather than adding to
    // it, so a corrected passage doesn't leave its old claims behind.
    await tx.delete(chunkEntities).where(eq(chunkEntities.chunkId, chunkId));
    await tx.delete(edgeChunks).where(eq(edgeChunks.chunkId, chunkId));

    if (uniqueMentions.length > 0) {
      await tx.insert(chunkEntities).values(uniqueMentions).onConflictDoNothing();
    }

    for (const rel of extraction.relations) {
      const sourceId = idByKey.get(entityKey(rel.sourceType, rel.sourceName));
      const targetId = idByKey.get(entityKey(rel.targetType, rel.targetName));
      if (!sourceId || !targetId || sourceId === targetId) continue;

      // Ground truth is never overwritten by an extraction. The WHERE on the
      // upsert is what enforces "seed wins" at the database level rather than
      // relying on ordering.
      const [edge] = await tx
        .insert(edges)
        .values({
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          relation: rel.relation,
          properties: rel.properties,
          confidence: rel.confidence,
          origin: 'llm',
        })
        .onConflictDoUpdate({
          target: [edges.sourceEntityId, edges.relation, edges.targetEntityId],
          set: {
            confidence: sql`greatest(${edges.confidence}, excluded.confidence)`,
            properties: sql`${edges.properties} || excluded.properties`,
          },
          setWhere: sql`${edges.origin} <> 'seed'`,
        })
        .returning({ id: edges.id });

      // No row returned means the conflict target was a seed edge and the
      // setWhere suppressed the update — look it up so provenance still lands.
      const edgeId = edge?.id ?? (await findEdgeId(tx, sourceId, targetId, rel.relation));
      if (!edgeId) continue;

      await tx
        .insert(edgeChunks)
        .values({ edgeId, chunkId })
        .onConflictDoNothing();
      edgesWritten++;
    }

    await tx
      .insert(chunkExtractions)
      .values({
        chunkId,
        promptVersion: PROMPT_VERSION,
        entityCount: uniqueMentions.length,
        relationCount: extraction.relations.length,
      })
      .onConflictDoUpdate({
        target: chunkExtractions.chunkId,
        set: {
          promptVersion: PROMPT_VERSION,
          entityCount: uniqueMentions.length,
          relationCount: extraction.relations.length,
          extractedAt: new Date(),
        },
      });
  });

  return { mentions: uniqueMentions.length, edges: edgesWritten };
}

// ─── Garbage collection ─────────────────────────────────────────────────────

export interface GcResult {
  edgesDropped: number;
  entitiesDropped: number;
}

/**
 * Re-ingesting a changed document cascades its chunks away, which takes
 * chunk_entities and edge_chunks with them — but leaves the entities and edges
 * they pointed at floating. Without this pass the graph accumulates claims
 * whose source text no longer exists.
 *
 * Seed edges are exempt: they have no chunk provenance by design.
 */
export async function collectOrphans(): Promise<GcResult> {
  const droppedEdges = await db.execute<{ id: string }>(sql`
    DELETE FROM edges e
    WHERE e.origin <> 'seed'
      AND NOT EXISTS (SELECT 1 FROM edge_chunks ec WHERE ec.edge_id = e.id)
    RETURNING e.id
  `);

  const droppedEntities = await db.execute<{ id: string }>(sql`
    DELETE FROM entities en
    WHERE NOT EXISTS (
            SELECT 1 FROM chunk_entities ce WHERE ce.entity_id = en.id
          )
      AND NOT EXISTS (
            SELECT 1 FROM edges e
            WHERE e.source_entity_id = en.id OR e.target_entity_id = en.id
          )
    RETURNING en.id
  `);

  return {
    edgesDropped: [...droppedEdges].length,
    entitiesDropped: [...droppedEntities].length,
  };
}

// ─── Small helpers ──────────────────────────────────────────────────────────

async function findEdgeId(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  sourceId: string,
  targetId: string,
  relation: string,
): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id FROM edges
    WHERE source_entity_id = ${sourceId}::uuid
      AND target_entity_id = ${targetId}::uuid
      AND relation = ${relation}
    LIMIT 1
  `);
  return [...rows][0]?.id ?? null;
}
