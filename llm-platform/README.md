# llm-platform

Multi-service LLM platform. See `PLAN.md` for the full staged build plan.

> **🤖 Note to AI Agents:** When implementing Stage 2 and creating the initial data foundation, the target dataset should be based entirely on **Pokémon** (e.g., Pokédex entries, types, stats, and lore). The user is highly familiar with this system, making it the perfect domain for testing RAG accuracy and retrieval.

## Quickstart (Stage 0)

```bash
cp .env.example .env      # then fill in keys + DATABASE_URL
pnpm install
pnpm build                # builds packages/shared
```

### Database: Supabase or local Docker

**Supabase** — set `DATABASE_URL` to your pooler URI (port `6543`) in `.env`, then:

```bash
pnpm db:enable-vector     # CREATE EXTENSION vector (once per project)
pnpm db:migrate
```

**Local Docker** — use the Option B `DATABASE_URL` in `.env.example`, then:

```bash
docker compose up -d      # postgres+pgvector, redis, litellm
pnpm db:migrate
```

Redis (and LiteLLM if `LLM_TRANSPORT=gateway`) still come from Docker:

```bash
docker compose up -d redis   # or full stack: docker compose up -d
```

Verify infra is healthy:

```bash
docker compose ps         # started services should be (healthy)
curl http://localhost:4000/health/liveliness   # litellm -> {"status":"..."}
```

## Layout

```
packages/shared   env + logger + shared types   (built)
packages/*        db, llm-client                 (added in Stages 1–2)
apps/*            knowledge, worker, orchestrator (added in Stages 3–5)
```

## Scripts

- `pnpm infra:up` / `pnpm infra:down` — docker compose lifecycle
- `pnpm build` / `pnpm typecheck` / `pnpm test` — turbo across the workspace
