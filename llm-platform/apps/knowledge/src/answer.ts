// ─── Answer generation (assemble → generate → validate → re-ask) ─────────────
//
// This is the "LLM service" core: a typed contract with a bounded re-ask loop.
//
//   1. Assemble the reranked chunks into a labelled context block (c1, c2, …).
//   2. Ask the model (via the gateway) for a STRUCTURED answer using a Zod
//      schema — `generateObject` guarantees the shape or throws.
//   3. Validate the *content*: every cited label must exist in the context.
//   4. If the shape is invalid or a citation is bogus, RE-ASK ONCE with a
//      correction note. This service-level retry is distinct from the gateway's
//      provider-level retry (that handles transport/provider failures; this
//      handles "the model didn't follow the grounding contract").
//
// Prompts are stored as versioned files (prompts/answer@vN.md) and the version
// used is returned + logged, so prompt changes are auditable.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { extract } from '@app/llm-client';
import { logger } from '@app/shared';
import type { RetrievedChunk } from './retrieve.js';

const log = logger.child({ module: 'answer' });
const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT_VERSION = 'answer@v1';
const systemPrompt = readFileSync(
  resolve(__dirname, `../prompts/${PROMPT_VERSION}.md`),
  'utf-8',
);

// The typed contract the model must satisfy.
const AnswerSchema = z.object({
  answer: z.string().describe('The grounded answer, or the exact decline sentence.'),
  citations: z
    .array(z.string())
    .describe('Source labels actually used, e.g. ["c1","c3"]. Empty if declining.'),
});

export interface Citation {
  label: string;
  chunkId: string;
  documentTitle: string;
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  promptVersion: string;
  reAsked: boolean;
}

/** Build the labelled context block and a label→chunk lookup. */
function assembleContext(chunks: RetrievedChunk[]) {
  const byLabel = new Map<string, RetrievedChunk>();
  const blocks = chunks.map((c, i) => {
    const label = `c${i + 1}`;
    byLabel.set(label, c);
    return `[${label}] (source: ${c.documentTitle})\n${c.text}`;
  });
  return { context: blocks.join('\n\n'), byLabel };
}

function buildPrompt(query: string, context: string, correction?: string): string {
  return [
    `Context:\n\n${context}`,
    '---',
    `Question: ${query}`,
    correction ? `\nIMPORTANT — your previous answer was rejected: ${correction}\nTry again, following the rules exactly.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Generate a grounded, cited answer from reranked chunks.
 * Re-asks at most once if the model breaks the citation contract.
 */
export async function generateAnswer(
  query: string,
  chunks: RetrievedChunk[],
): Promise<AnswerResult> {
  const { context, byLabel } = assembleContext(chunks);
  const validLabels = new Set(byLabel.keys());

  type Answer = z.infer<typeof AnswerSchema>;
  const attempt = async (correction?: string): Promise<Answer> => {
    const res = await extract(AnswerSchema, {
      system: systemPrompt,
      prompt: buildPrompt(query, context, correction),
      temperature: 0.2,
    });
    return res.object as Answer;
  };

  // ── First attempt ────────────────────────────────────────────────────
  let object = await attempt();
  let reAsked = false;

  // Validate citations against the actual context labels.
  let bogus = object.citations.filter((c) => !validLabels.has(c));

  if (bogus.length > 0) {
    // ── Re-ask once ──────────────────────────────────────────────────
    reAsked = true;
    log.warn({ bogus }, 'Model cited unknown labels — re-asking once');
    const correction = `You cited ${JSON.stringify(bogus)}, which are not valid source labels. Only cite labels present in the context (${[...validLabels].join(', ')}).`;
    object = await attempt(correction);
    bogus = object.citations.filter((c) => !validLabels.has(c));
  }

  // After the single retry, drop any still-invalid citations rather than
  // surfacing bogus ids to the caller.
  const citations: Citation[] = object.citations
    .filter((label: string) => validLabels.has(label))
    .map((label: string) => {
      const chunk = byLabel.get(label)!;
      return { label, chunkId: chunk.chunkId, documentTitle: chunk.documentTitle };
    });

  log.info(
    { promptVersion: PROMPT_VERSION, reAsked, citationCount: citations.length },
    'Answer generated',
  );

  return { answer: object.answer, citations, promptVersion: PROMPT_VERSION, reAsked };
}
