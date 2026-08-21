// ─── Graph-expanded retrieval ───────────────────────────────────────────────
//
// The end-to-end path: question → seed chunks (vector) → entities → traversal →
// extra chunks + citable facts. Stage 3 will consume `expanded` as its third
// RRF arm and `facts` as a prompt block; for now this is what proves the graph
// earns its keep, by reporting the chunks it added that the vector arm missed.

import { eq, inArray } from 'drizzle-orm';
import { db } from '../client.js';
import { chunks, documents } from '../schema.js';
import { semanticSearch, type SearchResult } from '../search.js';
import { graphExpand, type ExpandOptions, type ReachedEntity } from './traverse.js';
import { graphFacts, type GraphFact } from './facts.js';
import { typeMatchups, type Matchup } from './matchup.js';

export interface GraphChunk {
  chunkId: string;
  documentTitle: string;
  text: string;
  hops: number;
  entityCount: number;
}

export interface GraphRetrieveResult {
  /** What the vector arm found on its own. */
  seeds: SearchResult[];
  /** Entities the seed chunks mention. */
  seedEntities: ReachedEntity[];
  /** Everything reached within maxHops, including the seeds. */
  reachedEntities: ReachedEntity[];
  /**
   * Chunks the graph contributed that semantic search did NOT return. This
   * list being empty means the graph isn't adding anything for this query.
   */
  expanded: GraphChunk[];
  /** Relationships among the reached entities, rendered and citable. */
  facts: GraphFact[];
  /**
   * Defensive matchups composed from `has_type` × the type chart.
   *
   * Derived rather than stored, and the only part of the block that answers a
   * question about a *specific Pokémon* correctly — the raw chart facts alone
   * can't express that Ground does 0x to a Fire/Flying defender.
   */
  matchups: Matchup[];
}

export interface GraphRetrieveOptions extends ExpandOptions {
  /** How many vector hits to seed the traversal from. */
  seedK?: number;
  /**
   * Seed chunks to traverse from, when the caller has already run the vector
   * arm. A hybrid pipeline embeds the query for its own semantic arm anyway, so
   * letting it hand those hits over avoids a second embed + vector scan per
   * request. Omit to have this function run the search itself.
   */
  seeds?: SearchResult[];
  /**
   * Skip the fact and matchup queries. For callers that only want the expanded
   * chunks — and for A/B runs that disable the fact block but keep the arm.
   */
  includeFacts?: boolean;
  /** Cap on the fact block. */
  maxFacts?: number;
  /** Cap on how many entities feed the fact/matchup queries. */
  maxFactEntities?: number;
  /** Cap on derived matchup lines. */
  maxMatchups?: number;
}

export async function graphRetrieve(
  query: string,
  opts: GraphRetrieveOptions = {},
): Promise<GraphRetrieveResult> {
  const seedK = opts.seedK ?? 10;

  const seeds = opts.seeds ?? (await semanticSearch(query, seedK));
  const seedIds = seeds.map((s) => s.chunkId);

  const expansion = await graphExpand(seedIds, opts);

  const newChunkIds = expansion.chunks
    .filter((c) => !c.isSeed)
    .map((c) => c.chunkId);

  const expanded = newChunkIds.length
    ? await hydrate(newChunkIds, expansion.chunks)
    : [];

  // Facts used to take the uncapped seed set ∪ the walk (~125 ids). That
  // dumped the type chart into the prompt and made typeMatchups bind every
  // Pokémon the seed chunks happened to mention. Keep the subject of the
  // question — Pokémon, their types, their regions — and leave moves/groups
  // out. Type-chart *edges* still appear via graphFacts; they just aren't
  // discovered by walking from every type node at once.
  const { factEntityIds, pokemonEntityIds } = pickFactEntities(
    expansion.seedEntities,
    expansion.entities,
    {
      maxEntities: opts.maxFactEntities ?? 24,
      maxPokemon: opts.maxMatchups ?? 8,
    },
  );

  if (opts.includeFacts === false) {
    return {
      seeds,
      seedEntities: expansion.seedEntities,
      reachedEntities: expansion.entities,
      expanded,
      facts: [],
      matchups: [],
    };
  }

  // Sequential on purpose: the Supabase transaction pooler charges a TLS
  // handshake after idle_timeout, and two cold connects in Promise.all is
  // what surfaced as CONNECT_TIMEOUT on typeMatchups.
  const facts = await graphFacts(factEntityIds, {
    maxFacts: opts.maxFacts ?? 40,
    requireBothEndpoints: true,
  });
  const allMatchups = await typeMatchups(pokemonEntityIds);

  // typeMatchups returns alphabetically; re-sort onto the relevance order so
  // the cap keeps the Pokémon the question is actually about.
  const position = new Map(pokemonEntityIds.map((id, i) => [id, i]));
  const matchups = allMatchups
    .sort(
      (a, b) =>
        (position.get(a.pokemonId) ?? Infinity) -
        (position.get(b.pokemonId) ?? Infinity),
    )
    .slice(0, opts.maxMatchups ?? 8);

  return {
    seeds,
    seedEntities: expansion.seedEntities,
    reachedEntities: expansion.entities,
    expanded,
    facts,
    matchups,
  };
}

const FACT_TYPES = new Set(['pokemon', 'type', 'region']);

function typeRank(type: string): number {
  if (type === 'pokemon') return 0;
  if (type === 'type') return 1;
  if (type === 'region') return 2;
  return 3;
}

/**
 * Relevance-ordered entity ids for the fact and matchup queries.
 *
 * Seed entities come first (most-mentioned, Pokémon preferred), then the
 * walk. Moves, abilities and groups are dropped — they generate facts the
 * question almost never needs and they were the bulk of the 125-id bind.
 */
function pickFactEntities(
  seeds: ReachedEntity[],
  reached: ReachedEntity[],
  caps: { maxEntities: number; maxPokemon: number },
): { factEntityIds: string[]; pokemonEntityIds: string[] } {
  const ordered = [...seeds].sort(
    (a, b) => typeRank(a.type) - typeRank(b.type) || b.mentions - a.mentions,
  );
  const seen = new Set<string>();
  const factEntityIds: string[] = [];
  const pokemonEntityIds: string[] = [];

  for (const e of [...ordered, ...reached]) {
    if (!FACT_TYPES.has(e.type) || seen.has(e.entityId)) continue;
    seen.add(e.entityId);
    if (factEntityIds.length < caps.maxEntities) factEntityIds.push(e.entityId);
    if (e.type === 'pokemon' && pokemonEntityIds.length < caps.maxPokemon) {
      pokemonEntityIds.push(e.entityId);
    }
    if (
      factEntityIds.length >= caps.maxEntities &&
      pokemonEntityIds.length >= caps.maxPokemon
    ) {
      break;
    }
  }

  return { factEntityIds, pokemonEntityIds };
}

async function hydrate(
  chunkIds: string[],
  ranked: Array<{ chunkId: string; hops: number; entityCount: number }>,
): Promise<GraphChunk[]> {
  const rows = await db
    .select({
      chunkId: chunks.id,
      text: chunks.text,
      documentTitle: documents.title,
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(inArray(chunks.id, chunkIds));

  const byId = new Map(rows.map((r) => [r.chunkId, r]));

  // Preserve the traversal's ranking — it's the signal Stage 3's RRF consumes.
  return ranked
    .filter((r) => byId.has(r.chunkId))
    .map((r) => {
      const row = byId.get(r.chunkId)!;
      return {
        chunkId: r.chunkId,
        documentTitle: row.documentTitle,
        text: row.text,
        hops: r.hops,
        entityCount: r.entityCount,
      };
    });
}
