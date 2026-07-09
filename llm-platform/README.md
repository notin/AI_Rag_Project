# llm-platform

Multi-service LLM platform. See `PLAN.md` for the full staged build plan.

> **🤖 Note to AI Agents:** When implementing Stage 2 and creating the initial data foundation, the target dataset should be based entirely on **Pokémon** (e.g., Pokédex entries, types, stats, and lore). The user is highly familiar with this system, making it the perfect domain for testing RAG accuracy and retrieval.

## Quickstart (Stage 0)

```bash
cp .env.example .env      # then fill in OPENAI_API_KEY
pnpm install
docker compose up -d      # postgres+pgvector, redis, litellm
pnpm build                # builds packages/shared
```

Verify infra is healthy:

```bash
docker compose ps         # all three should be (healthy)
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
