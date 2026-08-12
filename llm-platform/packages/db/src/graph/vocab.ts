// ─── Graph vocabulary ───────────────────────────────────────────────────────
//
// The closed set of entity types and relations. This is the contract shared by
// the LLM extraction schema, the traversal filter, and the fact renderer — so
// an invented relation is a type error at extraction time rather than a silent
// orphan edge nobody ever traverses.

import { z } from 'zod';

// ─── Entity types ───────────────────────────────────────────────────────────

export const ENTITY_TYPES = [
  'pokemon',
  'type',
  'move',
  'ability',
  'item',
  'region',
  'group',
] as const;

export const entityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = (typeof ENTITY_TYPES)[number];

// ─── Relations ──────────────────────────────────────────────────────────────
//
// Every edge is stored in ONE direction only and traversed in both. Storing
// inverses as separate rows doubles the write path and guarantees they drift.

export const RELATIONS = [
  'evolves_into',
  'has_type',
  'super_effective_against',
  'not_very_effective_against',
  'no_effect_on',
  'learns_move',
  'has_ability',
  'found_in',
  'member_of',
  'regional_variant_of',
  'mega_evolves_into',
] as const;

export const relationSchema = z.enum(RELATIONS);
export type Relation = (typeof RELATIONS)[number];

/**
 * Human-readable label for an edge traversed backwards. Rendering only —
 * no inverse row is ever written.
 */
export const INVERSE_LABEL: Record<Relation, string> = {
  evolves_into: 'evolves_from',
  has_type: 'is_type_of',
  super_effective_against: 'weak_to',
  not_very_effective_against: 'resists',
  no_effect_on: 'immune_to',
  learns_move: 'learned_by',
  has_ability: 'ability_of',
  found_in: 'home_of',
  member_of: 'has_member',
  regional_variant_of: 'has_variant',
  mega_evolves_into: 'mega_evolves_from',
};

/** Which endpoint types a relation is allowed to connect. */
export const RELATION_ENDPOINTS: Record<
  Relation,
  { source: readonly EntityType[]; target: readonly EntityType[] }
> = {
  evolves_into: { source: ['pokemon'], target: ['pokemon'] },
  has_type: { source: ['pokemon'], target: ['type'] },
  super_effective_against: { source: ['type', 'move'], target: ['type'] },
  not_very_effective_against: { source: ['type', 'move'], target: ['type'] },
  no_effect_on: { source: ['type', 'move'], target: ['type'] },
  learns_move: { source: ['pokemon'], target: ['move'] },
  has_ability: { source: ['pokemon'], target: ['ability'] },
  found_in: { source: ['pokemon'], target: ['region'] },
  member_of: { source: ['pokemon'], target: ['group'] },
  regional_variant_of: { source: ['pokemon'], target: ['pokemon'] },
  mega_evolves_into: { source: ['pokemon'], target: ['pokemon'] },
};

/**
 * Reject an edge whose endpoints don't match the relation's declared types.
 * Extraction models happily emit `Pikachu --has_type--> Raichu`; this is the
 * cheapest place to catch it.
 */
export function isValidEndpointPair(
  relation: Relation,
  sourceType: EntityType,
  targetType: EntityType,
): boolean {
  const spec = RELATION_ENDPOINTS[relation];
  return (
    spec.source.includes(sourceType) && spec.target.includes(targetType)
  );
}

/**
 * Relations where the seeded type chart is the complete and only authority.
 *
 * A move being strong against a type is fair game for extraction, but
 * type-vs-type effectiveness is fully covered by TYPE_CHART, so anything
 * extraction adds there can only be noise. Measured on the first build of the
 * Pokémon corpus: 10 of 10 type→type effectiveness edges the model produced
 * were wrong — inverted directions (`Poison not_very_effective_against Fairy`,
 * which is backwards and 2x), and resistances misreported as immunities
 * (`Electric not_very_effective_against Ground`, which is 0x).
 */
const SEED_OWNED_RELATIONS = new Set<Relation>([
  'super_effective_against',
  'not_very_effective_against',
  'no_effect_on',
]);

/**
 * True when this triple falls inside the seeded chart's authority and must be
 * discarded rather than merged.
 */
export function isSeedOwned(
  relation: Relation,
  sourceType: EntityType,
  targetType: EntityType,
): boolean {
  return (
    SEED_OWNED_RELATIONS.has(relation) &&
    sourceType === 'type' &&
    targetType === 'type'
  );
}

// ─── Name normalization ─────────────────────────────────────────────────────

/**
 * Collapse a display name to a stable lookup key.
 *
 * Deliberately keeps ♀ / ♂ — Nidoran♀ and Nidoran♂ are different Pokémon and
 * stripping the symbol silently merges them. Everything else that varies by
 * transcription (accents, apostrophes, periods, hyphens, casing, whitespace)
 * gets flattened.
 *
 *   "Farfetch'd"    -> "farfetchd"
 *   "Mr. Mime"      -> "mr mime"
 *   "Porygon-Z"     -> "porygon z"
 *   "Flabébé"       -> "flabebe"
 *   "Nidoran♀"      -> "nidoran♀"
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/['\u2018\u2019`]/g, '') // apostrophes vanish, not become spaces
    .replace(/[^a-z0-9\u2640\u2642]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Stable key for deduping a (type, name) pair within a batch. */
export function entityKey(type: EntityType, name: string): string {
  return `${type}:${normalizeName(name)}`;
}
