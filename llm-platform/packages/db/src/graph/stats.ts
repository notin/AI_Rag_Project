// ─── Graph summary counts ───────────────────────────────────────────────────
// Used by the build script's report and by the "run it twice, get identical
// numbers" idempotency check.

import { sql } from 'drizzle-orm';
import { db } from '../client.js';

export interface GraphStats {
  entities: number;
  entitiesByType: Array<{ type: string; count: number }>;
  edges: number;
  edgesByRelation: Array<{ relation: string; origin: string; count: number }>;
  mentions: number;
  /** Edges with no chunk backing them. Non-seed entries here are a bug. */
  edgesWithoutProvenance: number;
}

export async function graphStats(): Promise<GraphStats> {
  const totals = await db.execute<{
    entities: number;
    edges: number;
    mentions: number;
    orphan_edges: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM entities)        AS entities,
      (SELECT count(*)::int FROM edges)           AS edges,
      (SELECT count(*)::int FROM chunk_entities)  AS mentions,
      (SELECT count(*)::int FROM edges e
        WHERE e.origin <> 'seed'
          AND NOT EXISTS (
            SELECT 1 FROM edge_chunks ec WHERE ec.edge_id = e.id
          ))                                       AS orphan_edges
  `);

  const byType = await db.execute<{ type: string; count: number }>(sql`
    SELECT type, count(*)::int AS count
    FROM entities GROUP BY type ORDER BY count DESC, type ASC
  `);

  const byRelation = await db.execute<{
    relation: string;
    origin: string;
    count: number;
  }>(sql`
    SELECT relation, origin, count(*)::int AS count
    FROM edges GROUP BY relation, origin
    ORDER BY count DESC, relation ASC
  `);

  const t = [...totals][0] as {
    entities: number;
    edges: number;
    mentions: number;
    orphan_edges: number;
  };

  return {
    entities: t.entities,
    entitiesByType: [...byType].map((r) => r as { type: string; count: number }),
    edges: t.edges,
    edgesByRelation: [...byRelation].map(
      (r) => r as { relation: string; origin: string; count: number },
    ),
    mentions: t.mentions,
    edgesWithoutProvenance: t.orphan_edges,
  };
}
