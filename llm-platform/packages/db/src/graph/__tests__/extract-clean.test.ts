// Exercises the cleaning pass that stands between raw model output and the
// database. `extractFromChunk` is mocked at the LLM boundary so these stay
// pure unit tests — the point is the filtering, not the network call.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateObjectMock = vi.fn();

vi.mock('@app/llm-client', () => ({
  extract: (_schema: unknown, opts: unknown) => generateObjectMock(opts),
  embed: vi.fn(),
  complete: vi.fn(),
}));

const { extractFromChunk } = await import('../extract.js');

function mockResponse(object: unknown) {
  generateObjectMock.mockResolvedValueOnce({ object });
}

const CHUNK_ID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  generateObjectMock.mockReset();
});

describe('extraction cleaning', () => {
  it('keeps a well-formed relation', async () => {
    mockResponse({
      entities: [
        { name: 'Pikachu', type: 'pokemon', aliases: null },
        { name: 'Electric', type: 'type', aliases: null },
      ],
      relations: [
        {
          source: 'Pikachu',
          relation: 'has_type',
          target: 'Electric',
          method: null,
          confidence: 1,
        },
      ],
    });

    const result = await extractFromChunk(CHUNK_ID, 'text');

    expect(result?.entities).toHaveLength(2);
    expect(result?.relations).toHaveLength(1);
    expect(result?.relations[0]).toMatchObject({
      sourceName: 'Pikachu',
      relation: 'has_type',
      targetName: 'Electric',
      sourceType: 'pokemon',
      targetType: 'type',
    });
  });

  it('drops relations referencing an entity the model never declared', async () => {
    mockResponse({
      entities: [{ name: 'Pikachu', type: 'pokemon', aliases: null }],
      relations: [
        {
          source: 'Pikachu',
          relation: 'evolves_into',
          target: 'Raichu', // never declared
          method: 'Thunder Stone',
          confidence: 1,
        },
      ],
    });

    const result = await extractFromChunk(CHUNK_ID, 'text');
    expect(result?.relations).toHaveLength(0);
  });

  it('drops relations whose endpoint types are wrong for the relation', async () => {
    mockResponse({
      entities: [
        { name: 'Pikachu', type: 'pokemon', aliases: null },
        { name: 'Raichu', type: 'pokemon', aliases: null },
      ],
      relations: [
        {
          source: 'Pikachu',
          relation: 'has_type', // pokemon -> pokemon is invalid
          target: 'Raichu',
          method: null,
          confidence: 1,
        },
      ],
    });

    const result = await extractFromChunk(CHUNK_ID, 'text');
    expect(result?.relations).toHaveLength(0);
  });

  it('drops type-vs-type effectiveness — the seeded chart owns that family', async () => {
    // Measured on the first real build: 10 of 10 type→type effectiveness edges
    // the model produced were wrong. Both examples below are real output.
    mockResponse({
      entities: [
        { name: 'Poison', type: 'type', aliases: null },
        { name: 'Fairy', type: 'type', aliases: null },
        { name: 'Ground', type: 'type', aliases: null },
      ],
      relations: [
        {
          // Backwards: Poison is 2x against Fairy.
          source: 'Poison',
          relation: 'not_very_effective_against',
          target: 'Fairy',
          method: null,
          confidence: 1,
        },
        {
          // Understated: Electric/Ground is an immunity, not a resistance.
          source: 'Ground',
          relation: 'no_effect_on',
          target: 'Fairy',
          method: null,
          confidence: 1,
        },
      ],
    });

    const result = await extractFromChunk(CHUNK_ID, 'text');

    expect(result?.relations).toHaveLength(0);
    // The type entities themselves are still worth keeping — they're what the
    // seeded chart's edges hang off, and what makes the chunk reachable.
    expect(result?.entities).toHaveLength(3);
  });

  it('keeps move-vs-type effectiveness, which the chart does not cover', async () => {
    mockResponse({
      entities: [
        { name: 'Thunderbolt', type: 'move', aliases: null },
        { name: 'Water', type: 'type', aliases: null },
      ],
      relations: [
        {
          source: 'Thunderbolt',
          relation: 'super_effective_against',
          target: 'Water',
          method: null,
          confidence: 1,
        },
      ],
    });

    const result = await extractFromChunk(CHUNK_ID, 'text');
    expect(result?.relations).toHaveLength(1);
    expect(result?.relations[0]?.sourceType).toBe('move');
  });

  it('drops low-confidence guesses', async () => {
    mockResponse({
      entities: [
        { name: 'Eevee', type: 'pokemon', aliases: null },
        { name: 'Jolteon', type: 'pokemon', aliases: null },
      ],
      relations: [
        {
          source: 'Eevee',
          relation: 'evolves_into',
          target: 'Jolteon',
          method: null,
          confidence: 0.3,
        },
      ],
    });

    const result = await extractFromChunk(CHUNK_ID, 'text');
    expect(result?.relations).toHaveLength(0);
  });

  it('drops self-edges', async () => {
    mockResponse({
      entities: [{ name: 'Ditto', type: 'pokemon', aliases: null }],
      relations: [
        {
          source: 'Ditto',
          relation: 'evolves_into',
          target: 'ditto',
          method: null,
          confidence: 1,
        },
      ],
    });

    const result = await extractFromChunk(CHUNK_ID, 'text');
    expect(result?.relations).toHaveLength(0);
  });

  it('deduplicates the same triple stated twice in one chunk', async () => {
    mockResponse({
      entities: [
        { name: 'Eevee', type: 'pokemon', aliases: null },
        { name: 'Jolteon', type: 'pokemon', aliases: null },
      ],
      relations: [
        {
          source: 'Eevee',
          relation: 'evolves_into',
          target: 'Jolteon',
          method: 'Thunder Stone',
          confidence: 1,
        },
        {
          source: 'eevee',
          relation: 'evolves_into',
          target: 'JOLTEON',
          method: null,
          confidence: 0.9,
        },
      ],
    });

    const result = await extractFromChunk(CHUNK_ID, 'text');
    expect(result?.relations).toHaveLength(1);
    expect(result?.relations[0]?.properties).toEqual({
      method: 'Thunder Stone',
    });
  });

  it('drops an alias that is just the canonical name again', async () => {
    mockResponse({
      entities: [
        { name: 'Mr. Mime', type: 'pokemon', aliases: ['mr mime', 'Mime Man'] },
      ],
      relations: [],
    });

    const result = await extractFromChunk(CHUNK_ID, 'text');
    expect(result?.entities[0]?.aliases).toEqual(['Mime Man']);
  });

  it('re-asks once, then gives up and returns null rather than failing the build', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('bad json'));
    generateObjectMock.mockRejectedValueOnce(new Error('bad json'));

    const result = await extractFromChunk(CHUNK_ID, 'text');

    expect(result).toBeNull();
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
  });

  it('recovers when the re-ask succeeds', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('bad json'));
    mockResponse({
      entities: [{ name: 'Mew', type: 'pokemon', aliases: null }],
      relations: [],
    });

    const result = await extractFromChunk(CHUNK_ID, 'text');

    expect(result?.entities).toHaveLength(1);
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
  });
});
