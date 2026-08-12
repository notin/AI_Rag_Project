# llm-platform

Multi-service LLM platform. See `PLAN.md` for the full staged build plan.

> **🤖 Note to AI Agents:** When implementing Stage 2 and creating the initial data foundation, the target dataset should be based entirely on **Pokémon** (e.g., Pokédex entries, types, stats, and lore). The user is highly familiar with this system, making it the perfect domain for testing RAG accuracy and retrieval.

## Quickstart (Stage 0)

```bash
cp .env.example .env      # then fill in keys + DATABASE_URL
pnpm install
pnpm build                # builds packages/shared
```

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
- `pnpm build` / `pnpm typecheck` / `pnpm test` — turbo across the workspace
- `pnpm --filter @app/db test:integration` — DB-backed tests (needs a live database)
