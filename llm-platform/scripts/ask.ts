// ─── RAG ask CLI (retrieve → generate) ──────────────────────────────────────
// Usage: pnpm tsx scripts/ask.ts "which pokemon was created in a lab?"
//
// The "glue" that turns matching chunks into a real answer:
//   1. semanticSearch() finds the top-k most relevant chunks (Stage 2).
//   2. We assemble those chunks into a numbered context block.
//   3. DeepSeek (via the gateway client) answers ONLY from that context
//      and cites the sources it used — or declines if the answer isn't there.
//
// This is the lightweight, script-level version of Stage 3's RAG pipeline
// (no Hono server, no rerank yet) — enough to prove grounded generation works.

import 'dotenv/config';
import { semanticSearch, closeDb, type SearchResult } from '@app/db';
import { complete } from '@app/llm-client';

const query = process.argv[2];
const TOP_K = 5;

if (!query) {
  console.error('Usage: pnpm tsx scripts/ask.ts "your question here"');
  process.exit(1);
}

const SYSTEM_PROMPT = `You are a precise assistant that answers questions using ONLY the provided context.

Rules:
- Use ONLY facts found in the numbered context sources below. Do not use outside knowledge.
- Cite the sources you used inline with bracketed numbers, e.g. [1] or [2][3].
- If the context does not contain the answer, reply exactly: "I don't know based on the provided context." Do not guess.
- Keep the answer concise and factual.`;

function buildContext(results: SearchResult[]): string {
  return results
    .map((r, i) => {
      const similarity = (r.similarity * 100).toFixed(1);
      return `[${i + 1}] (source: ${r.documentTitle}, ${similarity}% similar)\n${r.text}`;
    })
    .join('\n\n');
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   RAG Ask  (retrieve → DeepSeek)         ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();
  console.log(`Question: "${query}"`);
  console.log();

  // ─── 1. Retrieve ──────────────────────────────────────────────────────────
  const results = await semanticSearch(query!, TOP_K);

  if (results.length === 0) {
    console.log('No context found. Have you run `pnpm tsx scripts/ingest-seed.ts` yet?');
    await closeDb();
    return;
  }

  console.log(`Retrieved ${results.length} chunks:`);
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const similarity = (r.similarity * 100).toFixed(1);
    console.log(`  [${i + 1}] ${similarity}%  📄 ${r.documentTitle}`);
  }
  console.log();

  // ─── 2. Assemble context + 3. Generate ────────────────────────────────────
  const context = buildContext(results);

  const res = await complete({
    system: SYSTEM_PROMPT,
    prompt: `Context:\n\n${context}\n\n---\n\nQuestion: ${query}\n\nAnswer (cite sources with [n]):`,
    temperature: 0.2,
  });

  console.log('─── Answer ───');
  console.log();
  console.log(res.text.trim());
  console.log();

  // Show which documents the citations map back to, for verification.
  console.log('─── Sources ───');
  for (let i = 0; i < results.length; i++) {
    console.log(`  [${i + 1}] ${results[i]!.documentTitle}  (chunk ${results[i]!.chunkId})`);
  }
  console.log();

  await closeDb();
}

main().catch((err) => {
  console.error('Ask failed:', err);
  process.exit(1);
});
