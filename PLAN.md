# PLAN.md — Multi-Service LLM Platform (TypeScript)

A staged, checkpoint-driven build plan implementing all five LLM integration
patterns across multiple services. Designed to be imported into Cursor and
worked stage-by-stage: feed the agent one stage at a time ("implement Stage 2"),
verify the **Done when** check, then move on.

> **Priority:** Stage 2 (vector DB + data) is the core learning goal and is
> intentionally the most detailed. Everything before it is scaffolding to get
> you there; everything after builds on top of it.

---

## Architecture

```
                          ┌───────────────────────────┐
   HTTP / events ───────▶ │  orchestrator (app)        │  ← router + agent loop (Pattern 5)
                          │  deterministic vs LLM route│
                          └─────┬───────────────┬──────┘
                                │ calls          │ calls
                    ┌───────────▼──────┐   ┌─────▼─────────────┐
                    │ knowledge (app)  │   │ your other svcs   │
                    │ RAG: ingest+query│   │ (plain APIs)      │
                    │ (Patterns 2 + 4) │   └───────────────────┘
                    └───┬──────────┬───┘
             writes/reads│          │ enqueues ingest jobs
                 ┌───────▼───┐  ┌───▼──────────┐
                 │ Postgres  │  │ worker (app) │  ← async processing (Pattern 3)
                 │ + pgvector│  │ BullMQ       │
                 │ + graph   │  └───┬──────────┘
                 └───────────┘      │
                                    │
   all model calls go through ──────┴────▶ LiteLLM gateway (Pattern 1) ─▶ providers
```

**Five patterns, mapped to code:**
1. **Gateway** → LiteLLM (Docker) + `packages/llm-client` thin typed client.
2. **LLM service** → `apps/knowledge` exposes a typed contract, owns prompts + re-ask loop.
3. **Async** → `apps/worker` consumes a BullMQ queue for ingestion.
4. **RAG** → `apps/knowledge` ingestion + query pipelines over pgvector, expanded by
   a knowledge graph living in the same Postgres.
5. **Orchestrator** → `apps/orchestrator` router + tool-calling agent.

---

## Tech stack (pinned choices — don't re-litigate mid-build)

| Concern | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Standard, Cursor-friendly, cached builds |
| Language | TypeScript, Node 20+, `tsx` to run | — |
| HTTP | Hono | TS-first, tiny, great DX |
| Validation | Zod | Schemas + structured LLM output |
| LLM access | Vercel AI SDK (`ai`, `@ai-sdk/openai`) | `generateObject` gives typed output |
| Gateway | LiteLLM (Docker) | Buy-not-build; caching + fallback + cost |
| DB / vectors | Postgres 16 + **pgvector** | Just Postgres — lowest-friction vector store |
| ORM | Drizzle | First-class pgvector support, SQL-close |
| Keyword search | Postgres `tsvector` (full-text) | The BM25 half of hybrid, no extra service |
| Graph store | Postgres edge tables + recursive CTEs | Same DB as the vectors — traversal and ANN fuse in one query, no dual-write |
| Rerank | Cohere Rerank API | Simple hosted cross-encoder (swap: Bedrock) |
| Queue | BullMQ + Redis | SQS-like semantics, runs locally |
| Tests | Vitest | — |

**Swap notes for your AWS target:** BullMQ→SQS, LiteLLM→Bedrock+gateway,
pgvector→OpenSearch/Aurora pgvector, Cohere→Bedrock Rerank, graph tables→Neptune
(or Neo4j). The plan keeps these behind interfaces so the swap is localized.

---

## Repo layout (target end state)

```
llm-platform/
├─ docker-compose.yml          # postgres+pgvector, redis, litellm
├─ litellm.config.yaml         # gateway routing + fallback config
├─ pnpm-workspace.yaml
├─ turbo.json
├─ packages/
│  ├─ shared/                  # env, logger, common types
│  ├─ llm-client/              # typed client → gateway
│  └─ db/                      # drizzle schema, migrations, vector helpers
│     └─ src/graph/            # entity/edge schema, extraction, traversal
└─ apps/
   ├─ knowledge/               # RAG service (ingest + query)
   ├─ worker/                  # async ingestion consumer
   └─ orchestrator/            # router + agent + public API
```

---

## Prerequisites

- Node 20+, pnpm, Docker Desktop.
- API keys: one LLM provider (OpenAI or Anthropic), Cohere (rerank). Put them in
  `.env` — never commit. LiteLLM reads provider keys; app code only ever sees the
  gateway.

---

# Stage 0 — Monorepo + infra scaffold

**Goal:** an empty-but-wired monorepo where `docker compose up` gives you a
healthy Postgres+pgvector, Redis, and LiteLLM, and `pnpm build` passes.

**Depends on:** nothing.

**Tasks:**
- [ ] `pnpm init`, add `pnpm-workspace.yaml` (`packages/*`, `apps/*`), `turbo.json`.
- [ ] Root `tsconfig.base.json`; each package/app extends it.
- [ ] `packages/shared`: Zod-validated `env.ts`, a `logger.ts` (pino), shared types.
- [ ] `docker-compose.yml` with three services:
  - `postgres`: image `pgvector/pgvector:pg16`, volume, healthcheck.
  - `redis`: image `redis:7`.
  - `litellm`: image `ghcr.io/berriai/litellm`, mounts `litellm.config.yaml`.
- [ ] `.env.example` documenting every var; `.gitignore` covers `.env`.

**Key files:** `docker-compose.yml`, `packages/shared/src/env.ts`, `turbo.json`.

**Done when:** `docker compose up` → all healthy; `pnpm -r build` passes; a
`packages/shared` env import throws clearly if a required var is missing.

---

# Stage 1 — Gateway client (Pattern 1)

**Goal:** all model calls in the whole system go through one typed client that
talks to LiteLLM. Never call a provider SDK directly anywhere else.

**Depends on:** Stage 0.

**Tasks:**
- [ ] Fill `litellm.config.yaml`: define model aliases (`chat-cheap`, `chat-main`,
      `embed`) mapped to real provider models, with a **fallback chain** and
      simple caching enabled.
- [ ] `packages/llm-client`: wrap the Vercel AI SDK with `baseURL` pointed at the
      LiteLLM container. Export:
  - `complete(opts)` — text/chat.
  - `extract(schema, opts)` — `generateObject` with a Zod schema (typed output).
  - `embed(texts: string[])` — returns vectors; **assert the returned dimension**.
- [ ] A `scripts/smoke.ts` that runs one `complete` and one `embed` through the gateway.

**Key files:** `litellm.config.yaml`, `packages/llm-client/src/index.ts`.

**Done when:** `pnpm tsx scripts/smoke.ts` prints a completion and an embedding
vector length. Kill your provider key in the config's primary model → fallback
still answers (proves the chain).

---

# Stage 2 — Vector DB + data foundation  ⭐ (Pattern 4, part 1)

> **This is the stage that matters.** Read the concepts, then build. Take it slow.

## Concepts primer (read first)

**What an embedding is.** An embedding turns a piece of text into a fixed-length
list of numbers (a *vector*) — e.g. 1536 floats. Texts with similar *meaning* land
close together in that 1536-dimensional space. "Cancel my plan" and "terminate my
subscription" produce nearby vectors even with no shared words. That "nearby =
similar meaning" property is the entire engine of semantic search.

**Dimensions.** The vector length is fixed *by the embedding model*.
`text-embedding-3-small` → 1536. **Your DB column must match this number exactly.**
Change the model → change the column → re-embed everything. Pin the model now.

**Distance / similarity.** "Close together" needs a metric. The common one for
text embeddings is **cosine similarity** (angle between vectors). pgvector exposes
it via the `<=>` operator (cosine *distance* = 1 − similarity; smaller = more
similar). You'll `ORDER BY embedding <=> query` to get nearest neighbours.

**Why a special index.** Comparing a query against every row (a full scan) is fine
for hundreds of rows, murder for millions. pgvector offers **approximate** indexes
that trade a tiny bit of accuracy for huge speed:
- **HNSW** — best recall/speed, slower to build, more memory. **Use this** as default.
- **IVFFlat** — lighter, needs data present before you build it (it clusters rows).
Start with HNSW; you won't feel the difference until you're large, and it's simpler
(no "build after load" ordering trap).

**Chunking (the quality lever).** You don't embed whole documents — you split them
into **chunks** (roughly paragraph-sized) and embed each. Retrieval returns chunks,
not files. Why it's *the* quality decision: an embedding compresses a chunk into one
point, so a chunk that crams three topics gets a muddy, unsearchable vector, and a
chunk cut mid-sentence loses meaning. Aim for coherent, single-topic chunks with a
little overlap so a thought split across a boundary is still findable. Bad chunking
sinks everything downstream — no reranker or fancy prompt recovers it.

## Build

**Goal:** a `packages/db` you can hand a folder of text/markdown files, and it
chunks, embeds, and stores them — then answers "give me the N most similar chunks
to this query" correctly.

**Depends on:** Stages 0–1 (`embed` from the gateway client).

**Tasks:**
- [ ] Enable the extension: migration runs `CREATE EXTENSION IF NOT EXISTS vector;`.
- [ ] Drizzle schema in `packages/db/src/schema.ts`:
  - `documents` (id, source_uri, title, content_hash, created_at).
  - `chunks` (id, document_id FK, ordinal, text, **`embedding vector(1536)`**,
    `tsv tsvector` generated from `text`, metadata `jsonb`).
- [ ] Indexes: **HNSW** on `embedding` using `vector_cosine_ops`; **GIN** on `tsv`
      (sets up the keyword half of hybrid for Stage 3).
- [ ] Chunker `packages/db/src/chunk.ts`: structure-aware split (respect headings /
      blank lines / code fences), target ~500–800 tokens, ~15% overlap. Keep it a
      pure function so it's unit-testable.
- [ ] Ingestion `packages/db/src/ingest.ts`: load file → hash (skip if unchanged,
      **idempotency**) → chunk → `embed()` in batches → upsert document + chunks.
- [ ] Similarity query `packages/db/src/search.ts`:
      `semanticSearch(query, k)` → embed the query, `ORDER BY embedding <=> $1 LIMIT k`.
- [ ] Seed data: drop ~10 markdown docs in `packages/db/seed/` and a
      `scripts/ingest-seed.ts`.
- [ ] Vitest: chunker boundaries; an ingest→search round-trip on a tiny fixture
      asserting the expected chunk comes back top-1.

**Key files:** `packages/db/src/{schema,chunk,ingest,search}.ts`, migrations.

**Concept checks to eyeball:**
- Column dim (1536) == model output dim from Stage 1's assertion. Mismatch = the
  #1 beginner bug; the insert will throw.
- Run the same query twice → identical order (embeddings are deterministic per model).
- Query for a concept using *different words* than any document → the right chunk
  still ranks top. That's the moment semantic search "clicks."

**Done when:** `pnpm tsx scripts/ingest-seed.ts` loads the seed set, and a search
script for a paraphrased question returns the semantically correct chunk in the top
few — with **no keyword overlap** required.

---

# Stage 2.5 — Knowledge graph layer ⭐ (Pattern 4, part 2)

> **Build this before Stage 3.** The graph becomes a *third retrieval arm*
> alongside semantic and keyword. It is far cleaner to write the fusion step with
> three arms from the start than to retrofit one into a finished pipeline.

## Concepts primer (read first)

**What vector search structurally cannot do.** Stage 2 answers one question well:
"which chunk *reads like* this query?" That framing has four blind spots, and all
four show up in the Pokémon corpus you already ingested.

1. **Multi-hop questions.** *"Which Eevee evolution beats Dragon types?"* The chain
   is Dragon → weak to Ice and Fairy → Glaceon and Sylveon. Those two facts live in
   `dragon-types.md` and `eevee-evolutions.md`, and the *answer* lives in neither.
   No chunk is similar to the question, because no chunk contains the join.
2. **Set and aggregation questions.** *"List every Pokémon in the corpus weak to
   Ghost."* The answer is a set assembled from a dozen chunks. Vector search returns
   the `k` most similar ones and silently truncates the rest — and it has no way to
   tell you it truncated. A traversal returns the *complete* set or nothing.
3. **Sparsely-mentioned entities.** A Pokémon named once, in passing, inside a chunk
   about something else. That chunk's embedding is dominated by its main topic, so
   the passing mention is effectively invisible to the vector arm. An entity→chunk
   edge surfaces it regardless of what the chunk is mostly about.
4. **Facts that must be exact.** Type effectiveness is a multiplier table. Prose says
   "super effective against"; models reliably invert the direction on the way back
   out. A seeded, deterministic table is right 100% of the time and is citable.

**What "the graph" actually is here.** Three things: **nodes** (entities), **edges**
(typed relationships), and a **bridge table back to chunks**. The bridge is the whole
trick. Every entity and every edge records which chunk asserted it, so a traversal
always terminates in *text you can cite* rather than in naked triples the model has
to be trusted to narrate. This is what keeps grounding and citations intact — the
property Stage 3 depends on.

**How it improves retrieval — two distinct mechanisms.** Keep these separate in your
head, because they fail differently and you will want to A/B them independently.

- **Graph expansion (fixes recall).** Vector-search a small set of *seed* chunks →
  find the entities those chunks mention → walk 1–2 hops → collect the chunks that
  mention the neighbours → add them to the candidate pool. You are not replacing the
  vector arm; you are handing the reranker candidates it would never otherwise have
  seen. This is what fixes blind spots 1 and 3.
- **Fact serialization (fixes precision).** For questions that resolve cleanly to
  entities, serialize the relevant subgraph directly into the prompt as compact
  lines — `Ice --super_effective_against(2x)--> Dragon [chunk:abc]`. It reads structure
  instead of inferring it from prose. This is what fixes blind spots 2 and 4.

**Traversal depth is a quality lever, exactly like chunk size.** One hop is usually
enough. Two hops is where genuine multi-hop questions get answered. Three or more
floods the pool with loosely-related noise that the reranker then has to spend its
budget discarding — recall goes up, precision falls off a cliff. Cap hops, cap total
nodes, and **decay each candidate's weight by hop distance** so near neighbours
outrank distant ones.

**Why not a separate graph database.** Neo4j or Neptune would give you Cypher and a
graph browser, at the cost of a second datastore, dual writes, and — the real killer
— doing the vector/graph join in application code. Keeping edges as Postgres tables
means one transaction, one backup, one connection pool, and a fusion query that can
touch the HNSW index and the edge tables in the same statement. Put the traversal
behind a `GraphStore` interface anyway; if you outgrow recursive CTEs, the swap to
Neptune stays localized to one file. **Note:** Apache AGE is *not* an option if
you're on Supabase, which is another reason to stay with plain tables.

## Build

**Goal:** a `packages/db/src/graph/` that, given the chunks already in the database,
extracts a typed entity/relationship graph, and exposes two functions — one that
expands a set of seed chunk ids into a ranked list of graph-reachable chunk ids, and
one that renders a subgraph as citable facts.

**Depends on:** Stage 2 (chunks exist and are embedded), Stage 1 (`extract` and
`embed` from the gateway client).

### Tasks

**Schema & migration**

- [x] Add graph tables. Put them in `packages/db/src/graph/schema.ts`, then point
      drizzle-kit at both files — `schema: ['./src/schema.ts', './src/graph/schema.ts']`
      in `drizzle.config.ts`. Miss this and `db:generate` silently emits nothing.
  - `entities` — id, `canonical_name`, `type` (see vocabulary below), `summary`,
    `embedding vector(1536)` (nullable), `metadata jsonb`, `created_at`.
  - `entity_aliases` — `entity_id` FK, `alias`, `normalized_alias`. A table, not a
    `text[]` column, so alias resolution is an index lookup instead of a scan.
  - `edges` — id, `source_entity_id`, `target_entity_id`, `relation`,
    `properties jsonb`, `confidence real`, `origin` (`'seed' | 'llm'`), `created_at`.
  - `chunk_entities` — `chunk_id` FK (cascade), `entity_id` FK, `mentions int`.
    Composite PK. **This is the bridge; everything depends on it.**
  - `edge_chunks` — `edge_id` FK (cascade), `chunk_id` FK (cascade). An edge can be
    asserted by several chunks; this is the provenance trail for citations.
- [x] Indexes: unique on `(lower(canonical_name), type)` for entities; unique on
      `normalized_alias`; unique on `(source_entity_id, relation, target_entity_id)`
      to make edge writes idempotent; btree on **both** `source_entity_id` and
      `target_entity_id` (traversal runs in both directions); btree on
      `chunk_entities.entity_id` *and* `chunk_entities.chunk_id`; **HNSW** on
      `entities.embedding` with `vector_cosine_ops`.
- [x] **While you're in here:** Stage 2 specified a `tsv` column and GIN index on
      `chunks` but the shipped migration never created them. Add both now — Stage 3's
      keyword arm is blocked on it.

**Relation vocabulary (pin this before writing any extraction code)**

- [x] `packages/db/src/graph/vocab.ts`: export a closed Zod enum of entity types
      (`pokemon`, `type`, `move`, `ability`, `item`, `region`, `group`) and of
      relations (`evolves_into`, `has_type`, `super_effective_against`,
      `not_very_effective_against`, `no_effect_on`, `learns_move`, `has_ability`,
      `found_in`, `member_of`, `regional_variant_of`, `mega_evolves_into`). The
      *same* enum feeds the LLM extraction schema and the traversal filter, so an
      invented relation is a type error rather than a silent orphan edge.
- [x] **Store each edge in one direction only** and traverse both ways. Export an
      `INVERSE_LABEL` map (`evolves_into` → `evolves_from`) purely for rendering.
      Duplicating inverse edges doubles your write path and guarantees they drift.

**Deterministic seed (facts that must be exact)**

- [x] `packages/db/seed/graph/type-chart.ts`: the 18×18 type-effectiveness matrix as
      plain TypeScript, plus one `entity` per type. Load it with `origin: 'seed'`,
      `confidence: 1.0`, and the multiplier in `properties` (`{ multiplier: 2 }`).
- [x] **Conflict policy:** a seed edge always wins over an LLM edge on the same
      `(source, relation, target)`. Never let extraction overwrite ground truth.

**LLM extraction (everything else)**

- [x] `packages/db/prompts/extract-graph@v1.md` — versioned file, matching the
      convention Stage 3 uses for prompts. Log the version on every extraction run.
- [x] `packages/db/src/graph/extract.ts`: for each chunk, call `extract()` from the
      gateway client with a Zod schema shaped
      `{ entities: [{ name, type, aliases }], relations: [{ source, relation, target, properties, confidence }] }`,
      with `relation` and `type` bound to the vocab enums. Instruct the model to emit
      **only** what the chunk text supports and to skip anything it is unsure of —
      a missing edge costs you recall, a wrong edge costs you a wrong answer.
- [x] Batch with bounded concurrency, reusing the `mapWithConcurrency` helper already
      in `ingest.ts`. One call per chunk is ~20 calls for the current seed corpus
      (trivial), but it becomes the dominant ingestion cost at scale — which is
      exactly why the next task matters.

**Entity resolution (the messy part — where graphs actually go wrong)**

- [x] `packages/db/src/graph/resolve.ts`, a cascade, each step cheaper than the next:
      normalize the name (lowercase, strip punctuation/accents) → exact match on
      `entities` → exact match on `entity_aliases` → cosine match against
      `entities.embedding` above a tuned threshold → otherwise create a new entity.
- [x] Log every resolution that lands on the embedding step. That log is your tuning
      dataset for the threshold, and it is where you'll catch "Mr. Mime" splitting
      into three nodes.
- [x] Unit-test the normalizer and the cascade with fixtures: `Nidoran♀`, `Mr. Mime`,
      `Farfetch'd`, `Alolan Raichu` vs `Raichu`, `Pikachu` vs `pikachu`.

**Traversal**

- [x] `packages/db/src/graph/traverse.ts` → `graphExpand(seedChunkIds, opts)` where
      `opts` is `{ maxHops = 2, maxNodes = 50, relations? }`. One recursive CTE:

```sql
WITH RECURSIVE seed AS (
  SELECT entity_id, 0 AS hops
  FROM chunk_entities WHERE chunk_id = ANY($1)
),
reachable AS (
  SELECT entity_id, hops FROM seed
  UNION                                    -- UNION (not ALL) dedupes = cycle guard
  SELECT CASE WHEN e.source_entity_id = r.entity_id
              THEN e.target_entity_id ELSE e.source_entity_id END,
         r.hops + 1
  FROM reachable r
  JOIN edges e ON r.entity_id IN (e.source_entity_id, e.target_entity_id)
  WHERE r.hops < $2
)
SELECT ce.chunk_id, MIN(r.hops) AS hops, COUNT(*) AS mentions
FROM reachable r
JOIN chunk_entities ce ON ce.entity_id = r.entity_id
GROUP BY ce.chunk_id
ORDER BY hops ASC, mentions DESC
LIMIT $3;
```

- [x] Return a **ranked list**, ordered by hop distance then edge confidence then
      mention count. Ranked — not scored — because Stage 3 fuses with Reciprocal Rank
      Fusion, which only consumes ranks. This is what makes the graph drop into the
      existing fusion step as just another arm.
- [x] `packages/db/src/graph/facts.ts` → `graphFacts(entityIds, opts)`: render the
      subgraph as one line per edge with its source chunk id attached, ready to paste
      into the Stage 3 context block. Cap the line count; a 200-edge dump will crowd
      out the actual passages.

**Idempotency & garbage collection (the bug you will otherwise ship)**

- [x] Re-ingesting a changed document deletes and recreates its chunks. `chunk_entities`
      and `edge_chunks` cascade away with them — but the `entities` and `edges` they
      pointed at **do not**. Add a GC pass: delete edges with zero remaining
      `edge_chunks`, then entities with zero remaining `chunk_entities`. Run it at the
      end of ingestion.
- [x] Key extraction off the chunk, so an unchanged document costs zero LLM calls on
      re-ingest — same content-hash logic `ingestFile` already uses.

**Scripts & tests**

- [x] `scripts/build-graph.ts` — seed the type chart, then extract over all chunks,
      then GC. Print a summary: entities, edges by relation, orphans dropped.
- [x] `scripts/graph-query.ts` — take a question, print the seed chunks, the entities
      they resolved to, the expanded chunk ids with hop counts, and the serialized
      facts. **This is your debugging window into the whole layer; build it early.**
- [x] Vitest: resolution cascade (unit); the traversal CTE against a hand-built
      fixture graph asserting hop counts and cycle termination (integration);
      extraction schema validation against a canned model response.

**Key files:** `packages/db/src/graph/{schema,vocab,extract,resolve,traverse,facts,render,seed,build,stats,retrieve,type-chart}.ts`,
`packages/db/prompts/extract-graph@v2.md`.

### Implementation notes (what actually happened)

Five things came out differently from the plan above. Recorded here because each
one is a decision a reader would otherwise have to reverse-engineer.

1. **The type chart lives in `src/graph/type-chart.ts`, not `seed/graph/`.** The
   package's `tsconfig` sets `rootDir: "src"`, so a `.ts` file under `seed/`
   breaks the build. `seed/` stays what it was: the markdown corpus.
2. **Relative imports inside the two schema files are extensionless.** drizzle-kit
   loads schema files as CJS and does not rewrite a `.js` specifier back to the
   `.ts` source, so `./column-types.js` fails there while working everywhere
   else. Both files carry a comment saying so.
3. **`@app/db` had to move to zod 4.** `@app/llm-client` pins `zod: latest`
   (4.x), and `extract()`'s schema parameter is typed against it — a v3 schema
   from `@app/db` is not assignable. `@app/shared` stays on v3; it never crosses
   that boundary.
4. **Extraction is refused outright for type-vs-type effectiveness.** The plan
   said seed edges win a conflict, which they do — but the first real build
   showed that isn't enough. All 10 type→type effectiveness edges the model
   produced were *new triples the chart doesn't contain*, so they never hit the
   conflict path, and all 10 were wrong: `Poison not_very_effective_against
   Fairy` (backwards — it's 2x), `Ghost no_effect_on Fighting` (inverted),
   `Electric not_very_effective_against Ground` (it's a 0x immunity). Since the
   chart is *exhaustive* for that family, `isSeedOwned()` now drops those
   triples at the cleaning stage. The general rule: where ground truth is
   complete, extraction is not consulted at all.
5. **A `chunk_extractions` ledger table was added**, which the plan didn't name.
   Without it, a chunk that legitimately yields zero entities gets re-extracted
   on every run forever, and "zero LLM calls on an unchanged corpus" is never
   true. Keyed by prompt version, so bumping the prompt re-extracts the corpus —
   which is exactly how the v1→v2 fix above was rolled out, and how the stale
   bad edges got dropped: they lost their provenance rows, and the GC pass
   collected them.

**Two budget bugs the plan's single `maxNodes` cap would have shipped.** Both only
became visible by reading `graph-query.ts` output, which is the argument for
building that script early:

- *A global node cap means the traversal never traverses.* Five seed chunks
  mention 100+ entities, so `ORDER BY hops LIMIT 50` was spent entirely on hop 0
  and every result came back at distance 0. Fixed with a per-hop budget
  (`maxNodesPerHop`). Ranking matters too: the original `ORDER BY hops,
  canonical_name` truncated *alphabetically*, keeping Acid Armor and Aerodactyl
  over Dragon and Eevee. Hop 0 now ranks by mention count; deeper hops rank by
  how many seed entities link back to them.
- *Expansion caps are the wrong budget for facts.* Capping entities dropped
  `Fairy` from a question about Dragons — and `Fairy super_effective_against
  Dragon` is the one fact that answers it. Facts now draw on the **uncapped**
  seed entity set, ranked by relevance to the most-mentioned entities, with a
  per-entity cap (`maxFactsPerEntity`) so one dense `type` node can't spend the
  whole block: each type carries ~11 effectiveness edges, and without the cap
  40 facts covered three entities exhaustively and the rest not at all.

**Derived matchups: the graph's first real composition.** An audit of the built
graph prompted the question "do edges only hold effectiveness?" The answer is
no — effectiveness is 120 of 341 edges — but it is the only family carrying
anything beyond a label. Only two property keys exist corpus-wide: `multiplier`
(120 seed edges) and `method` (18 of 19 `evolves_into`, e.g. `level 16`, `trade`).

The gap that mattered wasn't a missing edge type, it was that nothing multiplied
the edges together. Charizard is Fire/Flying, and the chart facts serialized
individually are *actively misleading*: `Ground super_effective_against Fire`
(2x) reads as decisive, while the fact that Flying is immune to Ground sits in a
separate line — so the correct answer, 0x, is one a model has to derive and
routinely won't. Likewise nothing states Rock hits it for 4x. `matchup.ts` walks
`has_type` and multiplies the seeded chart across every type a Pokémon has,
emitting one line per defender:

```
Charizard (Fire/Flying) takes 4x from Rock; 2x from Electric, Water;
0.5x from Fairy, Fighting, Fire, Steel; 0.25x from Bug, Grass; 0x from Ground
```

Three properties worth preserving. It reads `origin = 'seed'` only — composing
extracted effectiveness edges would multiply the model's mistakes together.
Neutral results are dropped, because a 2x cancelling a 0.5x is a line the reader
must process for no information. And the arithmetic needs no citation (it's
exact over ground truth), so the rendered provenance is the `has_type` edges —
the one *fallible*, extracted input.

That fallibility is not hypothetical: `Zapdos` has three recorded types
(Electric/**Fighting**/Flying) because a Galarian Zapdos passage leaked onto the
base species, and the derived line inherits the error — it loses the Rock
weakness and gains bogus Fairy and Psychic ones. Composition amplifies bad
typing rather than diluting it, so `has_type` precision now matters more than
its recall. Guarding regional forms against attribute leakage is the follow-up.

**Two things deliberately not done**, recorded so they aren't re-litigated:
*generation scoping* — the seeded chart is Gen 6+ while the corpus is explicitly
Gen 1 Kanto, so `Fairy super_effective_against Dragon` is true today and false
for a Gen-1 question, and no edge records its ruleset; and *trimming
`learns_move`*, which is 103 edges (30% of the graph), carries almost no
properties, and is the main source of the hub fan-out that forced the per-hop
caps.

**Unrelated pre-existing bug this surfaced.** `documents.source_uri` stores an
**absolute filesystem path**, so the same file ingested from two checkout
locations becomes two documents with duplicate chunks. The corpus here was
ingested from `C:\dev\AI_Rag_Project\…` while the repo now lives elsewhere, so
the Stage 2 integration test — which resolves the fixture relative to itself —
silently added a second copy of `mewtwo-and-mew.md`. The duplicate was removed
and the test now cleans up in `afterAll`, but the underlying keying is worth
changing to a repo-relative path in Stage 2.

### Concept checks to eyeball

- Every edge reaches a chunk id through `edge_chunks`. An edge with no provenance is
  an uncitable claim — treat a nonzero count here as a bug, not a statistic.
- `graphExpand` with `maxHops: 0` returns exactly the seed chunks. With `maxHops: 3`
  on this corpus it will return nearly everything — that's the precision cliff, and
  seeing it is the point.
- Re-run `build-graph.ts` twice with no source changes: entity and edge counts must be
  identical, and it should make zero LLM calls the second time.
- Look at the actual `entities` list. If you see `Pikachu`, `pikachu`, and
  `Pikachu (Electric)` as three rows, resolution is broken — fix it before tuning
  anything downstream.

**Done when:** `pnpm graph:build` produces a graph over the seed corpus, and
`pnpm graph:query "Which Eevee evolution beats Dragon types?"` shows seed chunks that
mention Dragon, a walk that reaches hop 1 and hop 2, chunks in the expanded set that
**plain `semanticSearch` did not return**, and `Fairy --super_effective_against(2x)-->
Dragon` in the fact block. That delta is the entire justification for this stage — if
it's empty, the graph isn't earning its keep yet.

> The original wording here expected the 2-hop walk to surface *Glaceon and Sylveon*.
> It can't: the seed corpus is Gen 1 Kanto and contains neither — `eevee-evolutions.md`
> only covers Vaporeon, Jolteon and Flareon. The check above is the same idea against
> content that actually exists. **Measured:** 199 entities, 341 edges, 317 mentions,
> and 10 chunks contributed that the semantic top-5 never returned.

---

# Stage 3 — RAG query pipeline as a service (Patterns 4 + 2)

**Goal:** `apps/knowledge` exposes `POST /ask` → grounded answer **with citations**,
using hybrid retrieve → rerank → generate. This is also your first real **LLM
service**: typed contract, prompt versioning, re-ask loop.

**Depends on:** Stages 2 and 2.5.

**Tasks:**
- [ ] **Hybrid retrieve — three arms:** semantic (`<=>`), keyword
      (`tsv @@ plainto_tsquery`), and **graph** (`graphExpand` seeded with the top ~10
      semantic hits). Fuse all three with Reciprocal Rank Fusion → top ~50 candidates.
      Give each arm a weight in the RRF sum and put the graph arm's weight behind an
      env flag, so Stage 6 can A/B it against a two-arm baseline.
- [ ] **Rerank:** Cohere Rerank over the 50 → keep top ~5. Put it behind a
      `Reranker` interface (swap to Bedrock later).
- [ ] **Assemble + generate:** build a context block with source tags; prompt the
      model (via gateway) to answer *only* from context and cite chunk ids. When the
      query resolved to at least one entity, prepend a `graphFacts` block above the
      passages — structured relationships first, prose second. Those facts carry chunk
      ids too, so they cite exactly like passages and the grounding rule needs no
      special case.
- [ ] **Typed contract + re-ask:** `generateObject` with a Zod schema
      `{ answer, citations: chunkId[] }`; if it cites a chunk not in context or
      returns invalid shape, **re-ask once** (this is the service-level retry,
      distinct from the gateway's provider retry).
- [ ] Store prompts as versioned files (`prompts/answer@v1.md`); log the version used.
- [ ] Hono route `POST /ask`; Zod-validate the request.

**Key files:** `apps/knowledge/src/{retrieve,rerank,answer,server}.ts`,
`apps/knowledge/prompts/`.

**Done when:** `POST /ask {"q":"..."}` returns an answer plus citation chunk ids
that actually exist in the retrieved set. Ask something *not* in the corpus → it
declines rather than hallucinating (grounding works). Verify each arm earns its keep:
a query using an exact code/SKU that semantic-alone missed now hits via the keyword
arm, and a multi-hop question that semantic-alone missed now hits via the graph arm.

---

# Stage 4 — Async ingestion worker (Pattern 3)

**Goal:** ingestion moves off the request path. Submit a doc → get a job id back
instantly → `apps/worker` processes it → status is pollable.

**Depends on:** Stages 2–3.

**Tasks:**
- [ ] `apps/knowledge`: `POST /documents` validates, enqueues a BullMQ job, returns
      `202 { jobId }`. Add `GET /jobs/:id` reading a status record.
- [ ] `apps/worker`: BullMQ consumer runs the Stage 2 ingestion, then the Stage 2.5
      graph extraction as a second phase of the same job, then the orphan GC pass.
      Extraction is the slower half, so report it as its own status phase.
- [ ] **Concurrency limiter** on the worker (cap in-flight embeds) so a burst of
      docs doesn't blow provider rate limits — let the queue absorb the spike.
- [ ] **Idempotency:** job keyed by content hash; skip if already ingested.
- [ ] **DLQ:** after N attempts, route to a failed queue **tagged** with reason
      (poison input vs provider outage) so replay-vs-quarantine is a clear decision.
- [ ] Job status transitions (`pending→processing→done|failed`) persisted so polling
      shows progress (`chunks embedded: 12/40`).

**Key files:** `apps/worker/src/{consumer,limiter}.ts`, `apps/knowledge/src/jobs.ts`.

**Done when:** `POST /documents` returns `202 + jobId` in <100ms; the worker ingests
it; `GET /jobs/:id` goes `pending→done`; submitting the **same** doc twice ingests
once. Kill the worker mid-job and restart → it resumes/re-tries rather than
corrupting state.

---

# Stage 5 — Orchestrator + router (Pattern 5)

**Goal:** `apps/orchestrator` is the public front door. It **routes**
(deterministic vs LLM) and, for tasks that need it, runs a **tool-calling agent**
whose tools include the knowledge service.

**Depends on:** Stages 3–4.

**Tasks:**
- [ ] **Router** (the cascade): rules → cheap classifier (`extract` with a
      category+confidence schema) → **confidence floor** → deterministic handler,
      agent, or human. Two tunable knobs: the floor and the deterministic-category list.
- [ ] **Tools:** wrap capabilities as AI-SDK tools — `searchKnowledge` (calls
      `apps/knowledge`), plus 1–2 plain stubs (e.g. `getOrderStatus`) to prove the
      "agent calls your existing microservices" point.
- [ ] **Agent loop:** AI-SDK tool-calling loop (plan → call tool → observe → repeat),
      bounded by a max-steps cap so it can't wander/burn budget.
- [ ] `POST /handle` public endpoint; structured log per request
      (category, target, confidence, reason, tools called) — your audit trail **and**
      routing-eval dataset.

**Key files:** `apps/orchestrator/src/{router,tools,agent,server}.ts`.

**Done when:** an FAQ-style question routes to the deterministic path (no agent);
a knowledge question triggers the agent, which calls `searchKnowledge` and answers
with citations; a low-confidence/ambiguous message routes to the human stub. The
step cap provably halts a runaway loop.

---

# Stage 6 — Observability, evals & guardrails (hardening)

**Goal:** you can *measure* quality and cost, not just eyeball it.

**Depends on:** Stages 3–5.

**Tasks:**
- [ ] Trace every request end-to-end (OpenTelemetry or structured logs): tokens,
      cost, latency per stage. LiteLLM already emits usage — surface it.
- [ ] **RAG eval harness:** a fixtures set of question→expected-source pairs; script
      scores retrieval (did the right chunk get retrieved?) and faithfulness (is the
      answer grounded in cited chunks?). This is what lets you change chunking/rerank
      and *know* if it helped.
- [ ] **Graph A/B:** tag fixtures by the failure mode they probe — `multi_hop`,
      `set`, `sparse_mention`, `exact_fact`, `simple` — then run the harness twice
      with the graph arm off and on. Report per-tag deltas, not one blended number:
      the graph should move the first four sharply and leave `simple` flat. If
      `simple` *regresses*, the graph arm's RRF weight is too high or `maxHops` is too
      deep. Seed the fixtures with questions like "Which Eevee evolution beats Dragon
      types?" (multi-hop), "List every Pokémon here weak to Ghost" (set), "Is Ghost
      super effective against Psychic?" (exact fact).
- [ ] **Router eval:** replay logged messages, assert routing decisions; use it to
      tune the confidence floor.
- [ ] Guardrails: input length caps, a PII scrub pass before embedding/logging.

**Key files:** `eval/`, `apps/*/src/telemetry.ts`.

**Done when:** `pnpm eval:rag` prints retrieval + faithfulness scores over the
fixtures; you can change the chunk size, re-run, and see the number move.

---

## How to work this in Cursor

1. Import the repo; keep this file at root so the agent can reference stage context.
2. Implement **one stage per session**. Paste the stage heading and say "implement
   this stage; stop at the Done-when check."
3. After each stage, actually run the **Done when** check before continuing —
   later stages assume earlier ones work.
4. Stage 2 is the one to slow down on. If a search returns nonsense, 90% of the time
   it's chunking or a dimension mismatch — check those two first.

## Suggested order & effort

0 → 1 are a day of scaffolding. **Stage 2 is the heart — budget real time there.**
2.5 is the second-biggest chunk of work and the one that most distinguishes this from
a tutorial RAG app; do it before 3, not after. 3 gives you a working RAG demo (good
stopping point / portfolio artifact). 4–5 turn it into the multi-service agentic
system. 6 is what makes it *credibly senior* — most people skip evals; having them is
a strong interview signal for your target roles, and it's the only way to prove the
graph in 2.5 actually paid for itself.
