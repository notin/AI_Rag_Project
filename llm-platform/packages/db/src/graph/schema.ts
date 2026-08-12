// ─── Knowledge graph schema ─────────────────────────────────────────────────
//
// Nodes (`entities`), typed edges (`edges`), and — the load-bearing part —
// two bridge tables back to `chunks`. Every entity and every LLM-derived edge
// records which chunk asserted it, so a traversal always terminates in text you
// can cite rather than in naked triples the model has to be trusted to narrate.

import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
// NOTE: extensionless — drizzle-kit's schema loader requires these files as CJS
// and does not rewrite a `.js` specifier back to the `.ts` source.
import { vector } from '../column-types';
import { chunks, EMBEDDING_DIMENSIONS } from '../schema';
import type { EntityType, Relation } from './vocab';

/** Where an edge came from. Seed edges are ground truth and outrank LLM edges. */
export type EdgeOrigin = 'seed' | 'llm';

// ─── Entities (nodes) ───────────────────────────────────────────────────────

export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Display form, e.g. "Mr. Mime". */
    canonicalName: text('canonical_name').notNull(),
    /** Lookup key from normalizeName(). Stored, not computed, so it can index. */
    normalizedName: text('normalized_name').notNull(),
    type: text('type').$type<EntityType>().notNull(),
    summary: text('summary'),
    /** Embedding of "<name> (<type>)" — the last resort in the resolution cascade. */
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Identity is (normalized name, type) — "Fire" the type and "Fire" the move
    // are legitimately different nodes.
    uniqueIndex('entities_normalized_name_type_idx').on(
      table.normalizedName,
      table.type,
    ),
    index('entities_type_idx').on(table.type),
    index('entities_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
  ],
);

// ─── Aliases ────────────────────────────────────────────────────────────────
// A table rather than a text[] column so alias resolution is an index lookup
// instead of an array scan over every entity.

export const entityAliases = pgTable(
  'entity_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    normalizedAlias: text('normalized_alias').notNull(),
  },
  (table) => [
    uniqueIndex('entity_aliases_alias_entity_idx').on(
      table.normalizedAlias,
      table.entityId,
    ),
    // Not unique: the same alias may legitimately point at entities of
    // different types, so resolution disambiguates by type at lookup time.
    index('entity_aliases_normalized_idx').on(table.normalizedAlias),
  ],
);

// ─── Edges ──────────────────────────────────────────────────────────────────

export const edges = pgTable(
  'edges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceEntityId: uuid('source_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    targetEntityId: uuid('target_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    relation: text('relation').$type<Relation>().notNull(),
    /** e.g. { multiplier: 2 } for type effectiveness, { method: "Thunder Stone" }. */
    properties: jsonb('properties').$type<Record<string, unknown>>().default({}),
    confidence: real('confidence').notNull().default(1),
    origin: text('origin').$type<EdgeOrigin>().notNull().default('llm'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Makes edge writes idempotent: the same triple extracted from five chunks
    // is one row with five provenance entries.
    uniqueIndex('edges_triple_idx').on(
      table.sourceEntityId,
      table.relation,
      table.targetEntityId,
    ),
    // Both directions are indexed — traversal walks edges either way.
    index('edges_source_idx').on(table.sourceEntityId),
    index('edges_target_idx').on(table.targetEntityId),
  ],
);

// ─── Bridge: chunk → entity ─────────────────────────────────────────────────
// This is what turns a traversal back into citable text.

export const chunkEntities = pgTable(
  'chunk_entities',
  {
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    mentions: integer('mentions').notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.chunkId, table.entityId] }),
    // The PK covers chunk_id lookups; entity_id needs its own index because
    // expansion walks entity → chunks.
    index('chunk_entities_entity_id_idx').on(table.entityId),
  ],
);

// ─── Bridge: edge → chunk (provenance) ──────────────────────────────────────
// An edge can be asserted by several chunks. Seed edges have no rows here,
// which is why GC must exempt them.

export const edgeChunks = pgTable(
  'edge_chunks',
  {
    edgeId: uuid('edge_id')
      .notNull()
      .references(() => edges.id, { onDelete: 'cascade' }),
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.edgeId, table.chunkId] }),
    index('edge_chunks_chunk_id_idx').on(table.chunkId),
  ],
);

// ─── Extraction ledger ──────────────────────────────────────────────────────
// Without this, a chunk that yields zero entities gets re-extracted on every
// run and "zero LLM calls on an unchanged corpus" is never true. Keyed by
// prompt version so bumping the prompt re-extracts everything.

export const chunkExtractions = pgTable('chunk_extractions', {
  chunkId: uuid('chunk_id')
    .primaryKey()
    .references(() => chunks.id, { onDelete: 'cascade' }),
  promptVersion: text('prompt_version').notNull(),
  entityCount: integer('entity_count').notNull().default(0),
  relationCount: integer('relation_count').notNull().default(0),
  extractedAt: timestamp('extracted_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Type exports ───────────────────────────────────────────────────────────

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type Edge = typeof edges.$inferSelect;
export type NewEdge = typeof edges.$inferInsert;
export type ChunkEntity = typeof chunkEntities.$inferSelect;
export type EdgeChunk = typeof edgeChunks.$inferSelect;
