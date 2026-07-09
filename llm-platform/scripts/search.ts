// ─── Semantic search CLI ────────────────────────────────────────────────────
// Usage: pnpm tsx scripts/search.ts "which pokemon was created in a lab?"
//
// Embeds the query and returns the top-k most similar chunks from the
// vector store. Used to verify the Stage 2 "Done when" check.

import 'dotenv/config';
import { semanticSearch, closeDb } from '@app/db';

const query = process.argv[2];

if (!query) {
  console.error('Usage: pnpm tsx scripts/search.ts "your query here"');
  process.exit(1);
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Semantic Search                        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();
  console.log(`Query: "${query}"`);
  console.log();

  const results = await semanticSearch(query!, 5);

  if (results.length === 0) {
    console.log('No results found. Have you run `pnpm tsx scripts/ingest-seed.ts` yet?');
    await closeDb();
    return;
  }

  console.log(`Found ${results.length} results:\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const similarity = (r.similarity * 100).toFixed(1);
    const preview = r.text.slice(0, 200).replace(/\n/g, ' ');

    console.log(`  #${i + 1}  [${similarity}% similar]  📄 ${r.documentTitle}`);
    console.log(`      ${preview}...`);
    console.log();
  }

  await closeDb();
}

main().catch((err) => {
  console.error('Search failed:', err);
  process.exit(1);
});
