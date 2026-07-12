// ─── Rerank A/B: passthrough (RRF only) vs Cohere cross-encoder ──────────────
// Usage: pnpm --filter @app/knowledge rerank:ab "your question"
//
// Runs hybrid retrieval ONCE, then reranks the same candidate set two ways so
// you can see the cross-encoder reorder the top-5 — and how that changes the
// grounded answer. Requires COHERE_API_KEY in the root .env for the B side.

import '../src/load-env.js';
import { closeDb } from '@app/db';
import { hybridRetrieve, type RetrievedChunk } from '../src/retrieve.js';
import { PassthroughReranker, CohereReranker } from '../src/rerank.js';
import { generateAnswer } from '../src/answer.js';

const query = process.argv[2] ?? 'what are the similarities and differences between Raichu and Jolteon';
const TOP_N = 5;

function printRanking(label: string, chunks: RetrievedChunk[]) {
  console.log(`\n─── ${label} (top ${chunks.length}) ───`);
  chunks.forEach((c, i) => {
    const score = c.similarity.toFixed(4);
    const preview = c.text.slice(0, 70).replace(/\s+/g, ' ');
    console.log(`  ${i + 1}. [${score}] ${c.documentTitle}  ·  ${preview}…`);
  });
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Rerank A/B  (passthrough vs Cohere)    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\nQuery: "${query}"`);

  const candidates = await hybridRetrieve(query, { limit: 50 });
  console.log(`\nHybrid retrieval returned ${candidates.length} candidates.`);

  // A — passthrough (trusts RRF order)
  const passthrough = new PassthroughReranker();
  const aTop = await passthrough.rerank(query, candidates, TOP_N);
  printRanking('A · passthrough (RRF order)', aTop);

  // B — Cohere cross-encoder
  const key = process.env.COHERE_API_KEY?.trim();
  if (!key) {
    console.log('\n⚠  COHERE_API_KEY not set — skipping the Cohere (B) side.');
    await closeDb();
    return;
  }

  const cohere = new CohereReranker(key);
  const bTop = await cohere.rerank(query, candidates, TOP_N);
  printRanking('B · Cohere rerank-english-v3.0', bTop);

  // Show whether the ordering actually changed.
  const aIds = aTop.map((c) => c.chunkId).join(',');
  const bIds = bTop.map((c) => c.chunkId).join(',');
  console.log(
    `\nOrdering changed: ${aIds === bIds ? 'no (same top-5 order)' : 'yes — Cohere reordered the set'}`,
  );

  // Finally, actually answer the question using the Cohere-reranked context.
  console.log('\n─── Answer (using Cohere top-5) ───\n');
  const result = await generateAnswer(query, bTop);
  console.log(result.answer);
  console.log('\nCitations:');
  for (const c of result.citations) {
    console.log(`  [${c.label}] ${c.documentTitle}  (chunk ${c.chunkId})`);
  }
  console.log(`\npromptVersion=${result.promptVersion}  reAsked=${result.reAsked}`);

  await closeDb();
}

main().catch((err) => {
  console.error('A/B failed:', err);
  process.exit(1);
});
