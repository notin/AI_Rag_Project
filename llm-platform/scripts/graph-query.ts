// ─── Graph retrieval debugger ───────────────────────────────────────────────
// Usage: pnpm graph:query "Which Eevee evolution beats Dragon types?" [--hops=2]
//
// Shows every stage of graph-expanded retrieval: the seed chunks the vector arm
// found, the entities they resolved to, how far the traversal reached, the
// chunks it added that semantic search MISSED, and the serialized facts.
//
// That "added" list is the whole justification for the graph layer. If it's
// empty for a question that needs multiple hops, something upstream is broken —
// start with extraction coverage, then entity resolution.

import 'dotenv/config';
import { graphRetrieve, semanticSearch, closeDb } from '@app/db';

const query = process.argv[2];
const hopsArg = process.argv.find((a) => a.startsWith('--hops='));
const maxHops = hopsArg ? Number(hopsArg.split('=')[1]) : 2;

if (!query) {
  console.error(
    'Usage: pnpm graph:query "your question here" [--hops=2]',
  );
  process.exit(1);
}

function preview(text: string, n = 140): string {
  return text.slice(0, n).replace(/\s+/g, ' ') + (text.length > n ? '…' : '');
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Graph-Expanded Retrieval               ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();
  console.log(`Query:    "${query}"`);
  console.log(`Max hops: ${maxHops}`);
  console.log();

  const result = await graphRetrieve(query!, { maxHops, seedK: 10 });

  // ── 1. What the vector arm found alone ────────────────────────────
  console.log('── 1. Seed chunks (semantic arm) ──────────');
  if (result.seeds.length === 0) {
    console.log('  none — is the corpus ingested?');
  }
  for (const [i, s] of result.seeds.slice(0, 5).entries()) {
    console.log(
      `  #${i + 1} [${(s.similarity * 100).toFixed(1)}%] ${s.documentTitle}`,
    );
    console.log(`      ${preview(s.text)}`);
  }

  // ── 2. Entities those chunks mention ──────────────────────────────
  console.log();
  console.log('── 2. Entities in the seed chunks ─────────');
  if (result.seedEntities.length === 0) {
    console.log('  none — these chunks have no extracted entities yet.');
  }
  console.log(
    '  ' +
      result.seedEntities
        .map((e) => `${e.canonicalName}(${e.type})×${e.mentions}`)
        .join(', '),
  );

  // ── 3. Traversal reach ────────────────────────────────────────────
  console.log();
  console.log(`── 3. Reached within ${maxHops} hops ─────────────────`);
  const byHop = new Map<number, string[]>();
  for (const e of result.reachedEntities) {
    const list = byHop.get(e.hops) ?? [];
    list.push(e.canonicalName);
    byHop.set(e.hops, list);
  }
  for (const hop of [...byHop.keys()].sort((a, b) => a - b)) {
    console.log(`  ${hop} hop: ${byHop.get(hop)!.join(', ')}`);
  }

  // ── 4. The delta — this is the point ──────────────────────────────
  console.log();
  console.log('── 4. Chunks the graph ADDED ──────────────');
  const seedIds = new Set(result.seeds.map((s) => s.chunkId));
  if (result.expanded.length === 0) {
    console.log('  (none — the graph contributed nothing for this query)');
  }
  for (const c of result.expanded) {
    const flag = seedIds.has(c.chunkId) ? '' : ' ← new';
    console.log(
      `  [${c.hops} hop, ${c.entityCount} entities] ${c.documentTitle}${flag}`,
    );
    console.log(`      ${preview(c.text)}`);
  }

  // ── 5. Derived matchups ───────────────────────────────────────────
  // Composed, not stored: has_type × the type chart, multiplied out. This is
  // the part the raw chart facts below cannot express on their own.
  console.log();
  console.log('── 5. Derived defensive matchups ──────────');
  if (result.matchups.length === 0) console.log('  (none)');
  for (const m of result.matchups) {
    console.log(`  ${m.line}`);
  }

  // ── 6. Facts for the prompt ───────────────────────────────────────
  console.log();
  console.log('── 6. Serialized facts ────────────────────');
  if (result.facts.length === 0) console.log('  (none)');
  for (const f of result.facts.slice(0, 25)) {
    console.log(`  ${f.line}`);
  }
  if (result.facts.length > 25) {
    console.log(`  … and ${result.facts.length - 25} more`);
  }

  // ── Summary ───────────────────────────────────────────────────────
  const baseline = await semanticSearch(query!, 5);
  const baselineIds = new Set(baseline.map((b) => b.chunkId));
  const genuinelyNew = result.expanded.filter(
    (c) => !baselineIds.has(c.chunkId),
  );

  console.log();
  console.log('───────────────────────────────────────────');
  console.log(
    `Semantic top-5 alone: ${baseline.length} chunks. ` +
      `Graph added ${genuinelyNew.length} the vector arm never returned.`,
  );

  await closeDb();
}

main().catch(async (err) => {
  console.error('Graph query failed:', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
