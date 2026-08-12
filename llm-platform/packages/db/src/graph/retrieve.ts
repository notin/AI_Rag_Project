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
  /** Cap on the fact block. */
  maxFacts?: number;
  /** Cap on derived matchup lines. */
  maxMatchups?: number;
}

export async function graphRetrieve(
  query: string,
  opts: GraphRetrieveOptions = {},
): Promise<GraphRetrieveResult> {
  const seedK = opts.seedK ?? 10;

  const seeds = await semanticSearch(query, seedK);
  const seedIds = seeds.map((s) => s.chunkId);

  const expansion = await graphExpand(seedIds, opts);

  const newChunkIds = expansion.chunks
    .filter((c) => !c.isSeed)
    .map((c) => c.chunkId);

  const expanded = newChunkIds.length
    ? await hydrate(newChunkIds, expansion.chunks)
    : [];

  // Facts draw on the uncapped seed set plus the walk. The expansion caps are
  // tuned to keep hub nodes from flooding the candidate pool, which is the
  // wrong trade for facts: dropping `Fairy` from a Dragon question costs you
  // the one edge that answers it.
  const factEntityIds = [
    ...new Set([
      ...expansion.seedEntities.map((e) => e.entityId),
      ...expansion.entities.map((e) => e.entityId),
    ]),
  ];

  const [facts, allMatchups] = await Promise.all([
    graphFacts(factEntityIds, {
      maxFacts: opts.maxFacts ?? 40,
      requireBothEndpoints: true,
    }),
    typeMatchups(factEntityIds),
  ]);

  // typeMatchups returns alphabetically; re-sort onto the relevance order so
  // the cap keeps the Pokémon the question is actually about.
  const position = new Map(factEntityIds.map((id, i) => [id, i]));
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
