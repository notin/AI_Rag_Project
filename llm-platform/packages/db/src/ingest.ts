// ─── Idempotent file ingestion pipeline ─────────────────────────────────────
//
// Flow: read file → SHA-256 hash → skip if unchanged → chunk → embed → upsert.
// Designed for both one-off scripts and future worker consumption.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from './client.js';
import { documents, chunks } from './schema.js';
import { chunkText } from './chunk.js';
import { embed } from '@app/llm-client';
import { logger } from '@app/shared';

const log = logger.child({ module: 'ingest' });

/** How many texts to embed in a single API call. */
const EMBED_BATCH_SIZE = 20;

export interface IngestResult {
  filePath: string;
  title: string;
  skipped: boolean;
  chunksCreated: number;
}

/**
 * Ingest a single file into the vector store.
 *
 * Idempotency: if a document with the same source_uri exists and its
 * content_hash matches, the file is skipped entirely.
 */
export async function ingestFile(filePath: string): Promise<IngestResult> {
  const absolutePath = path.resolve(filePath);
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const title = parseTitleFromContent(content, absolutePath);
  const contentHash = hashContent(content);

  // ── Idempotency check ───────────────────────────────────────────────
  const existing = await db
    .select({ id: documents.id, contentHash: documents.contentHash })
    .from(documents)
    .where(eq(documents.sourceUri, absolutePath))
    .limit(1);

  if (existing.length > 0 && existing[0]!.contentHash === contentHash) {
    log.info({ file: path.basename(absolutePath) }, 'Skipped (unchanged)');
    return { filePath: absolutePath, title, skipped: true, chunksCreated: 0 };
  }

  // ── Chunk the content ───────────────────────────────────────────────
  const chunkResults = chunkText(content);
  log.info(
    { file: path.basename(absolutePath), chunks: chunkResults.length },
    'Chunked',
  );

  // ── Embed in batches ────────────────────────────────────────────────
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < chunkResults.length; i += EMBED_BATCH_SIZE) {
    const batch = chunkResults.slice(i, i + EMBED_BATCH_SIZE);
    const batchTexts = batch.map((c) => c.text);
    const embeddings = await embed(batchTexts);
    allEmbeddings.push(...embeddings);
    log.debug(
      { batch: Math.floor(i / EMBED_BATCH_SIZE) + 1 },
      'Embedded batch',
    );
  }

  // ── Upsert document + chunks in a transaction ───────────────────────
  // If the document already exists (same URI, different hash), delete old
  // chunks and update the document. Otherwise insert fresh.

  await db.transaction(async (tx) => {
    if (existing.length > 0) {
      // Delete old chunks (cascade would handle this too)
      await tx.delete(chunks).where(eq(chunks.documentId, existing[0]!.id));
      // Update document hash
      await tx
        .update(documents)
        .set({ contentHash, title })
        .where(eq(documents.id, existing[0]!.id));

      // Insert new chunks
      const docId = existing[0]!.id;
      await insertChunks(tx, docId, chunkResults, allEmbeddings);
    } else {
      // Insert new document
      const [doc] = await tx
        .insert(documents)
        .values({
          sourceUri: absolutePath,
          title,
          contentHash,
        })
        .returning({ id: documents.id });

      await insertChunks(tx, doc!.id, chunkResults, allEmbeddings);
    }
  });

  log.info(
    {
      file: path.basename(absolutePath),
      title,
      chunks: chunkResults.length,
    },
    'Ingested',
  );

  return {
    filePath: absolutePath,
    title,
    skipped: false,
    chunksCreated: chunkResults.length,
  };
}

/**
 * Ingest all markdown files in a directory.
 */
export async function ingestDirectory(
  dirPath: string,
): Promise<IngestResult[]> {
  const absoluteDir = path.resolve(dirPath);
  const files = fs
    .readdirSync(absoluteDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(absoluteDir, f))
    .sort();

  log.info({ dir: absoluteDir, files: files.length }, 'Ingesting directory');

  const results: IngestResult[] = [];
  for (const file of files) {
    const result = await ingestFile(file);
    results.push(result);
  }

  const ingested = results.filter((r) => !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const totalChunks = results.reduce((sum, r) => sum + r.chunksCreated, 0);

  log.info(
    { ingested, skipped, totalChunks },
    'Directory ingestion complete',
  );

  return results;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function insertChunks(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  documentId: string,
  chunkResults: { ordinal: number; text: string }[],
  embeddings: number[][],
) {
  if (chunkResults.length === 0) return;

  const values = chunkResults.map((c, i) => ({
    documentId,
    ordinal: c.ordinal,
    text: c.text,
    embedding: embeddings[i]!,
    metadata: {},
  }));

  await tx.insert(chunks).values(values);
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Extract a title from the first markdown heading, or fall back to filename.
 */
function parseTitleFromContent(content: string, filePath: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match?.[1]) return match[1].trim();
  return path.basename(filePath, path.extname(filePath));
}
