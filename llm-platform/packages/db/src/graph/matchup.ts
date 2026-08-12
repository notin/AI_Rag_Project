// ─── Derived defensive matchups ─────────────────────────────────────────────
//
// The graph's first piece of real *composition*: it answers a question no
// single edge holds, by multiplying the type chart across everything a Pokémon
// is.
//
// Why this exists. Charizard is Fire/Flying. Ask "what beats Charizard?" and
// the individually-correct facts are actively misleading:
//
//     Ground --super_effective_against(2x)--> Fire
//     Flying --...--> (Ground has no effect on Flying)
//
// A model handed those two lines says Ground beats Charizard. The real answer
// is that Charizard is *immune* to Ground — a zero anywhere in the product
// wins. Same for the other direction: Rock is 2x on both halves, so it's 4x,
// which no individual edge states either.
//
// The multiplication is arithmetic over seeded ground truth, so it is exact.
// The only extracted (and therefore citable, and therefore fallible) input is
// which types the Pokémon has — which is why the rendered line carries the
// `has_type` provenance and nothing else.

import { sql } from 'drizzle-orm';
import { db } from '../client.js';
import {
  composeMatchup,
  renderMatchup,
  type Effect,
  type MatchupBucket,
} from './compose.js';

export {
  composeMatchup,
  renderMatchup,
  type Effect,
  type MatchupBucket,
} from './compose.js';

export interface Matchup {
  pokemonId: string;
  pokemonName: string;
  /** Every type this Pokémon has, in the order the chart was applied. */
  typing: string[];
  /** Non-neutral buckets, most damaging first, immunities last. */
  buckets: MatchupBucket[];
  /** Chunks that asserted the typing. The arithmetic itself needs no source. */
  chunkIds: string[];
  line: string;
}

// ─── Database layer ─────────────────────────────────────────────────────────

/**
 * Compute matchups for the given entities. Non-Pokémon ids and Pokémon with no
 * extracted typing are skipped rather than reported as neutral, because "we
 * don't know its type" and "nothing is effective against it" are very
 * different claims to put in front of a model.
 */
export async function typeMatchups(entityIds: string[]): Promise<Matchup[]> {
  if (entityIds.length === 0) return [];

  const ids = sql.param(entityIds);

  // Typing, plus the provenance of the has_type edges that assert it.
  const typingRows = await db.execute<{
    pokemon_id: string;
    pokemon_name: string;
    type_name: string;
    chunk_ids: string[] | null;
  }>(sql`
    SELECT p.id            AS pokemon_id,
           p.canonical_name AS pokemon_name,
           t.canonical_name AS type_name,
           array_remove(array_agg(ec.chunk_id::text), NULL) AS chunk_ids
    FROM entities p
    JOIN edges ht    ON ht.source_entity_id = p.id AND ht.relation = 'has_type'
    JOIN entities t  ON t.id = ht.target_entity_id AND t.type = 'type'
    LEFT JOIN edge_chunks ec ON ec.edge_id = ht.id
    WHERE p.id = ANY(${ids}::uuid[]) AND p.type = 'pokemon'
    GROUP BY p.id, p.canonical_name, t.canonical_name
    ORDER BY p.canonical_name, t.canonical_name
  `);

  const byPokemon = new Map<
    string,
    { name: string; typing: string[]; chunkIds: Set<string> }
  >();

  for (const raw of typingRows) {
    const row = raw as {
      pokemon_id: string;
      pokemon_name: string;
      type_name: string;
      chunk_ids: string[] | null;
    };
    const entry = byPokemon.get(row.pokemon_id) ?? {
      name: row.pokemon_name,
      typing: [],
      chunkIds: new Set<string>(),
    };
    entry.typing.push(row.type_name);
    for (const id of row.chunk_ids ?? []) entry.chunkIds.add(id);
    byPokemon.set(row.pokemon_id, entry);
  }

  if (byPokemon.size === 0) return [];

  // The chart itself, restricted to the defending types actually in play.
  // `origin = 'seed'` is load-bearing: composing extracted effectiveness edges
  // would multiply the model's mistakes together.
  const defendingTypes = [
    ...new Set([...byPokemon.values()].flatMap((p) => p.typing)),
  ];

  const effectRows = await db.execute<{
    attacker: string;
    defender: string;
    multiplier: number;
  }>(sql`
    SELECT atk.canonical_name AS attacker,
           def.canonical_name AS defender,
           (e.properties->>'multiplier')::float8 AS multiplier
    FROM edges e
    JOIN entities atk ON atk.id = e.source_entity_id AND atk.type = 'type'
    JOIN entities def ON def.id = e.target_entity_id AND def.type = 'type'
    WHERE e.origin = 'seed'
      AND e.relation IN (
        'super_effective_against',
        'not_very_effective_against',
        'no_effect_on'
      )
      AND def.canonical_name = ANY(${sql.param(defendingTypes)}::text[])
      AND e.properties->>'multiplier' IS NOT NULL
  `);

  const effects: Effect[] = [...effectRows].map((raw) => {
    const row = raw as {
      attacker: string;
      defender: string;
      multiplier: number;
    };
    return {
      attacker: row.attacker,
      defender: row.defender,
      multiplier: Number(row.multiplier),
    };
  });

  return [...byPokemon.entries()]
    .map(([pokemonId, entry]) => {
      const buckets = composeMatchup(entry.typing, effects);
      const chunkIds = [...entry.chunkIds];
      return {
        pokemonId,
        pokemonName: entry.name,
        typing: entry.typing,
        buckets,
        chunkIds,
        line: renderMatchup(entry.name, entry.typing, buckets, chunkIds),
      };
    })
    .sort((a, b) => a.pokemonName.localeCompare(b.pokemonName));
}
