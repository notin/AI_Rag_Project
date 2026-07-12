// ─── RAG pipeline: retrieve → rerank → generate ──────────────────────────────
// The single entry-point the HTTP layer (and future callers) use.

import { logger } from '@app/shared';
import { hybridRetrieve } from './retrieve.js';
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
}

export async function ask(query: string): Promise<AskResult> {
  const t0 = Date.now();

  const candidates = await hybridRetrieve(query, { limit: RETRIEVE_LIMIT });
  const top = await reranker.rerank(query, candidates, TOP_N);
  const result = await generateAnswer(query, top);

  log.info(
    {
      query,
      retrieved: candidates.length,
      used: top.length,
      reranker: reranker.name,
      reAsked: result.reAsked,
      ms: Date.now() - t0,
    },
    'ask complete',
  );

  return {
    ...result,
    reranker: reranker.name,
    retrieved: candidates.length,
    used: top.length,
  };
}
