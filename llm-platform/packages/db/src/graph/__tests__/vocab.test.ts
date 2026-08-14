import { describe, it, expect } from 'vitest';
import {
  normalizeName,
  entityKey,
  isValidEndpointPair,
  isSeedOwned,
  INVERSE_LABEL,
  RELATIONS,
  WALK_RELATIONS,
} from '../vocab.js';

describe('normalizeName', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeName('  Pikachu  ')).toBe('pikachu');
    expect(normalizeName('PIKACHU')).toBe('pikachu');
    expect(normalizeName('Mr.   Mime')).toBe('mr mime');
  });

  it('folds punctuation that varies by transcription', () => {
    expect(normalizeName("Farfetch'd")).toBe('farfetchd');
    expect(normalizeName('Farfetch\u2019d')).toBe('farfetchd'); // curly apostrophe
    expect(normalizeName('Mr. Mime')).toBe('mr mime');
    expect(normalizeName('Porygon-Z')).toBe('porygon z');
    expect(normalizeName('Type: Null')).toBe('type null');
  });

  it('strips diacritics', () => {
    expect(normalizeName('Flabébé')).toBe('flabebe');
    expect(normalizeName('Pokémon')).toBe('pokemon');
  });

  it('keeps gender symbols — they distinguish real species', () => {
    expect(normalizeName('Nidoran♀')).toBe('nidoran♀');
    expect(normalizeName('Nidoran♂')).toBe('nidoran♂');
    expect(normalizeName('Nidoran♀')).not.toBe(normalizeName('Nidoran♂'));
  });

  it('keeps genuinely different names apart', () => {
    expect(normalizeName('Raichu')).not.toBe(normalizeName('Pikachu'));
    expect(normalizeName('Alolan Raichu')).not.toBe(normalizeName('Raichu'));
  });

  it('returns empty string for input with no usable characters', () => {
    expect(normalizeName('   ')).toBe('');
    expect(normalizeName('---')).toBe('');
  });
});

describe('entityKey', () => {
  it('separates same-named entities of different types', () => {
    expect(entityKey('type', 'Fire')).not.toBe(entityKey('move', 'Fire'));
  });

  it('is stable across spelling variants', () => {
    expect(entityKey('pokemon', 'Mr. Mime')).toBe(
      entityKey('pokemon', 'mr mime'),
    );
  });
});

describe('isValidEndpointPair', () => {
  it('accepts correctly typed endpoints', () => {
    expect(isValidEndpointPair('has_type', 'pokemon', 'type')).toBe(true);
    expect(isValidEndpointPair('evolves_into', 'pokemon', 'pokemon')).toBe(true);
    expect(
      isValidEndpointPair('super_effective_against', 'type', 'type'),
    ).toBe(true);
  });

  it('rejects the mistakes extraction actually makes', () => {
    // "Pikachu is the Electric type" -> pokemon has_type pokemon
    expect(isValidEndpointPair('has_type', 'pokemon', 'pokemon')).toBe(false);
    // types don't evolve
    expect(isValidEndpointPair('evolves_into', 'type', 'type')).toBe(false);
    expect(isValidEndpointPair('found_in', 'region', 'pokemon')).toBe(false);
  });
});

describe('isSeedOwned', () => {
  it('claims type-vs-type effectiveness for the seeded chart', () => {
    expect(isSeedOwned('super_effective_against', 'type', 'type')).toBe(true);
    expect(isSeedOwned('not_very_effective_against', 'type', 'type')).toBe(true);
    expect(isSeedOwned('no_effect_on', 'type', 'type')).toBe(true);
  });

  it('leaves move-vs-type effectiveness to extraction', () => {
    expect(isSeedOwned('super_effective_against', 'move', 'type')).toBe(false);
  });

  it('does not claim unrelated relations', () => {
    expect(isSeedOwned('has_type', 'pokemon', 'type')).toBe(false);
    expect(isSeedOwned('evolves_into', 'pokemon', 'pokemon')).toBe(false);
  });
});

describe('INVERSE_LABEL', () => {
  it('covers every relation, so rendering a backwards edge never crashes', () => {
    for (const relation of RELATIONS) {
      expect(INVERSE_LABEL[relation]).toBeTruthy();
    }
  });
});

describe('WALK_RELATIONS', () => {
  it('is a subset of RELATIONS and excludes the type chart', () => {
    const all = new Set<string>(RELATIONS);
    for (const relation of WALK_RELATIONS) {
      expect(all.has(relation)).toBe(true);
    }
    expect(WALK_RELATIONS).not.toContain('super_effective_against');
    expect(WALK_RELATIONS).not.toContain('not_very_effective_against');
    expect(WALK_RELATIONS).not.toContain('no_effect_on');
  });
});
