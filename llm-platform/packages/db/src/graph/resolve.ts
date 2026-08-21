// ─── Entity resolution ──────────────────────────────────────────────────────
//
// Maps extracted names onto entity ids. This is where knowledge graphs actually
// go wrong: get it slightly loose and Pikachu merges into Raichu; get it
// slightly tight and you end up with "Mr. Mime", "Mr Mime" and "mr. mime" as
// three unrelated nodes that never connect to each other.
//
// Resolution runs as a BATCH, not per-name, so each step is a single query and
// the embedding fallback can batch its embed calls.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { entities, entityAliases } from './schema.js';
import { entityKey, normalizeName, type EntityType } from './vocab.js';
import { embed } from '@app/llm-client';
import { logger } from '@app/shared';

const log = logger.child({ module: 'graph:resolve' });

/**
 * Cosine similarity floor for the embedding fallback.
 *
 * Deliberately high. Short proper nouns embed close together — "Pikachu" and
 * "Raichu" are far more similar to each other than either is to a random
 * sentence — so a permissive threshold here silently corrupts the graph. This
 * is a safety net for transcription variants, not a fuzzy matcher.
 */
const EMBEDDING_MATCH_THRESHOLD = 0.94;

const EMBED_BATCH_SIZE = 50;

export interface EntityCandidate {
  name: string;
  type: EntityType;
  aliases?: string[];
}

export interface ResolutionStats {
  exact: number;
  alias: number;
  embedding: number;
  created: number;
}

export interface ResolutionResult {
  /** entityKey(type, name) -> entity id */
  idByKey: Map<string, string>;
  stats: ResolutionStats;
}

/**
 * Resolve a batch of extracted names to entity ids, creating entities that
 * don't exist yet.
 *
 * The cascade, cheapest step first:
 *   1. exact match on (normalized_name, type)
 *   2. exact match on an alias, disambiguated by type
 *   3. cosine match against entity embeddings above EMBEDDING_MATCH_THRESHOLD
 *   4. create
 */
export async function resolveEntities(
  candidates: EntityCandidate[],
): Promise<ResolutionResult> {
  const stats: ResolutionStats = {
    exact: 0,
    alias: 0,
    embedding: 0,
    created: 0,
  };
  const idByKey = new Map<string, string>();

  // ── Dedupe within the batch ─────────────────────────────────────────
  // Several chunks mentioning "Pikachu" is one resolution, not twenty.
  const unique = new Map<string, EntityCandidate & { normalized: string }>();
  for (const c of candidates) {
    const normalized = normalizeName(c.name);
    if (!normalized) continue;
    const key = entityKey(c.type, c.name);
    const existing = unique.get(key);
    if (existing) {
      // Merge alias sets across mentions of the same entity.
      existing.aliases = [
        ...new Set([...(existing.aliases ?? []), ...(c.aliases ?? [])]),
      ];
    } else {
      unique.set(key, { ...c, normalized });
    }
  }

  if (unique.size === 0) return { idByKey, stats };

  let pending = [...unique.entries()];

  // ── Step 1: exact (normalized_name, type) ───────────────────────────
  const normalizedNames = [...new Set(pending.map(([, c]) => c.normalized))];
  const exactRows = await db
    .select({
      id: entities.id,
      normalizedName: entities.normalizedName,
      type: entities.type,
    })
    .from(entities)
    .where(inArray(entities.normalizedName, normalizedNames));

  const exactIndex = new Map(
    exactRows.map((r) => [`${r.type}:${r.normalizedName}`, r.id]),
  );

  pending = pending.filter(([key, c]) => {
    const hit = exactIndex.get(`${c.type}:${c.normalized}`);
    if (hit) {
      idByKey.set(key, hit);
      stats.exact++;
      return false;
    }
    return true;
  });

  // ── Step 2: alias lookup, disambiguated by type ─────────────────────
  if (pending.length > 0) {
    const aliasRows = await db
      .select({
        entityId: entityAliases.entityId,
        normalizedAlias: entityAliases.normalizedAlias,
        type: entities.type,
      })
      .from(entityAliases)
      .innerJoin(entities, eq(entityAliases.entityId, entities.id))
      .where(
        inArray(
          entityAliases.normalizedAlias,
          pending.map(([, c]) => c.normalized),
        ),
      );

    const aliasIndex = new Map(
      aliasRows.map((r) => [`${r.type}:${r.normalizedAlias}`, r.entityId]),
    );

    pending = pending.filter(([key, c]) => {
      const hit = aliasIndex.get(`${c.type}:${c.normalized}`);
      if (hit) {
        idByKey.set(key, hit);
        stats.alias++;
        return false;
      }
      return true;
    });
  }

  if (pending.length === 0) return { idByKey, stats };

  // ── Embed the remaining misses once ─────────────────────────────────
  // The vectors are reused twice: for the similarity fallback below, and as
  // the stored embedding of any entity we end up creating.
  const embeddings = await embedNames(
    pending.map(([, c]) => embeddingText(c.name, c.type)),
  );

  // ── Step 3: cosine fallback ─────────────────────────────────────────
  const stillPending: Array<
    [string, EntityCandidate & { normalized: string }, number[]]
  > = [];

  for (let i = 0; i < pending.length; i++) {
    const [key, candidate] = pending[i]!;
    const vector = embeddings[i]!;
    const match = await findSimilarEntity(vector, candidate.type);

    if (match) {
      idByKey.set(key, match.id);
      stats.embedding++;
      // Always log these. The threshold is a tuning knob and this log is the
      // only dataset you'll have for tuning it — or for catching the day it
      // quietly merges two different Pokémon.
      log.warn(
        {
          resolved: candidate.name,
          onto: match.canonicalName,
          type: candidate.type,
          similarity: Number(match.similarity.toFixed(4)),
        },
        'Entity resolved by embedding similarity',
      );
      // Record what we saw as an alias so the next run hits step 2 instead.
      await insertAliases(match.id, [candidate.name]);
    } else {
      stillPending.push([key, candidate, vector]);
    }
  }

  // ── Step 4: create ──────────────────────────────────────────────────
  for (const [key, candidate, vector] of stillPending) {
    const [created] = await db
      .insert(entities)
      .values({
        canonicalName: candidate.name,
        normalizedName: candidate.normalized,
        type: candidate.type,
        embedding: vector,
      })
      // Concurrent runs can race on the same new name; let the unique index
      // arbitrate rather than throwing.
      .onConflictDoUpdate({
        target: [entities.normalizedName, entities.type],
        set: { canonicalName: candidate.name },
      })
      .returning({ id: entities.id });

    idByKey.set(key, created!.id);
    stats.created++;

    if (candidate.aliases?.length) {
      await insertAliases(created!.id, candidate.aliases);
    }
  }

  return { idByKey, stats };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Embed the name together with its type. A bare "Fire" is ambiguous; "Fire
 * (type)" and "Fire (move)" separate cleanly, which is what makes the
 * similarity fallback safe enough to enable by default.
 */
function embeddingText(name: string, type: EntityType): string {
  return `${name} (${type})`;
}

async function embedNames(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    out.push(...(await embed(batch)));
  }
  return out;
}

async function findSimilarEntity(
  vector: number[],
  type: EntityType,
): Promise<{ id: string; canonicalName: string; similarity: number } | null> {
  const literal = `[${vector.join(',')}]`;

  const [row] = await db
    .select({
      id: entities.id,
      canonicalName: entities.canonicalName,
      similarity: sql<number>`1 - (${entities.embedding} <=> ${literal}::vector)`,
    })
    .from(entities)
    .where(
      and(
        eq(entities.type, type),
        sql`${entities.embedding} IS NOT NULL`,
      ),
    )
    .orderBy(sql`${entities.embedding} <=> ${literal}::vector`)
    .limit(1);

  if (!row || row.similarity < EMBEDDING_MATCH_THRESHOLD) return null;
  return row;
}

async function insertAliases(entityId: string, aliases: string[]) {
  const rows = aliases
    .map((a) => ({
      entityId,
      alias: a,
      normalizedAlias: normalizeName(a),
    }))
    .filter((r) => r.normalizedAlias.length > 0);

  if (rows.length === 0) return;

  await db.insert(entityAliases).values(rows).onConflictDoNothing();
}
