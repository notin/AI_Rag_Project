// ─── Answer generation (assemble → generate → validate → re-ask) ─────────────
//
// This is the "LLM service" core: a typed contract with a bounded re-ask loop.
//
//   1. Assemble the context into labelled, citable sources: graph facts (f1,
//      f2, …), derived matchups (m1, …), then the reranked passages (c1, …).
//   2. Ask the model (via the gateway) for a STRUCTURED answer using a Zod
//      schema — `generateObject` guarantees the shape or throws.
//   3. Validate the *content*: every cited label must exist in the context.
//   4. If the shape is invalid or a citation is bogus, RE-ASK ONCE with a
//      correction note. This service-level retry is distinct from the gateway's
//      provider-level retry (that handles transport/provider failures; this
//      handles "the model didn't follow the grounding contract").
//
// Structure goes above prose deliberately: directional relationships ("X is
// super effective against Y") are exactly what a model flips when it has to
// infer them from a paragraph. Facts and matchups carry chunk ids of their own,
// so they cite through the same label check as passages — the grounding rule
// needs no special case for them.
//
// Prompts are stored as versioned files (prompts/answer@vN.md) and the version
// used is returned + logged, so prompt changes are auditable.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { extract } from '@app/llm-client';
import { logger } from '@app/shared';
import { renderFact, renderMatchup, type GraphFact, type Matchup } from '@app/db';
import type { RetrievedChunk } from './retrieve.js';

const log = logger.child({ module: 'answer' });
const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT_VERSION = 'answer@v2';
const systemPrompt = readFileSync(
  resolve(__dirname, `../prompts/${PROMPT_VERSION}.md`),
  'utf-8',
);

// The typed contract the model must satisfy.
const AnswerSchema = z.object({
  answer: z.string().describe('The grounded answer, or the exact decline sentence.'),
  citations: z
    .array(z.string())
    .describe(
      'Source labels actually used, e.g. ["c1","f2","m1"]. Empty if declining.',
    ),
});

export type CitationKind = 'passage' | 'fact' | 'matchup';

export interface Citation {
  label: string;
  kind: CitationKind;
  /** Human-readable origin: a document title, or the graph for derived lines. */
  documentTitle: string;
  /**
   * Chunks backing this citation. Empty only for ground-truth type-chart facts,
   * which the corpus never asserted because they were seeded.
   */
  chunkIds: string[];
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  promptVersion: string;
  reAsked: boolean;
}

export interface GraphContext {
  facts?: GraphFact[];
  matchups?: Matchup[];
}

/**
 * Build the labelled context block and a label→source lookup.
 *
 * Facts and matchups are re-rendered without their `[chunk:…]` provenance
 * suffix: the bracketed label at the head of each line is the citable handle
 * here, and two competing bracket forms in one line invites the model to cite
 * the wrong one.
 */
function assembleContext(chunks: RetrievedChunk[], graph: GraphContext) {
  const byLabel = new Map<string, Citation>();
  const sections: string[] = [];

  const facts = graph.facts ?? [];
  if (facts.length > 0) {
    const lines = facts.map((f, i) => {
      const label = `f${i + 1}`;
      byLabel.set(label, {
        label,
        kind: 'fact',
        documentTitle:
          f.origin === 'seed'
            ? 'knowledge graph (type chart)'
            : 'knowledge graph',
        chunkIds: f.chunkIds,
      });
      const line = renderFact({
        sourceName: f.sourceName,
        relation: f.relation,
        targetName: f.targetName,
        properties: f.properties,
      });
      return `[${label}] ${line}`;
    });
    sections.push(`Knowledge-graph facts:\n\n${lines.join('\n')}`);
  }

  const matchups = graph.matchups ?? [];
  if (matchups.length > 0) {
    const lines = matchups.map((m, i) => {
      const label = `m${i + 1}`;
      byLabel.set(label, {
        label,
        kind: 'matchup',
        documentTitle: 'knowledge graph (derived matchup)',
        chunkIds: m.chunkIds,
      });
      const line = renderMatchup(m.pokemonName, m.typing, m.buckets);
      return `[${label}] ${line}`;
    });
    sections.push(
      `Derived type matchups (computed across the full type chart — ` +
        `authoritative, and preferred over reasoning from individual facts above):` +
        `\n\n${lines.join('\n')}`,
    );
  }

  const passages = chunks.map((c, i) => {
    const label = `c${i + 1}`;
    byLabel.set(label, {
      label,
      kind: 'passage',
      documentTitle: c.documentTitle,
      chunkIds: [c.chunkId],
    });
    return `[${label}] (source: ${c.documentTitle})\n${c.text}`;
  });
  sections.push(`Passages:\n\n${passages.join('\n\n')}`);

  return { context: sections.join('\n\n'), byLabel };
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
  graph: GraphContext = {},
): Promise<AnswerResult> {
  const { context, byLabel } = assembleContext(chunks, graph);
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
    .map((label: string) => byLabel.get(label)!);

  log.info(
    {
      promptVersion: PROMPT_VERSION,
      reAsked,
      citationCount: citations.length,
      // Which kinds of source the answer leaned on — the signal for whether the
      // graph block is earning its place in the context window.
      citedKinds: citations.map((c) => c.kind),
    },
    'Answer generated',
  );

  return { answer: object.answer, citations, promptVersion: PROMPT_VERSION, reAsked };
}
