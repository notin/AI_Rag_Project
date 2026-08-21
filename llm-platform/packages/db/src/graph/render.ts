// ─── Fact rendering ─────────────────────────────────────────────────────────
// Pure — no database import — so prompt formatting can be unit-tested without
// a live connection.

import type { Relation } from './vocab.js';

export interface RenderableFact {
  sourceName: string;
  relation: Relation;
  targetName: string;
  properties?: Record<string, unknown>;
  chunkIds?: string[];
}

/**
 * Render one edge as a single line.
 *
 *   Ice --super_effective_against(2x)--> Dragon [chunk:8f3a1c2d]
 *   Eevee --evolves_into(Thunder Stone)--> Jolteon [chunk:4b19e0aa]
 *
 * Chunk ids are truncated to 8 characters: enough for a human reading the debug
 * output to match a citation, short enough not to eat the context window.
 */
export function renderFact(fact: RenderableFact): string {
  const qualifier = factQualifier(fact.properties ?? {});
  const label = `${fact.relation}${qualifier ? `(${qualifier})` : ''}`;
  const chunkIds = fact.chunkIds ?? [];
  const citation = chunkIds.length
    ? ` [${chunkIds.map((id) => `chunk:${id.slice(0, 8)}`).join(' ')}]`
    : '';
  return `${fact.sourceName} --${label}--> ${fact.targetName}${citation}`;
}

function factQualifier(properties: Record<string, unknown>): string {
  // Multiplier first: for type effectiveness it's the fact that matters, and
  // "0x" must survive the check that a bare truthiness test would swallow.
  if (typeof properties.multiplier === 'number') {
    return `${properties.multiplier}x`;
  }
  if (typeof properties.method === 'string' && properties.method) {
    return properties.method;
  }
  return '';
}

/**
 * Render a fact block for a prompt context. Returns an empty string when there
 * is nothing to say, so the caller drops the section entirely rather than
 * emitting a bare header the model will try to interpret.
 */
export function renderFactBlock(facts: Array<{ line: string }>): string {
  if (facts.length === 0) return '';
  return facts.map((f) => f.line).join('\n');
}
