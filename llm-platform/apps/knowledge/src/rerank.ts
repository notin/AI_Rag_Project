// ─── Rerank stage ────────────────────────────────────────────────────────────
//
// Retrieval (hybrid) is tuned for *recall* — cast a wide net (~50 candidates).
// Reranking is tuned for *precision* — a cross-encoder reads the query against
// each candidate together (not as independent vectors) and reorders them, so we
// can keep only the best ~5 for the prompt. Fewer, better chunks = less noise
// for the generator and lower token cost.
//
// The concrete reranker sits behind the `Reranker` interface so it can be
// swapped (Cohere → Bedrock Rerank → a local cross-encoder) without touching
// the pipeline. If no Cohere key is configured we fall back to a passthrough
// that just trusts the RRF order — the system still works, just less sharply.

import { logger } from '@app/shared';
import type { RetrievedChunk } from './retrieve.js';

const log = logger.child({ module: 'rerank' });

export interface Reranker {
  readonly name: string;
  rerank(query: string, candidates: RetrievedChunk[], topN: number): Promise<RetrievedChunk[]>;
}

/** No-op reranker: keeps the incoming (RRF) order, truncates to topN. */
export class PassthroughReranker implements Reranker {
  readonly name = 'passthrough';
  async rerank(_query: string, candidates: RetrievedChunk[], topN: number) {
    return candidates.slice(0, topN);
  }
}

/** Cohere Rerank (hosted cross-encoder) via the REST API. */
export class CohereReranker implements Reranker {
  readonly name = 'cohere';
  constructor(
    private readonly apiKey: string,
    private readonly model = 'rerank-english-v3.0',
  ) {}

  async rerank(query: string, candidates: RetrievedChunk[], topN: number) {
    if (candidates.length === 0) return [];

    const res = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: candidates.map((c) => c.text),
        top_n: Math.min(topN, candidates.length),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Cohere rerank failed: ${res.status} ${body}`);
    }

    const data = (await res.json()) as {
      results: Array<{ index: number; relevance_score: number }>;
    };

    // Map Cohere's reordered indices back to our candidate objects, and
    // stash the relevance score into similarity for downstream visibility.
    return data.results.map((r) => ({
      ...candidates[r.index]!,
      similarity: r.relevance_score,
    }));
  }
}

/**
 * Pick a reranker from the environment. Cohere if COHERE_API_KEY is set,
 * otherwise a passthrough so the pipeline stays functional without a key.
 */
export function getReranker(): Reranker {
  const key = process.env.COHERE_API_KEY?.trim();
  if (key) {
    log.info('Using Cohere reranker');
    return new CohereReranker(key);
  }
  log.warn('COHERE_API_KEY not set — falling back to passthrough reranker');
  return new PassthroughReranker();
}
