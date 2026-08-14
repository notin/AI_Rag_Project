// ─── Hybrid retrieval (semantic + keyword + graph, fused with RRF) ───────────
//
// Three retrievers see different things:
//   • semantic (pgvector <=>)  → meaning / paraphrase ("terminate my plan").
//   • keyword  (tsvector @@)   → exact tokens (codes, SKUs, rare names).
//   • graph    (graphExpand)   → chunks no query term reaches, found by walking
//     relationships out from what the semantic arm already matched. This is the
//     arm that answers multi-hop questions: the passage naming the answer often
//     shares no vocabulary with the question.
//
// We run them, then fuse their *rankings* with Reciprocal Rank Fusion (RRF)
// rather than their raw scores — cosine similarity, ts_rank and hop distance
// aren't on the same scale, so comparing ranks is the robust move.
//
//   RRF(doc) = Σ_lists  weight_list / (k + rank_in_list)
//
// A chunk near the top of any list scores well; a chunk near the top of
// *several* wins. k (the RRF constant) damps the influence of low ranks, and
// the per-arm weight lets one arm be turned down or off without touching the
// fusion itself — which is how the graph arm gets A/B'd against the two-arm
// baseline.

import {
  semanticSearch,
  keywordSearch,
  graphRetrieve,
  type GraphFact,
  type Matchup,
} from '@app/db';
import { logger } from '@app/shared';

const log = logger.child({ module: 'retrieve' });

/** RRF damping constant. 60 is the value from the original RRF paper. */
const RRF_K = 60;

export type Arm = 'semantic' | 'keyword' | 'graph';

export interface RetrievedChunk {
  chunkId: string;
  documentTitle: string;
  text: string;
  /** Fused RRF score across the arms that returned this chunk. */
  rrfScore: number;
  /** Which arms surfaced this chunk (for debugging / eval). */
  sources: Arm[];
  // The rest are arm-specific and absent when that arm didn't return the chunk.
  documentId?: string;
  ordinal?: number;
  similarity?: number;
  /** Hops from the nearest seed chunk. Only set by the graph arm. */
  hops?: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Retrieval knobs, resolved once from the environment.
 *
 * The graph settings are the A/B surface: `GRAPH_ARM_ENABLED=false` reproduces
 * the two-arm baseline exactly, and the two sub-toggles (`RRF_WEIGHT_GRAPH=0`,
 * `GRAPH_FACTS_ENABLED=false`) isolate the expansion arm from the fact block so
 * a win can be attributed to one or the other.
 */
export const retrievalConfig = {
  weights: {
    semantic: envNumber('RRF_WEIGHT_SEMANTIC', 1),
    keyword: envNumber('RRF_WEIGHT_KEYWORD', 1),
    graph: envNumber('RRF_WEIGHT_GRAPH', 1),
  },
  graphArm: envFlag('GRAPH_ARM_ENABLED', true),
  graphFacts: envFlag('GRAPH_FACTS_ENABLED', true),
  /** How many semantic hits seed the traversal. */
  graphSeedK: envNumber('GRAPH_SEED_K', 5),
  graphMaxHops: envNumber('GRAPH_MAX_HOPS', 2),
  graphMaxNodes: envNumber('GRAPH_MAX_NODES', 32),
  graphMaxNodesPerHop: envNumber('GRAPH_MAX_NODES_PER_HOP', 12),
  graphMaxWalkSeeds: envNumber('GRAPH_MAX_WALK_SEEDS', 12),
  /**
   * Corroboration bar for a chunk the graph adds. The library default is 1
   * ("shares anything"), which on a densely cross-referenced corpus returns
   * nearly everything; the service asks for 2 so the arm contributes evidence
   * rather than volume.
   */
  graphMinSharedEntities: envNumber('GRAPH_MIN_SHARED_ENTITIES', 2),
} as const;

export interface HybridOptions {
  /** How many candidates to pull from each arm before fusing. */
  perArm?: number;
  /** How many fused candidates to return. */
  limit?: number;
}

export interface HybridResult {
  /** The fused candidate pool, best first. */
  chunks: RetrievedChunk[];
  /** Relationships among the entities the query resolved to. */
  facts: GraphFact[];
  /** Defensive matchups derived from `has_type` × the type chart. */
  matchups: Matchup[];
  stats: {
    semantic: number;
    keyword: number;
    /** Chunks the graph arm added that the vector arm had not already returned. */
    graph: number;
    seedEntities: number;
  };
}

/**
 * Run the arms, fuse with weighted RRF, and return the top `limit` candidates
 * for the reranker to sharpen — plus the graph facts the generator will put
 * above the passages.
 */
export async function hybridRetrieve(
  query: string,
  opts: HybridOptions = {},
): Promise<HybridResult> {
  const perArm = opts.perArm ?? 50;
  const limit = opts.limit ?? 50;
  const { weights } = retrievalConfig;

  const [semantic, keyword] = await Promise.all([
    semanticSearch(query, perArm),
    keywordSearch(query, perArm),
  ]);

  // The graph arm walks out from what the semantic arm found, so it can't run
  // in the same Promise.all — it needs those results first.
  const wantsExpansion = retrievalConfig.graphArm && weights.graph > 0;
  const wantsFacts = retrievalConfig.graphArm && retrievalConfig.graphFacts;

  let graph: Array<{
    chunkId: string;
    documentTitle: string;
    text: string;
    hops: number;
  }> = [];
  let facts: GraphFact[] = [];
  let matchups: Matchup[] = [];
  let seedEntities = 0;

  if ((wantsExpansion || wantsFacts) && semantic.length > 0) {
    // The graph is an enhancement, not a dependency: semantic + keyword can
    // still answer the question. A failure here (most often a cold-pool connect
    // timeout) degrades to the two-arm baseline instead of failing the request.
    try {
      // Hand over the hits we already have rather than letting graphRetrieve
      // embed the query a second time.
      const expansion = await graphRetrieve(query, {
        seeds: semantic.slice(0, retrievalConfig.graphSeedK),
        maxHops: retrievalConfig.graphMaxHops,
        maxNodes: retrievalConfig.graphMaxNodes,
        maxNodesPerHop: retrievalConfig.graphMaxNodesPerHop,
        maxWalkSeeds: retrievalConfig.graphMaxWalkSeeds,
        minSharedEntities: retrievalConfig.graphMinSharedEntities,
        includeFacts: wantsFacts,
      });

      seedEntities = expansion.seedEntities.length;
      if (wantsExpansion) graph = expansion.expanded;
      facts = expansion.facts;
      matchups = expansion.matchups;
    } catch (err) {
      log.warn({ err }, 'graph arm failed — degrading to semantic + keyword');
      graph = [];
      facts = [];
      matchups = [];
    }
  }

  const fused = new Map<string, RetrievedChunk>();

  const fold = (
    list: Array<{
      chunkId: string;
      documentTitle: string;
      text: string;
      documentId?: string;
      ordinal?: number;
      similarity?: number;
      hops?: number;
    }>,
    arm: Arm,
    weight: number,
  ) => {
    if (weight <= 0) return;

    list.forEach((result, i) => {
      const rank = i + 1;
      const contribution = weight / (RRF_K + rank);
      const existing = fused.get(result.chunkId);

      if (existing) {
        existing.rrfScore += contribution;
        existing.sources.push(arm);
        // Keep arm-specific detail from whichever arm happens to carry it.
        existing.hops ??= result.hops;
        existing.similarity ??= result.similarity;
      } else {
        fused.set(result.chunkId, {
          ...result,
          rrfScore: contribution,
          sources: [arm],
        });
      }
    });
  };

  fold(semantic, 'semantic', weights.semantic);
  fold(keyword, 'keyword', weights.keyword);
  fold(graph, 'graph', weights.graph);

  const chunks = [...fused.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit);

  return {
    chunks,
    facts,
    matchups,
    stats: {
      semantic: semantic.length,
      keyword: keyword.length,
      graph: graph.length,
      seedEntities,
    },
  };
}
