// ─── Deterministic seeding ──────────────────────────────────────────────────
//
// Writes the 18 elemental types and the full effectiveness matrix as ground
// truth. These edges carry origin='seed' and confidence 1.0, they have no chunk
// provenance (nothing in the corpus asserted them — they're axioms), and they
// always win a conflict against extraction.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { entities, edges } from './schema.js';
import { normalizeName, type Relation } from './vocab.js';
import { TYPE_CHART, POKEMON_TYPES } from './type-chart.js';
import { logger } from '@app/shared';

const log = logger.child({ module: 'graph:seed' });

export interface SeedResult {
  typesCreated: number;
  typesExisting: number;
  edgesWritten: number;
}

/**
 * Idempotent: safe to run on every build. Type entities are matched on
 * (normalized_name, type) and effectiveness edges on the unique triple index.
 */
export async function seedTypeChart(): Promise<SeedResult> {
  const result: SeedResult = {
    typesCreated: 0,
    typesExisting: 0,
    edgesWritten: 0,
  };

  // ── Type entities ───────────────────────────────────────────────────
  // Deliberately left without embeddings: they're created here by name, so the
  // similarity fallback never needs to reach them.
  const idByType = new Map<string, string>();

  for (const typeName of POKEMON_TYPES) {
    const normalized = normalizeName(typeName);

    const existing = await db
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.normalizedName, normalized),
          eq(entities.type, 'type'),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      idByType.set(typeName, existing[0]!.id);
      result.typesExisting++;
      continue;
    }

    const [created] = await db
      .insert(entities)
      .values({
        canonicalName: typeName,
        normalizedName: normalized,
        type: 'type',
        summary: `The ${typeName} elemental type.`,
        metadata: { seeded: true },
      })
      .onConflictDoUpdate({
        target: [entities.normalizedName, entities.type],
        set: { canonicalName: typeName },
      })
      .returning({ id: entities.id });

    idByType.set(typeName, created!.id);
    result.typesCreated++;
  }

  // ── Effectiveness edges ─────────────────────────────────────────────
  const rows: Array<{
    sourceEntityId: string;
    targetEntityId: string;
    relation: Relation;
    properties: Record<string, unknown>;
    confidence: number;
    origin: 'seed';
  }> = [];

  const buckets = [
    { key: 'double', relation: 'super_effective_against', multiplier: 2 },
    { key: 'half', relation: 'not_very_effective_against', multiplier: 0.5 },
    { key: 'zero', relation: 'no_effect_on', multiplier: 0 },
  ] as const;

  for (const attacker of POKEMON_TYPES) {
    const chart = TYPE_CHART[attacker];
    const sourceId = idByType.get(attacker)!;

    for (const bucket of buckets) {
      for (const defender of chart[bucket.key] ?? []) {
        rows.push({
          sourceEntityId: sourceId,
          targetEntityId: idByType.get(defender)!,
          relation: bucket.relation,
          properties: { multiplier: bucket.multiplier },
          confidence: 1,
          origin: 'seed',
        });
      }
    }
  }

  // Upsert so a seed edge reclaims a triple that extraction previously wrote:
  // ground truth wins.
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    await db
      .insert(edges)
      .values(batch)
      .onConflictDoUpdate({
        target: [edges.sourceEntityId, edges.relation, edges.targetEntityId],
        set: {
          properties: sql`excluded.properties`,
          confidence: sql`excluded.confidence`,
          origin: sql`excluded.origin`,
        },
      });
    result.edgesWritten += batch.length;
  }

  log.info(result, 'Type chart seeded');
  return result;
}
