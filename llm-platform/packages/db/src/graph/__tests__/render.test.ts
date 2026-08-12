import { describe, it, expect } from 'vitest';
import { renderFact, renderFactBlock } from '../render.js';

describe('renderFact', () => {
  it('renders a bare edge', () => {
    expect(
      renderFact({
        sourceName: 'Pikachu',
        relation: 'has_type',
        targetName: 'Electric',
      }),
    ).toBe('Pikachu --has_type--> Electric');
  });

  it('renders the effectiveness multiplier as the qualifier', () => {
    expect(
      renderFact({
        sourceName: 'Ice',
        relation: 'super_effective_against',
        targetName: 'Dragon',
        properties: { multiplier: 2 },
      }),
    ).toBe('Ice --super_effective_against(2x)--> Dragon');
  });

  it('renders a 0x immunity rather than dropping it', () => {
    // 0 is falsy; a truthiness check here would silently render immunities as
    // unqualified edges, which reads as "deals normal damage".
    expect(
      renderFact({
        sourceName: 'Dragon',
        relation: 'no_effect_on',
        targetName: 'Fairy',
        properties: { multiplier: 0 },
      }),
    ).toBe('Dragon --no_effect_on(0x)--> Fairy');
  });

  it('renders an evolution method', () => {
    expect(
      renderFact({
        sourceName: 'Eevee',
        relation: 'evolves_into',
        targetName: 'Jolteon',
        properties: { method: 'Thunder Stone' },
      }),
    ).toBe('Eevee --evolves_into(Thunder Stone)--> Jolteon');
  });

  it('truncates chunk citations to 8 characters', () => {
    expect(
      renderFact({
        sourceName: 'Eevee',
        relation: 'evolves_into',
        targetName: 'Vaporeon',
        chunkIds: ['4b19e0aa-1111-2222-3333-444455556666'],
      }),
    ).toBe('Eevee --evolves_into--> Vaporeon [chunk:4b19e0aa]');
  });

  it('lists every asserting chunk', () => {
    const line = renderFact({
      sourceName: 'Mewtwo',
      relation: 'has_type',
      targetName: 'Psychic',
      chunkIds: ['aaaaaaaa-1111', 'bbbbbbbb-2222'],
    });
    expect(line).toContain('[chunk:aaaaaaaa chunk:bbbbbbbb]');
  });

  it('omits the citation bracket entirely for seeded ground truth', () => {
    const line = renderFact({
      sourceName: 'Fire',
      relation: 'super_effective_against',
      targetName: 'Grass',
      properties: { multiplier: 2 },
      chunkIds: [],
    });
    expect(line).not.toContain('[');
  });
});

describe('renderFactBlock', () => {
  it('returns an empty string for no facts, so the caller can drop the section', () => {
    expect(renderFactBlock([])).toBe('');
  });

  it('joins facts one per line', () => {
    expect(
      renderFactBlock([{ line: 'a --r--> b' }, { line: 'c --r--> d' }]),
    ).toBe('a --r--> b\nc --r--> d');
  });
});
