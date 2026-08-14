// ─── RAG pipeline: retrieve → rerank → generate ──────────────────────────────
// The single entry-point the HTTP layer (and future callers) use.

import { logger } from '@app/shared';
import { hybridRetrieve, retrievalConfig } from './retrieve.js';
import { getReranker } from './rerank.js';
import { generateAnswer, type AnswerResult } from './answer.js';

const log = logger.child({ module: 'pipeline' });
const reranker = getReranker();

/** How many candidates hybrid retrieval returns before reranking. */
const RETRIEVE_LIMIT = 50;
/** How many chunks survive rerank and get fed to the generator. */
const TOP_N = 5;

export interface AskResult extends AnswerResult {
  reranker: string;
  retrieved: number;
  used: number;
  /**
   * What the graph layer contributed to this request. Reported so a caller (or
   * a Stage 6 eval) can tell an answer the graph shaped from one it didn't.
   */
  graph: {
    /** Chunks the graph arm added that the vector arm had not already returned. */
    expanded: number;
    facts: number;
    matchups: number;
    /** Entities the seed chunks resolved to. Zero means the graph had no purchase. */
    seedEntities: number;
  };
}

export async function ask(query: string): Promise<AskResult> {
  const t0 = Date.now();

  const { chunks, facts, matchups, stats } = await hybridRetrieve(query, {
    limit: RETRIEVE_LIMIT,
  });

  // Only the passages are reranked. Facts and matchups skip it by design: the
  // cross-encoder scores prose relevance, and a one-line edge assertion loses
  // that comparison to a paragraph every time despite being the more precise
  // answer. They are already capped and relevance-ordered by the graph layer.
  const top = await reranker.rerank(query, chunks, TOP_N);
  const result = await generateAnswer(query, top, { facts, matchups });

  log.info(
    {
      query,
      retrieved: chunks.length,
      used: top.length,
      arms: stats,
      graphArm: retrievalConfig.graphArm,
      weights: retrievalConfig.weights,
      reranker: reranker.name,
      reAsked: result.reAsked,
      ms: Date.now() - t0,
    },
    'ask complete',
  );

  return {
    ...result,
    reranker: reranker.name,
    retrieved: chunks.length,
    used: top.length,
    graph: {
      expanded: stats.graph,
      facts: facts.length,
      matchups: matchups.length,
      seedEntities: stats.seedEntities,
    },
  };
}
