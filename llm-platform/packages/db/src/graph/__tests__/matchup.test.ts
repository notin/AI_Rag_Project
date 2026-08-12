// Exercises the matchup arithmetic. Pure — `composeMatchup` takes the chart as
// an argument, so no database is involved.
//
// This is the highest-stakes arithmetic in the graph: it's the only place a
// wrong answer looks *more* authoritative than the raw facts it replaces.

import { describe, it, expect } from 'vitest';
import {
  composeMatchup,
  renderMatchup,
  type Effect,
  type MatchupBucket,
} from '../compose.js';
import { TYPE_CHART, POKEMON_TYPES } from '../type-chart.js';

/**
 * The seeded chart, in the shape `typeMatchups` reads out of the database.
 * Built from the same source that seeds it, so the fixture can't drift.
 */
const CHART: Effect[] = POKEMON_TYPES.flatMap((attacker) => {
  const chart = TYPE_CHART[attacker];
  return [
    ...(chart.double ?? []).map((d) => ({ attacker, defender: d, multiplier: 2 })),
    ...(chart.half ?? []).map((d) => ({ attacker, defender: d, multiplier: 0.5 })),
    ...(chart.zero ?? []).map((d) => ({ attacker, defender: d, multiplier: 0 })),
  ];
});

/** Effective multiplier a defender takes from one attacking type. */
function against(typing: string[], attacker: string): number {
  const bucket = composeMatchup(typing, CHART).find((b) =>
    b.attackers.includes(attacker),
  );
  // Absent from every bucket means the product was exactly 1x.
  return bucket ? bucket.multiplier : 1;
}

describe('composeMatchup — single type', () => {
  it('mirrors the chart for a mono-type defender', () => {
    expect(against(['Dragon'], 'Fairy')).toBe(2);
    expect(against(['Dragon'], 'Ice')).toBe(2);
    expect(against(['Fire'], 'Water')).toBe(2);
    expect(against(['Fire'], 'Grass')).toBe(0.5);
  });

  it('keeps mono-type immunities', () => {
    expect(against(['Ghost'], 'Normal')).toBe(0);
    expect(against(['Flying'], 'Ground')).toBe(0);
    expect(against(['Fairy'], 'Dragon')).toBe(0);
  });
});

describe('composeMatchup — dual type', () => {
  // Charizard is the canonical trap. Ground is 2x on Fire, but Flying is immune
  // to Ground, so the true answer is 0x. Handed the two chart lines separately,
  // a model reads the 2x as decisive and says Ground beats Charizard.
  const charizard = ['Fire', 'Flying'];

  it('stacks to 4x when both halves are weak', () => {
    expect(against(charizard, 'Rock')).toBe(4);
  });

  it('lets one immunity beat a 2x — the case this whole module exists for', () => {
    expect(against(['Fire'], 'Ground')).toBe(2);
    expect(against(['Flying'], 'Ground')).toBe(0);
    expect(against(charizard, 'Ground')).toBe(0);
  });

  it('stacks resistances down to 0.25x', () => {
    expect(against(charizard, 'Grass')).toBe(0.25);
    expect(against(charizard, 'Bug')).toBe(0.25);
  });

  it('cancels a 2x against a 0.5x back to neutral', () => {
    // Ice is 0.5x on Fire and 2x on Flying.
    expect(against(charizard, 'Ice')).toBe(1);
  });

  it('carries a 2x through an unaffected second half', () => {
    expect(against(charizard, 'Water')).toBe(2);
    expect(against(charizard, 'Electric')).toBe(2);
  });

  it('gets Lapras (Ice/Water) right', () => {
    expect(against(['Ice', 'Water'], 'Electric')).toBe(2);
    expect(against(['Ice', 'Water'], 'Fighting')).toBe(2);
    // Water resists itself but is neutral into Ice, so this is 0.5x not 0.25x.
    expect(against(['Ice', 'Water'], 'Water')).toBe(0.5);
    // Ice is the only attacker both halves resist.
    expect(against(['Ice', 'Water'], 'Ice')).toBe(0.25);
    expect(against(['Ice', 'Water'], 'Fire')).toBe(1);
  });

  it('gets Gengar (Ghost/Poison) right, including both immunities', () => {
    expect(against(['Ghost', 'Poison'], 'Normal')).toBe(0);
    expect(against(['Ghost', 'Poison'], 'Fighting')).toBe(0);
    expect(against(['Ghost', 'Poison'], 'Psychic')).toBe(2);
  });

  it('gets Bulbasaur (Grass/Poison) right', () => {
    expect(against(['Grass', 'Poison'], 'Fire')).toBe(2);
    expect(against(['Grass', 'Poison'], 'Psychic')).toBe(2);
    expect(against(['Grass', 'Poison'], 'Water')).toBe(0.5);
    expect(against(['Grass', 'Poison'], 'Grass')).toBe(0.25);
  });
});

describe('composeMatchup — output shape', () => {
  it('omits neutral matchups entirely', () => {
    const buckets = composeMatchup(['Fire', 'Flying'], CHART);
    const all = buckets.flatMap((b) => b.attackers);
    expect(all).not.toContain('Ice'); // exactly 1x
    expect(buckets.every((b) => b.multiplier !== 1)).toBe(true);
  });

  it('orders buckets by descending damage, immunity last', () => {
    const buckets = composeMatchup(['Fire', 'Flying'], CHART);
    const multipliers = buckets.map((b) => b.multiplier);
    expect(multipliers).toEqual([...multipliers].sort((a, b) => b - a));
    expect(multipliers[0]).toBe(4);
    expect(multipliers.at(-1)).toBe(0);
  });

  it('groups every attacker sharing a multiplier into one bucket', () => {
    const buckets = composeMatchup(['Fire', 'Flying'], CHART);
    const twice = buckets.find((b) => b.multiplier === 2)!;
    expect(twice.attackers).toEqual(['Electric', 'Water']);
  });

  it('never lists the same attacker twice', () => {
    const all = composeMatchup(['Ice', 'Water'], CHART).flatMap(
      (b) => b.attackers,
    );
    expect(new Set(all).size).toBe(all.length);
  });

  it('returns nothing for a typing the chart says nothing about', () => {
    expect(composeMatchup(['Cosmic'], CHART)).toEqual([]);
  });

  it('returns nothing for an empty typing', () => {
    expect(composeMatchup([], CHART)).toEqual([]);
  });
});

describe('renderMatchup', () => {
  const typing = ['Fire', 'Flying'];
  const buckets: MatchupBucket[] = composeMatchup(typing, CHART);

  it('leads with the name and typing', () => {
    expect(renderMatchup('Charizard', typing, buckets)).toContain(
      'Charizard (Fire/Flying)',
    );
  });

  it('states the 4x and the 0x, which no single edge does', () => {
    const line = renderMatchup('Charizard', typing, buckets);
    expect(line).toContain('4x from Rock');
    expect(line).toContain('0x from Ground');
  });

  it('renders 0.25x exactly rather than rounding it to 0.3x', () => {
    const line = renderMatchup('Charizard', typing, buckets);
    expect(line).toContain('0.25x');
    expect(line).not.toContain('0.3x');
  });

  it('trims trailing zeros', () => {
    const line = renderMatchup('Charizard', typing, buckets);
    expect(line).toContain('4x');
    expect(line).not.toContain('4.0000x');
  });

  it('attaches truncated chunk provenance for the typing', () => {
    const line = renderMatchup('Charizard', typing, buckets, [
      '4b19e0aa-1111-2222-3333-444455556666',
    ]);
    expect(line).toContain('[chunk:4b19e0aa]');
  });

  it('omits the citation bracket when the typing has no provenance', () => {
    expect(renderMatchup('Charizard', typing, buckets)).not.toContain('[chunk:');
  });

  it('says so explicitly when nothing is effective either way', () => {
    expect(renderMatchup('Mystery', ['Cosmic'], [])).toContain(
      'neutral damage from every type',
    );
  });
});
