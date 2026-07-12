import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ─── Custom tsvector type ────────────────────────────────────────────────────
// Postgres full-text search type. Populated by a STORED generated column
// (see the `tsv` column below) so it stays in sync with `text` automatically.
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

// ─── Custom pgvector type ───────────────────────────────────────────────────
// Drizzle has built-in vector support but we define it explicitly
// to ensure full control over the dimension and operator class.

const vector = customType<{
  data: number[];
  dpiverName: 'vector';
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: unknown): number[] {
    // postgres.js returns vector as a string like "[0.1,0.2,...]"
    if (typeof value === 'string') {
      return value
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split(',')
        .map(Number);
    }
    return value as number[];
  },
});

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
    // Full-text search vector, generated (STORED) from `text`. This is the
    // keyword half of Stage 3 hybrid retrieval. Because it's a generated
    // column, Postgres keeps it in sync automatically — no re-ingest needed.
    tsv: tsvector('tsv').generatedAlwaysAs(
      (): any => sql`to_tsvector('english', ${chunks.text})`,
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
    // GIN index over the tsvector — the keyword-search accelerator.
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
