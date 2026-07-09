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
                 └───────────┘  └───┬──────────┘
                                    │
   all model calls go through ──────┴────▶ LiteLLM gateway (Pattern 1) ─▶ providers
```

**Five patterns, mapped to code:**
1. **Gateway** → LiteLLM (Docker) + `packages/llm-client` thin typed client.
2. **LLM service** → `apps/knowledge` exposes a typed contract, owns prompts + re-ask loop.
3. **Async** → `apps/worker` consumes a BullMQ queue for ingestion.
4. **RAG** → `apps/knowledge` ingestion + query pipelines over pgvector.
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
| Rerank | Cohere Rerank API | Simple hosted cross-encoder (swap: Bedrock) |
| Queue | BullMQ + Redis | SQS-like semantics, runs locally |
| Tests | Vitest | — |

**Swap notes for your AWS target:** BullMQ→SQS, LiteLLM→Bedrock+gateway,
pgvector→OpenSearch/Aurora pgvector, Cohere→Bedrock Rerank. The plan keeps these
behind interfaces so the swap is localized.

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

# Stage 3 — RAG query pipeline as a service (Patterns 4 + 2)

**Goal:** `apps/knowledge` exposes `POST /ask` → grounded answer **with citations**,
using hybrid retrieve → rerank → generate. This is also your first real **LLM
service**: typed contract, prompt versioning, re-ask loop.

**Depends on:** Stage 2.

**Tasks:**
- [ ] **Hybrid retrieve:** run semantic (`<=>`) and keyword (`tsv @@ plainto_tsquery`)
      searches, fuse results (Reciprocal Rank Fusion) → top ~50 candidates.
- [ ] **Rerank:** Cohere Rerank over the 50 → keep top ~5. Put it behind a
      `Reranker` interface (swap to Bedrock later).
- [ ] **Assemble + generate:** build a context block with source tags; prompt the
      model (via gateway) to answer *only* from context and cite chunk ids.
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
declines rather than hallucinating (grounding works). Verify hybrid earns its keep:
a query using an exact code/SKU that semantic-alone missed now hits via the keyword arm.

---

# Stage 4 — Async ingestion worker (Pattern 3)

**Goal:** ingestion moves off the request path. Submit a doc → get a job id back
instantly → `apps/worker` processes it → status is pollable.

**Depends on:** Stages 2–3.

**Tasks:**
- [ ] `apps/knowledge`: `POST /documents` validates, enqueues a BullMQ job, returns
      `202 { jobId }`. Add `GET /jobs/:id` reading a status record.
- [ ] `apps/worker`: BullMQ consumer runs the Stage 2 ingestion.
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
3 gives you a working RAG demo (good stopping point / portfolio artifact). 4–5 turn
it into the multi-service agentic system. 6 is what makes it *credibly senior* — most
people skip evals; having them is a strong interview signal for your target roles.
