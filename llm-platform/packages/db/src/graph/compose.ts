// ─── Chart composition ──────────────────────────────────────────────────────
//
// The arithmetic behind derived defensive matchups, kept free of any database
// import so it can be unit-tested directly. See matchup.ts for why this exists
// and for the query that feeds it.

/** One attacking type's multiplier against one defending type. */
export interface Effect {
  attacker: string;
  defender: string;
  multiplier: number;
}

export interface MatchupBucket {
  multiplier: number;
  attackers: string[];
}

/**
 * Multiply the chart across a Pokémon's types.
 *
 * `effects` only needs to contain non-neutral entries: any attacker absent for
 * a given defending type is treated as 1x, which is exactly what the chart's
 * omissions mean.
 *
 * Neutral results are dropped. An attacker that is 2x on one half and 0.5x on
 * the other deals normal damage, and listing it adds a line the reader has to
 * process for no information.
 */
export function composeMatchup(
  typing: string[],
  effects: Effect[],
): MatchupBucket[] {
  const byAttacker = new Map<string, Map<string, number>>();
  for (const e of effects) {
    let row = byAttacker.get(e.attacker);
    if (!row) {
      row = new Map<string, number>();
      byAttacker.set(e.attacker, row);
    }
    row.set(e.defender, e.multiplier);
  }

  const totals = new Map<string, number>();
  for (const [attacker, perDefender] of byAttacker) {
    // Products of 2, 1, 0.5 and 0 are all exact in binary floating point, so
    // comparing against 1 needs no epsilon.
    let product = 1;
    for (const defendingType of typing) {
      product *= perDefender.get(defendingType) ?? 1;
    }
    if (product !== 1) totals.set(attacker, product);
  }

  const byMultiplier = new Map<number, string[]>();
  for (const [attacker, multiplier] of totals) {
    const list = byMultiplier.get(multiplier) ?? [];
    list.push(attacker);
    byMultiplier.set(multiplier, list);
  }

  return [...byMultiplier.entries()]
    .map(([multiplier, attackers]) => ({
      multiplier,
      attackers: attackers.sort(),
    }))
    // Descending damage, which leaves 0x (immunity) last on its own.
    .sort((a, b) => b.multiplier - a.multiplier);
}

/**
 * Render one Pokémon's matchup as a single line.
 *
 *   Charizard (Fire/Flying) takes 4x from Rock; 2x from Electric, Water;
 *   0.25x from Bug, Grass; 0x from Ground [chunk:cf91e583]
 */
export function renderMatchup(
  pokemonName: string,
  typing: string[],
  buckets: MatchupBucket[],
  chunkIds: string[] = [],
): string {
  const head = `${pokemonName} (${typing.join('/')})`;

  // The citation covers the typing, which is the extracted (and therefore
  // fallible) half of the claim — so it belongs on the neutral line too.
  const citation = chunkIds.length
    ? ` [${chunkIds.map((id) => `chunk:${id.slice(0, 8)}`).join(' ')}]`
    : '';

  if (buckets.length === 0) {
    return `${head} takes neutral damage from every type${citation}`;
  }

  const body = buckets
    .map((b) => `${formatMultiplier(b.multiplier)} from ${b.attackers.join(', ')}`)
    .join('; ');

  return `${head} takes ${body}${citation}`;
}

function formatMultiplier(multiplier: number): string {
  // 0.25 must not render as "0.3x", and 0 must render at all — the immunity is
  // the single most invertible fact in the set.
  return `${Number(multiplier.toFixed(4))}x`;
}
