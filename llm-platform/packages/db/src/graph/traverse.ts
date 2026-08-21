// ─── Graph traversal ────────────────────────────────────────────────────────
//
// The retrieval-facing half of the graph. Takes chunks the vector arm already
// found, walks out from the entities they mention, and comes back with chunks
// the vector arm would never have surfaced.
//
// Results are RANKED, not scored: Stage 3 fuses arms with Reciprocal Rank
// Fusion, which consumes ranks only. That's what lets the graph drop into the
// existing fusion step as just another arm.

import { sql } from 'drizzle-orm';
import { db } from '../client.js';
import { WALK_RELATIONS, type Relation } from './vocab.js';

export interface ExpandOptions {
  /**
   * How far to walk. 1 is usually enough, 2 answers genuine multi-hop
   * questions, 3+ floods the pool with loosely-related noise the reranker then
   * has to spend its budget discarding.
   */
  maxHops?: number;
  /** Ceiling on entities visited, so a hub node can't drag in the whole graph. */
  maxNodes?: number;
  /**
   * Ceiling per hop level.
   *
   * This exists because a single global cap doesn't work: a handful of seed
   * chunks routinely mention 50+ entities, so an overall `LIMIT` ordered by
   * distance is spent entirely on hop 0 and the traversal never actually
   * traverses. Budgeting per level guarantees the walk gets room.
   */
  maxNodesPerHop?: number;
  /** Ceiling on chunks returned. */
  maxChunks?: number;
  /**
   * How many seed-chunk entities the walk is allowed to start from.
   *
   * Seed chunks routinely mention 50–80 entities (every type, move and region
   * that appears in the passage). Starting the recursive CTE from all of them
   * is what makes 2 hops feel unbounded: the output caps then throw most of
   * that work away. Pokémon first, then types, then everyone else.
   */
  maxWalkSeeds?: number;
  /**
   * How many reached entities a chunk must mention before the walk will return
   * it. Applies to added chunks only — seed chunks are already justified by the
   * vector arm.
   *
   * 1 (the default) means "shares anything", which stops discriminating as soon
   * as the graph has hub nodes: a corpus whose chunks each mention ~15 entities,
   * several of them hubs, puts almost every chunk one shared entity away from
   * every other. Raising this to 2 asks for corroboration instead of a single
   * incidental co-mention.
   */
  minSharedEntities?: number;
  /** Restrict the walk to these relations. Omit to traverse all of them. */
  relations?: Relation[];
}

const DEFAULTS = {
  maxHops: 2,
  maxNodes: 32,
  maxNodesPerHop: 12,
  maxChunks: 20,
  minSharedEntities: 1,
  maxWalkSeeds: 12,
} satisfies Required<Omit<ExpandOptions, 'relations'>>;

export interface ReachedEntity {
  entityId: string;
  canonicalName: string;
  type: string;
  hops: number;
  /** How many of the seed chunks mention this entity. Zero beyond hop 0. */
  mentions: number;
  /** Total edges on this entity. High degree means hub — see the ranking note. */
  degree: number;
}

export interface ExpandedChunk {
  chunkId: string;
  /** Distance from the nearest seed chunk, in graph hops. */
  hops: number;
  /** How many reached entities this chunk mentions. */
  entityCount: number;
  /** True when the vector arm already had this chunk. */
  isSeed: boolean;
}

export interface GraphExpansion {
  /**
   * EVERY entity the seed chunks mention, uncapped, most-mentioned first.
   *
   * Observability only. The walk starts from `maxWalkSeeds` of these
   * (Pokémon first), and facts pick a further-capped subset. Dumping this
   * whole list into graphFacts is what produced the 125-id binds.
   */
  seedEntities: ReachedEntity[];
  /** The ranked, capped walk — what the expansion arm is allowed to fan out from. */
  entities: ReachedEntity[];
  chunks: ExpandedChunk[];
}

/**
 * Expand a set of seed chunk ids into graph-reachable chunks.
 *
 * seed chunks → entities they mention → walk N hops → chunks mentioning
 * anything reached.
 */
export async function graphExpand(
  seedChunkIds: string[],
  opts: ExpandOptions = {},
): Promise<GraphExpansion> {
  const maxHops = opts.maxHops ?? DEFAULTS.maxHops;
  const maxNodes = opts.maxNodes ?? DEFAULTS.maxNodes;
  const maxNodesPerHop = opts.maxNodesPerHop ?? DEFAULTS.maxNodesPerHop;
  const maxChunks = opts.maxChunks ?? DEFAULTS.maxChunks;
  const minShared = opts.minSharedEntities ?? DEFAULTS.minSharedEntities;
  const maxWalkSeeds = opts.maxWalkSeeds ?? DEFAULTS.maxWalkSeeds;

  if (seedChunkIds.length === 0) {
    return { seedEntities: [], entities: [], chunks: [] };
  }

  const seedParam = sql.param(seedChunkIds);

  // Omit = walk relations (no type chart). Explicit [] = every relation.
  const walkRelations =
    opts.relations === undefined
      ? [...WALK_RELATIONS]
      : opts.relations;
  const relationFilter =
    walkRelations.length > 0
      ? sql`AND e.relation = ANY(${sql.param(walkRelations)}::text[])`
      : sql``;

  type EntityRow = {
    entity_id: string;
    canonical_name: string;
    type: string;
    hops: number;
    mentions: number;
    degree: number;
  };

  // Termination: `UNION` dedupes (entity_id, hops) pairs and the recursive term
  // is bounded by `hops < maxHops`, so cycles can't run away. Depth is the
  // guard here, not a visited-set — which is fine at these depths and keeps the
  // CTE to a single self-reference, as Postgres requires.
  //
  // Ranking, which matters as much as the walk itself:
  //   hop 0  — most-mentioned first. These are what the passage is *about*.
  //   hop 1+ — most links back to the seed set first. Degree alone is a bad
  //            tiebreak here: ordering by it ascending fills the budget with
  //            leaf nodes (a move mentioned once) ahead of the mid-degree
  //            Pokémon that actually connect the question together. Degree
  //            survives only as a final tiebreak, to keep hubs from winning
  //            ties outright.
  const rows = await db.execute<EntityRow>(sql`
    WITH RECURSIVE seed AS (
      SELECT entity_id, mentions FROM (
        SELECT ce.entity_id, count(*)::int AS mentions
        FROM chunk_entities ce
        JOIN entities en ON en.id = ce.entity_id
        WHERE ce.chunk_id = ANY(${seedParam}::uuid[])
        GROUP BY ce.entity_id, en.type
        ORDER BY (en.type = 'pokemon') DESC,
                 (en.type = 'type') DESC,
                 mentions DESC,
                 ce.entity_id
        LIMIT ${maxWalkSeeds}
      ) top
    ),
    reachable AS (
      SELECT entity_id, 0 AS hops FROM seed
      UNION
      SELECT
        CASE WHEN e.source_entity_id = r.entity_id
             THEN e.target_entity_id
             ELSE e.source_entity_id
        END AS entity_id,
        r.hops + 1 AS hops
      FROM reachable r
      JOIN edges e
        ON r.entity_id IN (e.source_entity_id, e.target_entity_id)
      WHERE r.hops < ${maxHops}
      ${relationFilter}
    ),
    collapsed AS (
      SELECT entity_id, MIN(hops)::int AS hops
      FROM reachable GROUP BY entity_id
    ),
    degrees AS (
      -- Full scan of edges. Fine at this size; at scale this wants a
      -- maintained counter column rather than a per-query aggregate.
      SELECT entity_id, count(*)::int AS degree FROM (
        SELECT source_entity_id AS entity_id FROM edges
        UNION ALL
        SELECT target_entity_id FROM edges
      ) endpoints
      GROUP BY entity_id
    ),
    links AS (
      -- How strongly a reached entity ties back to what the passages are about.
      SELECT c.entity_id, count(DISTINCT s.entity_id)::int AS links
      FROM collapsed c
      JOIN edges e ON c.entity_id IN (e.source_entity_id, e.target_entity_id)
      JOIN seed s
        ON s.entity_id IN (e.source_entity_id, e.target_entity_id)
       AND s.entity_id <> c.entity_id
      GROUP BY c.entity_id
    ),
    ranked AS (
      SELECT
        c.entity_id,
        c.hops,
        COALESCE(s.mentions, 0) AS mentions,
        COALESCE(l.links, 0)    AS links,
        COALESCE(d.degree, 0)   AS degree,
        ROW_NUMBER() OVER (
          PARTITION BY c.hops
          ORDER BY COALESCE(s.mentions, 0) DESC,
                   COALESCE(l.links, 0) DESC,
                   COALESCE(d.degree, 0) ASC,
                   c.entity_id
        ) AS rn
      FROM collapsed c
      LEFT JOIN seed s    ON s.entity_id = c.entity_id
      LEFT JOIN links l   ON l.entity_id = c.entity_id
      LEFT JOIN degrees d ON d.entity_id = c.entity_id
    )
    SELECT r.entity_id, en.canonical_name, en.type, r.hops, r.mentions, r.degree
    FROM ranked r
    JOIN entities en ON en.id = r.entity_id
    WHERE r.rn <= ${maxNodesPerHop}
    ORDER BY r.hops ASC, r.mentions DESC, r.links DESC, r.degree ASC,
             en.canonical_name ASC
    LIMIT ${maxNodes}
  `);

  const reached: ReachedEntity[] = ([...rows] as EntityRow[]).map((r) => ({
    entityId: r.entity_id,
    canonicalName: r.canonical_name,
    type: r.type,
    hops: r.hops,
    mentions: r.mentions,
    degree: r.degree,
  }));

  const seedEntities = await seedEntitiesFor(seedChunkIds);

  if (reached.length === 0) {
    return { seedEntities, entities: [], chunks: [] };
  }

  // ── Reached entities → chunks ───────────────────────────────────────
  // Done as a second query rather than folded into the CTE so the maxNodes cap
  // actually bounds what we fan out from.
  const hopByEntity = new Map(reached.map((e) => [e.entityId, e.hops]));
  const entityIds = reached.map((e) => e.entityId);

  const chunkRows = await db.execute<{
    chunk_id: string;
    entity_ids: string[];
    entity_count: number;
  }>(sql`
    SELECT
      ce.chunk_id,
      array_agg(ce.entity_id::text) AS entity_ids,
      count(*)::int AS entity_count
    FROM chunk_entities ce
    WHERE ce.entity_id = ANY(${sql.param(entityIds)}::uuid[])
    GROUP BY ce.chunk_id
    HAVING count(*) >= ${minShared}
        OR ce.chunk_id = ANY(${seedParam}::uuid[])
  `);

  const seedSet = new Set(seedChunkIds);

  const chunks: ExpandedChunk[] = [...chunkRows]
    .map((r) => {
      const row = r as {
        chunk_id: string;
        entity_ids: string[];
        entity_count: number;
      };
      // A chunk's distance is that of the closest entity in it.
      const hops = Math.min(
        ...row.entity_ids.map((id) => hopByEntity.get(id) ?? maxHops),
      );
      return {
        chunkId: row.chunk_id,
        hops,
        entityCount: row.entity_count,
        isSeed: seedSet.has(row.chunk_id),
      };
    })
    // Nearer first, then better-connected. This ordering IS the rank that
    // Stage 3's RRF consumes.
    .sort(
      (a, b) => a.hops - b.hops || b.entityCount - a.entityCount,
    )
    .slice(0, maxChunks);

  return { seedEntities, entities: reached, chunks };
}

/**
 * Every entity mentioned by the seed chunks, most-mentioned first. Uncapped on
 * purpose — see the note on `GraphExpansion.seedEntities`.
 */
async function seedEntitiesFor(
  seedChunkIds: string[],
): Promise<ReachedEntity[]> {
  const rows = await db.execute<{
    entity_id: string;
    canonical_name: string;
    type: string;
    mentions: number;
  }>(sql`
    SELECT ce.entity_id, en.canonical_name, en.type, count(*)::int AS mentions
    FROM chunk_entities ce
    JOIN entities en ON en.id = ce.entity_id
    WHERE ce.chunk_id = ANY(${sql.param(seedChunkIds)}::uuid[])
    GROUP BY ce.entity_id, en.canonical_name, en.type
    ORDER BY mentions DESC, en.canonical_name ASC
  `);

  return [...rows].map((r) => {
    const row = r as {
      entity_id: string;
      canonical_name: string;
      type: string;
      mentions: number;
    };
    return {
      entityId: row.entity_id,
      canonicalName: row.canonical_name,
      type: row.type,
      hops: 0,
      mentions: row.mentions,
      degree: 0,
    };
  });
}

/**
 * Ranked chunk ids only — the shape Stage 3's fusion step wants.
 *
 * Seed chunks are dropped by default: the semantic arm already ranked those,
 * and leaving them in lets the graph arm double-count what the vector arm
 * found instead of contributing anything new.
 */
export async function graphSearch(
  seedChunkIds: string[],
  opts: ExpandOptions & { includeSeeds?: boolean } = {},
): Promise<string[]> {
  const { chunks } = await graphExpand(seedChunkIds, opts);
  return chunks
    .filter((c) => opts.includeSeeds || !c.isSeed)
    .map((c) => c.chunkId);
}
