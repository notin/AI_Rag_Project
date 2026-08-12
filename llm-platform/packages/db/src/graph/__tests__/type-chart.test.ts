import { describe, it, expect } from 'vitest';
import { TYPE_CHART, POKEMON_TYPES } from '../type-chart.js';

// The chart is hand-encoded ground truth that overrides anything the LLM
// extracts. A typo here is authoritative and silently wrong, so it gets
// checked structurally rather than trusted.

describe('TYPE_CHART', () => {
  it('covers all 18 types', () => {
    expect(POKEMON_TYPES).toHaveLength(18);
    for (const type of POKEMON_TYPES) {
      expect(TYPE_CHART[type]).toBeDefined();
    }
  });

  it('only references known types', () => {
    const known = new Set<string>(POKEMON_TYPES);
    for (const attacker of POKEMON_TYPES) {
      const chart = TYPE_CHART[attacker];
      for (const defender of [
        ...(chart.double ?? []),
        ...(chart.half ?? []),
        ...(chart.zero ?? []),
      ]) {
        expect(known.has(defender), `${attacker} -> ${defender}`).toBe(true);
      }
    }
  });

  it('never puts the same defender in two multiplier buckets', () => {
    for (const attacker of POKEMON_TYPES) {
      const chart = TYPE_CHART[attacker];
      const all = [
        ...(chart.double ?? []),
        ...(chart.half ?? []),
        ...(chart.zero ?? []),
      ];
      expect(new Set(all).size, `${attacker} has a duplicate defender`).toBe(
        all.length,
      );
    }
  });

  it('has no duplicate entries within a bucket', () => {
    for (const attacker of POKEMON_TYPES) {
      const chart = TYPE_CHART[attacker];
      for (const bucket of ['double', 'half', 'zero'] as const) {
        const list = chart[bucket] ?? [];
        expect(new Set(list).size, `${attacker}.${bucket}`).toBe(list.length);
      }
    }
  });

  it('encodes the canonical Gen 6+ immunities', () => {
    expect(TYPE_CHART.Normal.zero).toContain('Ghost');
    expect(TYPE_CHART.Ghost.zero).toContain('Normal');
    expect(TYPE_CHART.Fighting.zero).toContain('Ghost');
    expect(TYPE_CHART.Electric.zero).toContain('Ground');
    expect(TYPE_CHART.Ground.zero).toContain('Flying');
    expect(TYPE_CHART.Poison.zero).toContain('Steel');
    expect(TYPE_CHART.Psychic.zero).toContain('Dark');
    expect(TYPE_CHART.Dragon.zero).toContain('Fairy');
  });

  it('encodes what the Eevee multi-hop question depends on', () => {
    // "Which Eevee evolution beats Dragon types?" resolves through here:
    // Dragon is hit 2x by Ice (Glaceon) and Fairy (Sylveon).
    expect(TYPE_CHART.Ice.double).toContain('Dragon');
    expect(TYPE_CHART.Fairy.double).toContain('Dragon');
    expect(TYPE_CHART.Dragon.double).toContain('Dragon');
  });

  it('keeps direction straight where it is easiest to invert', () => {
    // Fairy beats Dragon, Dragon does nothing back.
    expect(TYPE_CHART.Fairy.double).toContain('Dragon');
    expect(TYPE_CHART.Dragon.double ?? []).not.toContain('Fairy');
    // Ghost and Psychic are not symmetric: Ghost beats Psychic 2x,
    // Psychic does 1x back (absent from every bucket).
    expect(TYPE_CHART.Ghost.double).toContain('Psychic');
    const psychicVsGhost = [
      ...(TYPE_CHART.Psychic.double ?? []),
      ...(TYPE_CHART.Psychic.half ?? []),
      ...(TYPE_CHART.Psychic.zero ?? []),
    ];
    expect(psychicVsGhost).not.toContain('Ghost');
  });
});
