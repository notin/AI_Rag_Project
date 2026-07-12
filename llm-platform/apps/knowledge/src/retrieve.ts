// ─── Hybrid retrieval (semantic + keyword, fused with RRF) ───────────────────
//
// Two retrievers see different things:
//   • semantic (pgvector <=>)  → meaning / paraphrase ("terminate my plan").
//   • keyword  (tsvector @@)   → exact tokens (codes, SKUs, rare names).
//
// We run both, then fuse their *rankings* with Reciprocal Rank Fusion (RRF)
// rather than their raw scores — cosine similarity and ts_rank aren't on the
// same scale, so comparing ranks is the robust move.
//
//   RRF(doc) = Σ_lists  1 / (k + rank_in_list)
//
// A chunk near the top of either list scores well; a chunk near the top of
// *both* wins. k (the RRF constant) damps the influence of low ranks.

import { semanticSearch, keywordSearch, type SearchResult } from '@app/db';

/** RRF damping constant. 60 is the value from the original RRF paper. */
const RRF_K = 60;

export interface RetrievedChunk extends SearchResult {
  /** Fused RRF score across the semantic + keyword arms. */
  rrfScore: number;
  /** Which arms surfaced this chunk (for debugging / eval). */
  sources: Array<'semantic' | 'keyword'>;
}

export interface HybridOptions {
  /** How many candidates to pull from each arm before fusing. */
  perArm?: number;
  /** How many fused candidates to return. */
  limit?: number;
}

/**
 * Run semantic + keyword search in parallel and fuse with RRF.
 * Returns the top `limit` candidates for the reranker to sharpen.
 */
export async function hybridRetrieve(
  query: string,
  opts: HybridOptions = {},
): Promise<RetrievedChunk[]> {
  const perArm = opts.perArm ?? 50;
  const limit = opts.limit ?? 50;

  const [semantic, keyword] = await Promise.all([
    semanticSearch(query, perArm),
    keywordSearch(query, perArm),
  ]);

  const fused = new Map<string, RetrievedChunk>();

  const fold = (list: SearchResult[], arm: 'semantic' | 'keyword') => {
    list.forEach((result, i) => {
      const rank = i + 1;
      const contribution = 1 / (RRF_K + rank);
      const existing = fused.get(result.chunkId);
      if (existing) {
        existing.rrfScore += contribution;
        existing.sources.push(arm);
      } else {
        fused.set(result.chunkId, {
          ...result,
          rrfScore: contribution,
          sources: [arm],
        });
      }
    });
  };

  fold(semantic, 'semantic');
  fold(keyword, 'keyword');

  return [...fused.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit);
}
