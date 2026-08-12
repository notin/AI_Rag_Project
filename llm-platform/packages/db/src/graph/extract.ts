// ─── LLM graph extraction ───────────────────────────────────────────────────
//
// One structured-output call per chunk, constrained to the closed vocabulary in
// vocab.ts. The prompt is a versioned file and the version is recorded against
// every chunk, so bumping the prompt re-extracts the corpus and an unchanged
// corpus costs nothing.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { extract } from '@app/llm-client';
import { logger } from '@app/shared';
import {
  entityTypeSchema,
  relationSchema,
  isValidEndpointPair,
  isSeedOwned,
  normalizeName,
  type EntityType,
  type Relation,
} from './vocab.js';

const log = logger.child({ module: 'graph:extract' });

/**
 * Bumping this re-extracts the whole corpus: the build ledger records the
 * version per chunk, so anything below the current one is stale. Old prompt
 * files are kept alongside for diffing and rollback.
 */
export const PROMPT_VERSION = 'extract-graph@v2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Structured output schema ───────────────────────────────────────────────
//
// Everything is nullable rather than optional: JSON-schema structured output
// is markedly more reliable when every property is always present.

const extractionSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      type: entityTypeSchema,
      aliases: z.array(z.string()).nullable(),
    }),
  ),
  relations: z.array(
    z.object({
      source: z.string(),
      relation: relationSchema,
      target: z.string(),
      method: z.string().nullable(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export type RawExtraction = z.infer<typeof extractionSchema>;

// ─── Cleaned output ─────────────────────────────────────────────────────────

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  aliases: string[];
}

export interface ExtractedRelation {
  sourceName: string;
  sourceType: EntityType;
  targetName: string;
  targetType: EntityType;
  relation: Relation;
  properties: Record<string, unknown>;
  confidence: number;
}

export interface ChunkExtraction {
  chunkId: string;
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

/** Relations below this are dropped — see rule 6 in the prompt. */
const MIN_CONFIDENCE = 0.6;

let cachedPrompt: string | null = null;

function loadPrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  const promptPath = path.resolve(
    __dirname,
    '../../prompts',
    `${PROMPT_VERSION}.md`,
  );
  cachedPrompt = fs.readFileSync(promptPath, 'utf-8');
  return cachedPrompt;
}

/**
 * Extract entities and relations from one chunk.
 *
 * Returns null when extraction fails after a retry. A single unparseable chunk
 * should cost you that chunk's edges, not the whole build — the caller counts
 * failures and reports them.
 */
export async function extractFromChunk(
  chunkId: string,
  text: string,
  opts: { model?: string } = {},
): Promise<ChunkExtraction | null> {
  const prompt = loadPrompt().replace('{{TEXT}}', text);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await extract(extractionSchema, {
        prompt,
        temperature: 0,
        ...(opts.model ? { model: opts.model } : {}),
      });
      return clean(chunkId, result.object as RawExtraction);
    } catch (err) {
      if (attempt === 2) {
        log.error(
          { chunkId, err: err instanceof Error ? err.message : String(err) },
          'Extraction failed after retry — skipping chunk',
        );
        return null;
      }
      log.warn({ chunkId }, 'Extraction failed, re-asking once');
    }
  }

  return null;
}

/**
 * Drop everything the model got structurally wrong before it reaches the
 * database: unknown entity references, mistyped endpoints, self-edges, and
 * low-confidence guesses.
 */
function clean(chunkId: string, raw: RawExtraction): ChunkExtraction {
  const entities: ExtractedEntity[] = [];
  const typeByName = new Map<string, EntityType>();

  for (const e of raw.entities) {
    const normalized = normalizeName(e.name);
    if (!normalized) continue;
    if (typeByName.has(normalized)) continue;
    typeByName.set(normalized, e.type);
    entities.push({
      name: e.name.trim(),
      type: e.type,
      aliases: (e.aliases ?? [])
        .map((a) => a.trim())
        .filter((a) => a && normalizeName(a) !== normalized),
    });
  }

  const relations: ExtractedRelation[] = [];
  const seen = new Set<string>();

  for (const r of raw.relations) {
    if (r.confidence < MIN_CONFIDENCE) continue;

    const sourceNorm = normalizeName(r.source);
    const targetNorm = normalizeName(r.target);
    if (!sourceNorm || !targetNorm) continue;

    // Rule 3: relations may only reference entities the model also declared.
    const sourceType = typeByName.get(sourceNorm);
    const targetType = typeByName.get(targetNorm);
    if (!sourceType || !targetType) {
      log.debug(
        { chunkId, relation: `${r.source} ${r.relation} ${r.target}` },
        'Dropped relation referencing an undeclared entity',
      );
      continue;
    }

    if (sourceNorm === targetNorm) continue;

    if (!isValidEndpointPair(r.relation, sourceType, targetType)) {
      log.debug(
        {
          chunkId,
          relation: `${sourceType}:${r.source} ${r.relation} ${targetType}:${r.target}`,
        },
        'Dropped relation with invalid endpoint types',
      );
      continue;
    }

    // The type chart is exhaustive here, so extraction can only add noise.
    if (isSeedOwned(r.relation, sourceType, targetType)) {
      log.debug(
        { chunkId, relation: `${r.source} ${r.relation} ${r.target}` },
        'Dropped type-vs-type effectiveness — the seeded chart owns it',
      );
      continue;
    }

    const key = `${sourceNorm}|${r.relation}|${targetNorm}`;
    if (seen.has(key)) continue;
    seen.add(key);

    relations.push({
      sourceName: r.source.trim(),
      sourceType,
      targetName: r.target.trim(),
      targetType,
      relation: r.relation,
      properties: r.method ? { method: r.method } : {},
      confidence: r.confidence,
    });
  }

  return { chunkId, entities, relations };
}
