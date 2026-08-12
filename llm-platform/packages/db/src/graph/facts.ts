// ─── Subgraph → citable facts ───────────────────────────────────────────────
//
// The precision half of the graph layer. For questions that resolve cleanly to
// entities, the model reads the relationships as structure instead of inferring
// them from prose — which is where directional facts ("X is super effective
// against Y") normally get flipped.
//
// Every fact carries the chunk that asserted it, so Stage 3 can cite a fact the
// same way it cites a passage. Seed facts carry no chunk: they are ground truth
// from the type chart rather than a claim made by the corpus.

import { sql } from 'drizzle-orm';
import { db } from '../client.js';
import { INVERSE_LABEL, type Relation } from './vocab.js';
import { renderFact } from './render.js';
import type { EdgeOrigin } from './schema.js';

export { renderFact, renderFactBlock } from './render.js';

export interface GraphFact {
  edgeId: string;
  sourceName: string;
  relation: Relation;
  targetName: string;
  properties: Record<string, unknown>;
  confidence: number;
  origin: EdgeOrigin;
  /** Chunks that asserted this fact. Empty for seeded ground truth. */
  chunkIds: string[];
  /** Rendered one-liner, ready to drop into a prompt. */
  line: string;
}

export interface FactsOptions {
  /** Cap the fact block — a 200-edge dump crowds out the actual passages. */
  maxFacts?: number;
  /**
   * Cap per leading entity.
   *
   * Without this, a single dense node eats the whole budget: each `type` carries
   * ~11 effectiveness edges, so a 40-fact block ordered purely by relevance
   * covers three entities exhaustively and says nothing about the rest of the
   * question. Breadth is worth more than depth in a fact block.
   */
  maxFactsPerEntity?: number;
  /** Only include edges where BOTH endpoints are in the entity set. */
  requireBothEndpoints?: boolean;
}

const DEFAULT_MAX_FACTS = 40;
const DEFAULT_MAX_FACTS_PER_ENTITY = 6;

/**
 * Fetch the edges among a set of entities.
 *
 * `entityIds` is treated as a RELEVANCE ORDER, not a set: callers pass seed
 * entities most-mentioned first. Facts are ranked by their best-placed
 * endpoint, so a question about Dragon leads with Dragon's edges instead of
 * burning the budget on whatever sorts first alphabetically. Ground truth wins
 * ties, so a seeded multiplier precedes an extracted claim about the same node.
 */
export async function graphFacts(
  entityIds: string[],
  opts: FactsOptions = {},
): Promise<GraphFact[]> {
  if (entityIds.length === 0) return [];

  const maxFacts = opts.maxFacts ?? DEFAULT_MAX_FACTS;
  const maxPerEntity = opts.maxFactsPerEntity ?? DEFAULT_MAX_FACTS_PER_ENTITY;
  const ids = sql.param(entityIds);

  // Sentinel rank for an endpoint that isn't in the relevance list at all.
  const UNRANKED = 1_000_000;

  const endpointFilter = opts.requireBothEndpoints
    ? sql`e.source_entity_id = ANY(${ids}::uuid[]) AND e.target_entity_id = ANY(${ids}::uuid[])`
    : sql`e.source_entity_id = ANY(${ids}::uuid[]) OR e.target_entity_id = ANY(${ids}::uuid[])`;

  const rows = await db.execute<{
    id: string;
    source_name: string;
    target_name: string;
    relation: Relation;
    properties: Record<string, unknown> | null;
    confidence: number;
    origin: EdgeOrigin;
    chunk_ids: string[] | null;
  }>(sql`
    WITH scored AS (
      SELECT
        e.id,
        s.canonical_name AS source_name,
        t.canonical_name AS target_name,
        e.relation,
        e.properties,
        e.confidence,
        e.origin,
        array_remove(array_agg(ec.chunk_id::text), NULL) AS chunk_ids,
        LEAST(
          COALESCE(array_position(${ids}::uuid[], e.source_entity_id), ${UNRANKED}),
          COALESCE(array_position(${ids}::uuid[], e.target_entity_id), ${UNRANKED})
        ) AS rank_pos,
        -- Whichever endpoint sits higher in the relevance order owns this fact
        -- for the per-entity cap.
        CASE
          WHEN COALESCE(array_position(${ids}::uuid[], e.source_entity_id), ${UNRANKED})
             <= COALESCE(array_position(${ids}::uuid[], e.target_entity_id), ${UNRANKED})
          THEN e.source_entity_id ELSE e.target_entity_id
        END AS lead_entity
      FROM edges e
      JOIN entities s ON s.id = e.source_entity_id
      JOIN entities t ON t.id = e.target_entity_id
      LEFT JOIN edge_chunks ec ON ec.edge_id = e.id
      WHERE ${endpointFilter}
      GROUP BY e.id, s.canonical_name, t.canonical_name, e.relation,
               e.properties, e.confidence, e.origin,
               e.source_entity_id, e.target_entity_id
    ),
    capped AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY lead_entity
        ORDER BY (origin = 'seed') DESC, confidence DESC, source_name ASC
      ) AS rn
      FROM scored
    )
    SELECT id, source_name, target_name, relation, properties, confidence,
           origin, chunk_ids
    FROM capped
    WHERE rn <= ${maxPerEntity}
    ORDER BY rank_pos ASC, (origin = 'seed') DESC, confidence DESC,
             source_name ASC
    LIMIT ${maxFacts}
  `);

  return [...rows].map((r) => {
    const row = r as {
      id: string;
      source_name: string;
      target_name: string;
      relation: Relation;
      properties: Record<string, unknown> | null;
      confidence: number;
      origin: EdgeOrigin;
      chunk_ids: string[] | null;
    };
    const properties = row.properties ?? {};
    const chunkIds = row.chunk_ids ?? [];

    return {
      edgeId: row.id,
      sourceName: row.source_name,
      relation: row.relation,
      targetName: row.target_name,
      properties,
      confidence: row.confidence,
      origin: row.origin,
      chunkIds,
      line: renderFact({
        sourceName: row.source_name,
        relation: row.relation,
        targetName: row.target_name,
        properties,
        chunkIds,
      }),
    };
  });
}

/** Human-readable label for an edge being read backwards. Display only. */
export function inverseLabel(relation: Relation): string {
  return INVERSE_LABEL[relation];
}
