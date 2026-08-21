// ─── Knowledge graph builder ────────────────────────────────────────────────
// Usage: pnpm graph:build [--force] [--model=<id>]
//
//   --force   re-extract every chunk, ignoring the extraction ledger
//   --model   override the extraction model
//
// Seeds the type chart, extracts entities/relations from any chunk that hasn't
// been processed at the current prompt version, then garbage-collects orphans.

import 'dotenv/config';
import { buildGraph, graphStats, closeDb } from '@app/db';

const args = process.argv.slice(2);
const force = args.includes('--force');
const model = args.find((a) => a.startsWith('--model='))?.split('=')[1];

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Knowledge Graph Build                  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();
  if (force) console.log('Mode: --force (re-extracting every chunk)\n');

  const started = Date.now();
  const result = await buildGraph({
    force,
    ...(model ? { model } : {}),
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const stats = await graphStats();

  console.log();
  console.log('── Extraction ─────────────────────────────');
  console.log(`  chunks total      ${result.chunksTotal}`);
  console.log(`  extracted         ${result.chunksExtracted}`);
  console.log(`  skipped (current) ${result.chunksSkipped}`);
  console.log(`  failed            ${result.chunksFailed}`);

  console.log();
  console.log('── Entity resolution ──────────────────────');
  console.log(`  exact name match  ${result.entitiesResolved.exact}`);
  console.log(`  alias match       ${result.entitiesResolved.alias}`);
  console.log(`  embedding match   ${result.entitiesResolved.embedding}`);
  console.log(`  created new       ${result.entitiesResolved.created}`);

  console.log();
  console.log('── Graph ──────────────────────────────────');
  console.log(`  entities          ${stats.entities}`);
  for (const row of stats.entitiesByType) {
    console.log(`      ${row.type.padEnd(16)} ${row.count}`);
  }
  console.log(`  edges             ${stats.edges}`);
  for (const row of stats.edgesByRelation) {
    console.log(
      `      ${row.relation.padEnd(28)} ${String(row.count).padStart(4)}  (${row.origin})`,
    );
  }
  console.log(`  chunk mentions    ${stats.mentions}`);

  console.log();
  console.log('── Garbage collection ─────────────────────');
  console.log(`  orphan edges      ${result.orphanEdgesDropped} dropped`);
  console.log(`  orphan entities   ${result.orphanEntitiesDropped} dropped`);

  // Every non-seed edge must trace back to a chunk, or it's an uncitable claim.
  if (stats.edgesWithoutProvenance > 0) {
    console.log();
    console.log(
      `  ⚠  ${stats.edgesWithoutProvenance} non-seed edges have no chunk provenance — that's a bug, not a statistic.`,
    );
  }

  console.log();
  console.log(`Done in ${elapsed}s.`);

  await closeDb();
}

main().catch(async (err) => {
  console.error('Graph build failed:', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
