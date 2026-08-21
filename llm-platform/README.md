# llm-platform

Multi-service LLM platform. See `PLAN.md` for the full staged build plan.

> **🤖 Note to AI Agents:** When implementing Stage 2 and creating the initial data foundation, the target dataset should be based entirely on **Pokémon** (e.g., Pokédex entries, types, stats, and lore). The user is highly familiar with this system, making it the perfect domain for testing RAG accuracy and retrieval.

## Quickstart (Stage 0)

```bash
cp .env.example .env      # then fill in keys + DATABASE_URL
pnpm install
pnpm build                # compiles every package to dist/ with source maps
```

Every workspace package is consumed as built JS (`dist/`), so `pnpm build` must
have run before anything that imports `@app/db` — that includes `pnpm ask`,
`pnpm search`, `pnpm graph:*` and `pnpm db:generate`. Keep `pnpm build --watch`
running, or just rebuild when you switch branches.

### Database: Supabase (pgvector)

The database is hosted on **Supabase**. Set `DATABASE_URL` to your pooler URI
(port `6543`, transaction mode) in `.env`, then:

```bash
pnpm db:enable-vector     # CREATE EXTENSION vector (once per project)
pnpm db:migrate
```

The DB client (`packages/db/src/client.ts`) auto-detects Supabase and applies
pooler-safe settings (`prepare: false`, `ssl: require`, small pool).

<details>
<summary>Alternative: local Docker Postgres</summary>

Instead of Supabase you can run Postgres+pgvector locally. Use the Option B
`DATABASE_URL` in `.env.example`, then:

```bash
docker compose up -d      # postgres+pgvector, redis, litellm
pnpm db:migrate
```
</details>

### Other infra (Redis / LiteLLM)

Redis (and LiteLLM if `LLM_TRANSPORT=gateway`) still come from Docker:

```bash
docker compose up -d redis   # or full stack: docker compose up -d
```

Verify infra is healthy:

```bash
docker compose ps         # started services should be (healthy)
curl http://localhost:4000/health/liveliness   # litellm -> {"status":"..."}
```

## Chat model (DeepSeek V4)

Chat calls go through `@app/llm-client`. Call sites do not name a provider
model; two env flags pick the OpenRouter slug (or the LiteLLM alias, when
`LLM_TRANSPORT=gateway`):

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `LLM_CHAT_TIER` | `pro` / `flash` | `pro` | Which DeepSeek V4 to call |
| `LLM_THINKING` | `true` / `false` | `true` | V4 thinking / `reasoning_effort` |

Current mapping (OpenRouter, dated so a silent hub alias cannot drift):

| Tier | OpenRouter slug | Gateway alias | Released | Notes |
| --- | --- | --- | --- | --- |
| `pro` | `deepseek/deepseek-v4-pro-0813` | `chat-main` | 2026-08-12 | Flagship, 1M context, ~$0.435/$0.87 per 1M |
| `flash` | `deepseek/deepseek-v4-flash-0731` | `chat-cheap` | 2026-07-31 | Faster/cheaper, 1M context, ~$0.08/$0.16 per 1M |

`deepseek/deepseek-chat` was DeepSeek **V3** (Dec 2024). Do not reuse that slug;
it is not V4.

Thinking is **on by default** on V4. `LLM_THINKING=true` sends
`reasoning_effort=high`; `false` sends `none`. Reasoning tokens count against
the completion budget, so the client caps output at 8192 tokens when thinking
is on (2048 when off). Structured calls (`generateObject` in answer generation
and graph extraction) still work with thinking on, but they are slower and
more expensive — flip `LLM_THINKING=false` if JSON shape starts failing or
latency is too high.

Embeddings stay on `openai/text-embedding-3-small` (1536-dim). Changing the
chat model does not require re-embedding.

When a new V4 GA lands, bump the dated slugs in `packages/llm-client/src/index.ts`
and `litellm.config.yaml` together, then update this table.

## Knowledge graph (Stage 2.5)

A typed entity/relationship graph lives in the same Postgres as the vectors, as
ordinary tables walked with a recursive CTE. It gives retrieval a third arm
alongside semantic and keyword search.

```bash
pnpm ingest:seed          # chunks + embeddings first — the graph is built from chunks
pnpm graph:build          # seed the type chart, extract entities/relations, GC orphans
pnpm graph:query "Which Eevee evolution beats Dragon types?"
```

`graph:build` is incremental: an extraction ledger records the prompt version per
chunk, so re-running it on an unchanged corpus makes **zero** LLM calls. Pass
`--force` to re-extract anyway, or `--model=<id>` to override the extractor.

`graph:query` is the debugging window into the whole layer. It prints each stage —
the seed chunks the vector arm found, the entities they resolved to, how far the
traversal reached, the chunks it added that semantic search *missed*, and the
serialized facts. That "added" list is the point; if it's empty for a multi-hop
question, look at extraction coverage and entity resolution in that order.

Three mechanisms, worth keeping distinct:

- **Graph expansion** (recall) — walks from the seed chunks' entities to find
  chunks no embedding would have matched, then hands them to the reranker.
- **Fact serialization** (precision) — renders the subgraph as citable one-liners
  (`Ice --super_effective_against(2x)--> Dragon [chunk:8f3a1c2d]`) so the model
  reads structure instead of inferring direction from prose.
- **Derived matchups** (composition) — multiplies the type chart across a
  Pokémon's `has_type` edges to state something no single edge holds:

  ```
  Charizard (Fire/Flying) takes 4x from Rock; 2x from Electric, Water;
  0.5x from Fairy, Fighting, Fire, Steel; 0.25x from Bug, Grass; 0x from Ground
  ```

  The last entry is the point. `Ground --super_effective_against(2x)--> Fire` is
  a true fact that produces a wrong answer here, because Flying is immune and a
  zero anywhere in the product wins. Only seeded edges are composed, so the
  arithmetic is exact; the citation on the line is the `has_type` provenance,
  since that's the only extracted input.

Type effectiveness is seeded from a hand-encoded chart rather than extracted, and
extraction is *refused* for that family — see the Stage 2.5 implementation notes
in `PLAN.md` for the measurement that forced that rule.

## Knowledge service (Stage 3)

`POST /ask` answers a question from the corpus with citations, over a
retrieve → rerank → generate pipeline.

```bash
pnpm knowledge            # tsx watch on http://localhost:3001
curl -s localhost:3001/ask -H 'content-type: application/json' \
  -d '{"q":"What is Mewtwo weak to?"}'
```

Retrieval runs three arms and fuses their *rankings* with Reciprocal Rank Fusion,
because cosine similarity, `ts_rank` and hop distance are not on a common scale:

```
RRF(doc) = Σ_arms  weight_arm / (60 + rank_in_arm)
```

The graph arm walks out from the top semantic hits, so it runs after them rather
than in parallel. It hands those hits to `graphRetrieve` as seeds instead of
letting it embed the query a second time.

Generation puts structure above prose. Graph facts (`f1`, `f2`, …) and derived
matchups (`m1`, …) are prepended to the passages (`c1`, …), and all three are
citable through the same label check — a bogus label triggers one re-ask, and any
still-invalid label is dropped rather than returned. The response reports what the
graph contributed:

```json
"graph": { "expanded": 15, "facts": 40, "matchups": 8, "seedEntities": 57 }
```

Every arm is behind an env flag so it can be A/B'd (see `.env.example`):

| Variable | Default | Effect |
| --- | --- | --- |
| `GRAPH_ARM_ENABLED` | `true` | Master switch. `false` = two-arm baseline. |
| `GRAPH_FACTS_ENABLED` | `true` | Fact/matchup prompt block, independent of the arm. |
| `RRF_WEIGHT_{SEMANTIC,KEYWORD,GRAPH}` | `1` | Per-arm weight; `0` drops the arm from fusion. |
| `GRAPH_SEED_K` / `GRAPH_MAX_HOPS` | `5` / `2` | Semantic hits that seed the walk, and walk depth. |
| `GRAPH_MAX_WALK_SEEDS` | `12` | Entities the walk starts from (Pokémon first). |
| `GRAPH_MAX_NODES` / `GRAPH_MAX_NODES_PER_HOP` | `32` / `12` | Walk output caps. |
| `GRAPH_MIN_SHARED_ENTITIES` | `2` | Reached entities a chunk must mention to be returned. |

Tune `GRAPH_MIN_SHARED_ENTITIES` against your own corpus. It is a corroboration
bar on the graph arm, and the value that filters usefully scales with how many
entities a chunk mentions — on a corpus averaging ~15 entities per chunk, a bar
of 2 is met by everything and only ~8 begins to discriminate.

Reranking falls back to a passthrough that trusts the RRF order when
`COHERE_API_KEY` is unset, so the pipeline works without a rerank provider.
`pnpm --filter @app/knowledge rerank:ab "…"` shows the cross-encoder reordering
the same candidate set.

## Debugging

`pnpm knowledge` runs the fast tsx watch loop, but tsx serves the debugger
whitespace-minified code on a single line, so IDE breakpoints cannot bind to it.
Debug the compiled server directly — not an npm/pnpm wrapper, or the inspector
attaches to pnpm/turbo and you get "Waiting for the debugger to disconnect".

```bash
pnpm build
pnpm knowledge:debug      # node --inspect-brk=9229 --enable-source-maps apps/knowledge/dist/server.js
```

In IntelliJ, use a **Node.js** run configuration (not npm/pnpm Debug):

- **JavaScript file:** `apps/knowledge/dist/server.js`
- **Working directory:** `llm-platform`
- **Node parameters:** `--inspect-brk=9229 --enable-source-maps`
- **Before launch:** `pnpm build` (or `tsc` on `@app/knowledge`)

Breakpoints go in the `.ts` sources and resolve through `.js.map`, including
across package boundaries into `@app/db` and `@app/shared`. There is no file
watcher on this path — rebuild, then start the debug configuration again.

## Layout

```
packages/shared      env + logger + shared types    (built)
packages/llm-client  typed gateway client           (Stage 1)
packages/db          schema, chunking, ingest, vector search  (Stage 2)
packages/db/src/graph  entities, edges, extraction, traversal (Stage 2.5)
apps/*               knowledge, worker, orchestrator (added in Stages 3–5)
```

## Scripts

- `pnpm infra:up` / `pnpm infra:down` — docker compose lifecycle
- `pnpm db:migrate` — apply SQL migrations from `packages/db/drizzle`
- `pnpm ingest:seed` / `pnpm search "…"` — vector store (Stage 2)
- `pnpm graph:build` / `pnpm graph:query "…"` — knowledge graph (Stage 2.5)
- `pnpm knowledge` — the `POST /ask` service (Stage 3)
- `pnpm build` / `pnpm typecheck` / `pnpm test` — turbo across the workspace
- `pnpm --filter @app/db test:integration` — DB-backed tests (needs a live database)
