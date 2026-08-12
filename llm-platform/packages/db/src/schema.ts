import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
// NOTE: extensionless — drizzle-kit's schema loader requires these files as CJS
// and does not rewrite a `.js` specifier back to the `.ts` source.
import { vector, tsvector } from './column-types';

// ─── Dimension constant ─────────────────────────────────────────────────────
// Must match the embedding model output. text-embedding-3-small = 1536.
// Change model → change this → re-embed everything.
export const EMBEDDING_DIMENSIONS = 1536;

// ─── Documents table ────────────────────────────────────────────────────────
// One row per ingested file. content_hash enables idempotent re-ingestion:
// if the hash hasn't changed, skip the file.

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceUri: text('source_uri').notNull(),
    title: text('title').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('documents_source_uri_idx').on(table.sourceUri),
  ],
);

// ─── Chunks table ───────────────────────────────────────────────────────────
// Each document is split into chunks; each chunk gets an embedding vector.
// The tsv column is populated via a trigger/generated column for
// full-text keyword search (used in Stage 3 hybrid retrieval).

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    // Keyword half of Stage 3's hybrid retrieval. Generated (not trigger-
    // maintained) so Postgres keeps it in sync with `text` and it can never
    // drift.
    tsv: tsvector('tsv').generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', ${chunks.text})`,
    ),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (table) => [
    // HNSW index for fast approximate nearest-neighbour search.
    // vector_cosine_ops = use cosine distance (the <=> operator).
    index('chunks_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
    // GIN over the full-text vector — the keyword arm of hybrid retrieval.
    index('chunks_tsv_gin_idx').using('gin', table.tsv),
    // Composite index for efficient lookups by document.
    index('chunks_document_id_idx').on(table.documentId),
  ],
);

// ─── Type exports ───────────────────────────────────────────────────────────
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
