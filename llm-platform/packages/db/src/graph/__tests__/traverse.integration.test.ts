// ─── Traversal integration test ─────────────────────────────────────────────
// Requires a live database (pnpm db:migrate first). No LLM calls: the graph is
// hand-built so hop counts are exactly predictable.
//
// Run with: pnpm test:integration

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, closeDb } from '../../client.js';
import { documents, chunks, EMBEDDING_DIMENSIONS } from '../../schema.js';
import { entities, edges, edgeChunks, chunkEntities } from '../schema.js';
import { graphExpand, graphSearch } from '../traverse.js';
import { graphFacts } from '../facts.js';
import { collectOrphans } from '../build.js';

// Namespaced so the fixtures can never collide with, or be mistaken for, real
// corpus data — and so cleanup can find them unambiguously.
const NS = 'ZZTestGraph';
const SOURCE_URI = `memory://${NS}`;

// pgvector needs a real vector; nothing here does similarity search, so a
// fixed unit vector is enough. An all-zero vector would make cosine distance
// undefined.
function stubEmbedding(seed: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[seed % EMBEDDING_DIMENSIONS] = 1;
  return v;
}

/** A -> B -> C -> D, one chunk per node. */
const NODE_NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((n) => `${NS}${n}`);

let documentId: string;
let chunkIds: string[] = [];
let entityIds: string[] = [];

/** chunkIds[i] mentions entityIds[i]. */
const idx = (name: string) => NODE_NAMES.indexOf(`${NS}${name}`);

beforeAll(async () => {
  await cleanup();

  const [doc] = await db
    .insert(documents)
    .values({
      sourceUri: SOURCE_URI,
      title: `${NS} fixture`,
      contentHash: 'fixture',
    })
    .returning({ id: documents.id });
  documentId = doc!.id;

  const chunkRows = await db
    .insert(chunks)
    .values(
      NODE_NAMES.map((name, i) => ({
        documentId,
        ordinal: i,
        text: `Fixture chunk about ${name}.`,
        embedding: stubEmbedding(i),
      })),
    )
    .returning({ id: chunks.id });
  chunkIds = chunkRows.map((r) => r.id);

  const entityRows = await db
    .insert(entities)
    .values(
      NODE_NAMES.map((name) => ({
        canonicalName: name,
        normalizedName: name.toLowerCase(),
        type: 'pokemon' as const,
      })),
    )
    .returning({ id: entities.id });
  entityIds = entityRows.map((r) => r.id);

  await db.insert(chunkEntities).values(
    entityIds.map((entityId, i) => ({
      chunkId: chunkIds[i]!,
      entityId,
      mentions: 1,
    })),
  );

  // A -> B -> C -> D. Stored in one direction only; traversal walks both.
  const edgeRows = await db
    .insert(edges)
    .values([
      {
        sourceEntityId: entityIds[0]!,
        targetEntityId: entityIds[1]!,
        relation: 'evolves_into' as const,
        properties: { method: 'Test Stone' },
        confidence: 1,
        origin: 'llm' as const,
      },
      {
        sourceEntityId: entityIds[1]!,
        targetEntityId: entityIds[2]!,
        relation: 'evolves_into' as const,
        confidence: 1,
        origin: 'llm' as const,
      },
      {
        sourceEntityId: entityIds[2]!,
        targetEntityId: entityIds[3]!,
        relation: 'evolves_into' as const,
        confidence: 1,
        origin: 'llm' as const,
      },
    ])
    .returning({ id: edges.id });

  // Provenance, so these edges survive the GC pass.
  await db.insert(edgeChunks).values(
    edgeRows.map((e, i) => ({ edgeId: e.id, chunkId: chunkIds[i]! })),
  );
});

afterAll(async () => {
  await cleanup();
  await closeDb();
});

async function cleanup() {
  // Entities cascade to edges, aliases, chunk_entities and edge_chunks.
  const existing = await db
    .select({ id: entities.id })
    .from(entities)
    .where(inArray(entities.canonicalName, NODE_NAMES));
  if (existing.length > 0) {
    await db.delete(entities).where(
      inArray(
        entities.id,
        existing.map((e) => e.id),
      ),
    );
  }

  // Documents cascade to chunks.
  await db.delete(documents).where(eq(documents.sourceUri, SOURCE_URI));
}

describe('graphExpand', () => {
  it('with maxHops 0 returns only the seed entity and its chunk', async () => {
    const result = await graphExpand([chunkIds[0]!], { maxHops: 0 });

    expect(result.entities.map((e) => e.canonicalName)).toEqual([
      NODE_NAMES[0],
    ]);
    expect(result.chunks.map((c) => c.chunkId)).toEqual([chunkIds[0]]);
    expect(result.chunks[0]!.isSeed).toBe(true);
  });

  it('walks one hop to the direct neighbour', async () => {
    const result = await graphExpand([chunkIds[0]!], { maxHops: 1 });

    const names = result.entities.map((e) => e.canonicalName).sort();
    expect(names).toEqual([NODE_NAMES[0], NODE_NAMES[1]].sort());

    const hopByName = new Map(
      result.entities.map((e) => [e.canonicalName, e.hops]),
    );
    expect(hopByName.get(NODE_NAMES[0]!)).toBe(0);
    expect(hopByName.get(NODE_NAMES[1]!)).toBe(1);
  });

  it('reaches a two-hop neighbour — the multi-hop case vector search misses', async () => {
    const result = await graphExpand([chunkIds[0]!], { maxHops: 2 });

    const hopByName = new Map(
      result.entities.map((e) => [e.canonicalName, e.hops]),
    );
    expect(hopByName.get(NODE_NAMES[2]!)).toBe(2);
    expect(hopByName.has(NODE_NAMES[3]!)).toBe(false); // 3 hops away

    // Gamma's chunk is now a candidate even though nothing about it resembles
    // the seed chunk.
    expect(result.chunks.map((c) => c.chunkId)).toContain(chunkIds[2]);
  });

  it('traverses edges backwards — edges are stored one direction only', async () => {
    // Seed from Delta and walk back up the chain to Beta.
    const result = await graphExpand([chunkIds[3]!], { maxHops: 2 });

    const hopByName = new Map(
      result.entities.map((e) => [e.canonicalName, e.hops]),
    );
    expect(hopByName.get(NODE_NAMES[2]!)).toBe(1);
    expect(hopByName.get(NODE_NAMES[1]!)).toBe(2);
  });

  it('terminates on a cycle', async () => {
    // Close the loop: Delta -> Alpha.
    const [cycleEdge] = await db
      .insert(edges)
      .values({
        sourceEntityId: entityIds[3]!,
        targetEntityId: entityIds[0]!,
        relation: 'evolves_into' as const,
        confidence: 1,
        origin: 'llm' as const,
      })
      .returning({ id: edges.id });

    try {
      const result = await graphExpand([chunkIds[0]!], { maxHops: 3 });

      // Every node is reachable now, and each appears exactly once at its
      // shortest distance rather than repeating around the loop.
      expect(result.entities).toHaveLength(4);
      const hopByName = new Map(
        result.entities.map((e) => [e.canonicalName, e.hops]),
      );
      expect(hopByName.get(NODE_NAMES[0]!)).toBe(0);
      expect(hopByName.get(NODE_NAMES[3]!)).toBe(1); // via the new back-edge
    } finally {
      await db.delete(edges).where(eq(edges.id, cycleEdge!.id));
    }
  });

  it('respects maxNodes', async () => {
    const result = await graphExpand([chunkIds[0]!], {
      maxHops: 3,
      maxNodes: 2,
    });
    expect(result.entities).toHaveLength(2);
  });

  it('honours a relation filter', async () => {
    const result = await graphExpand([chunkIds[0]!], {
      maxHops: 2,
      relations: ['has_type'], // no fixture edge uses this
    });
    expect(result.entities.map((e) => e.canonicalName)).toEqual([
      NODE_NAMES[0],
    ]);
  });

  it('returns nothing for an empty seed set', async () => {
    const result = await graphExpand([], { maxHops: 2 });
    expect(result.entities).toHaveLength(0);
    expect(result.chunks).toHaveLength(0);
  });
});

describe('graphSearch', () => {
  it('excludes seed chunks by default, so the arm only contributes new candidates', async () => {
    const ids = await graphSearch([chunkIds[0]!], { maxHops: 2 });

    expect(ids).not.toContain(chunkIds[0]);
    expect(ids).toContain(chunkIds[1]);
    expect(ids).toContain(chunkIds[2]);
  });

  it('includes seeds when asked', async () => {
    const ids = await graphSearch([chunkIds[0]!], {
      maxHops: 1,
      includeSeeds: true,
    });
    expect(ids).toContain(chunkIds[0]);
  });

  it('ranks nearer chunks first', async () => {
    const ids = await graphSearch([chunkIds[0]!], { maxHops: 2 });
    expect(ids.indexOf(chunkIds[1]!)).toBeLessThan(ids.indexOf(chunkIds[2]!));
  });
});

describe('graphFacts', () => {
  it('renders edges among the given entities with their provenance', async () => {
    const facts = await graphFacts(entityIds, { requireBothEndpoints: true });

    const line = facts.find((f) => f.sourceName === NODE_NAMES[0]);
    expect(line).toBeDefined();
    expect(line!.line).toContain(
      `${NODE_NAMES[0]} --evolves_into(Test Stone)--> ${NODE_NAMES[1]}`,
    );
    expect(line!.chunkIds).toContain(chunkIds[0]);
    expect(line!.line).toContain(`chunk:${chunkIds[0]!.slice(0, 8)}`);
  });

  it('returns nothing for an empty entity set', async () => {
    expect(await graphFacts([])).toEqual([]);
  });
});

describe('collectOrphans', () => {
  it('drops an LLM edge with no chunk provenance but keeps seeded ground truth', async () => {
    const [orphan] = await db
      .insert(edges)
      .values({
        sourceEntityId: entityIds[0]!,
        targetEntityId: entityIds[2]!,
        relation: 'regional_variant_of' as const,
        confidence: 0.9,
        origin: 'llm' as const,
      })
      .returning({ id: edges.id });

    // A seed edge also has no provenance — by design, it's an axiom, not a
    // claim made by the corpus. GC must not touch it.
    const [seeded] = await db
      .insert(edges)
      .values({
        sourceEntityId: entityIds[1]!,
        targetEntityId: entityIds[3]!,
        relation: 'regional_variant_of' as const,
        confidence: 1,
        origin: 'seed' as const,
      })
      .returning({ id: edges.id });

    await collectOrphans();

    const remaining = await db
      .select({ id: edges.id })
      .from(edges)
      .where(inArray(edges.id, [orphan!.id, seeded!.id]));

    expect(remaining.map((r) => r.id)).toEqual([seeded!.id]);

    await db.delete(edges).where(eq(edges.id, seeded!.id));
  });

  it('drops an entity with no mentions and no edges', async () => {
    const [floating] = await db
      .insert(entities)
      .values({
        canonicalName: `${NS}Floating`,
        normalizedName: `${NS.toLowerCase()}floating`,
        type: 'pokemon' as const,
      })
      .returning({ id: entities.id });

    await collectOrphans();

    const found = await db
      .select({ id: entities.id })
      .from(entities)
      .where(eq(entities.id, floating!.id));
    expect(found).toHaveLength(0);
  });

  it('keeps an entity that is still mentioned by a chunk', async () => {
    await collectOrphans();

    const survivors = await db
      .select({ id: entities.id })
      .from(entities)
      .where(inArray(entities.canonicalName, NODE_NAMES));
    expect(survivors).toHaveLength(NODE_NAMES.length);
  });
});

describe('cascade behaviour', () => {
  it('removing a chunk removes its mentions, leaving the entity for GC', async () => {
    const [extraChunk] = await db
      .insert(chunks)
      .values({
        documentId,
        ordinal: 99,
        text: 'Temporary chunk.',
        embedding: stubEmbedding(99),
      })
      .returning({ id: chunks.id });

    await db.insert(chunkEntities).values({
      chunkId: extraChunk!.id,
      entityId: entityIds[idx('Alpha')]!,
      mentions: 1,
    });

    await db.delete(chunks).where(eq(chunks.id, extraChunk!.id));

    const orphanedMentions = await db
      .select({ chunkId: chunkEntities.chunkId })
      .from(chunkEntities)
      .where(
        and(
          eq(chunkEntities.chunkId, extraChunk!.id),
          eq(chunkEntities.entityId, entityIds[idx('Alpha')]!),
        ),
      );

    expect(orphanedMentions).toHaveLength(0);
  });
});
