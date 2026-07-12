// ─── Semantic search via cosine distance ────────────────────────────────────
//
// Embeds the query text, then finds the k nearest chunks using pgvector's
// cosine distance operator (<=>). Returns results with similarity scores.

import { sql } from 'drizzle-orm';
import { db } from './client.js';
import { chunks, documents } from './schema.js';
import { embed } from '@app/llm-client';

export interface SearchResult {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  text: string;
  ordinal: number;
  similarity: number;
}

/**
 * Find the k most semantically similar chunks to a query string.
 *
 * Under the hood:
 * 1. Embed the query via the gateway (same model used for ingestion).
 * 2. ORDER BY embedding <=> query_embedding LIMIT k  (cosine distance).
 * 3. Return results with similarity = 1 - distance.
 */
export async function semanticSearch(
  query: string,
  k: number = 5,
): Promise<SearchResult[]> {
  // Embed the query — single-element batch
  const [queryEmbedding] = await embed([query]);

  // Convert to pgvector literal string
  const vectorLiteral = `[${queryEmbedding!.join(',')}]`;

  // Query: join chunks → documents, order by cosine distance, limit k
  const results = await db
    .select({
      chunkId: chunks.id,
      documentId: chunks.documentId,
      documentTitle: documents.title,
      text: chunks.text,
      ordinal: chunks.ordinal,
      // cosine distance = 1 - cosine_similarity; we report similarity
      similarity: sql<number>`1 - (${chunks.embedding} <=> ${vectorLiteral}::vector)`,
    })
    .from(chunks)
    .innerJoin(documents, sql`${chunks.documentId} = ${documents.id}`)
    .orderBy(sql`${chunks.embedding} <=> ${vectorLiteral}::vector`)
    .limit(k);

  return results;
}

/**
 * Full-text keyword search — the "BM25-ish" half of hybrid retrieval.
 *
 * Uses Postgres full-text search: `tsv @@ plainto_tsquery('english', $query)`
 * matches chunks containing the query terms, ranked by `ts_rank`. This is the
 * arm that catches exact tokens (codes, SKUs, rare proper nouns) that semantic
 * embeddings can smear together.
 *
 * `similarity` here is the normalized ts_rank (not comparable to the cosine
 * similarity from semanticSearch — the two are fused by *rank*, not score).
 */
export async function keywordSearch(
  query: string,
  k: number = 50,
): Promise<SearchResult[]> {
  const results = await db
    .select({
      chunkId: chunks.id,
      documentId: chunks.documentId,
      documentTitle: documents.title,
      text: chunks.text,
      ordinal: chunks.ordinal,
      similarity: sql<number>`ts_rank(${chunks.tsv}, plainto_tsquery('english', ${query}))`,
    })
    .from(chunks)
    .innerJoin(documents, sql`${chunks.documentId} = ${documents.id}`)
    .where(sql`${chunks.tsv} @@ plainto_tsquery('english', ${query})`)
    .orderBy(sql`ts_rank(${chunks.tsv}, plainto_tsquery('english', ${query})) DESC`)
    .limit(k);

  return results;
}
