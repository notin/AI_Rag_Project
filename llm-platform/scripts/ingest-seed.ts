// ─── Ingest seed data script ────────────────────────────────────────────────
// Usage: pnpm tsx scripts/ingest-seed.ts
//
// Reads all markdown files from packages/db/seed/ and ingests them into
// the vector store. Safe to re-run — unchanged files are skipped.

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestDirectory, closeDb } from '@app/db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(__dirname, '../packages/db/seed');

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Pokémon Seed Data Ingestion            ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();
  console.log(`Seed directory: ${SEED_DIR}`);
  console.log();

  const results = await ingestDirectory(SEED_DIR);

  console.log();
  console.log('─── Results ───');
  for (const r of results) {
    const status = r.skipped ? '⏭  SKIPPED' : `✅ ${r.chunksCreated} chunks`;
    console.log(`  ${path.basename(r.filePath).padEnd(30)} ${status}`);
  }

  const ingested = results.filter((r) => !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const totalChunks = results.reduce((sum, r) => sum + r.chunksCreated, 0);

  console.log();
  console.log(`Files ingested: ${ingested}`);
  console.log(`Files skipped:  ${skipped}`);
  console.log(`Total chunks:   ${totalChunks}`);
  console.log();
  console.log('Done! Run `pnpm tsx scripts/search.ts "your query"` to test retrieval.');

  await closeDb();
}

main().catch((err) => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});
