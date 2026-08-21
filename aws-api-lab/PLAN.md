# PLAN.md — AWS Serverless API Lab (Interview Artifact)

A staged, checkpoint-driven build of a small CRUD API on AWS. The point is not
to ship a product. The point is to have **one real system** you can open during
prep and talk about in 60–90 seconds per question: contract, gateway, Lambda,
DynamoDB, async jobs, IAM, Terraform, and a merge-request gate.

Work it the same way as the RAG `PLAN.md`: feed Cursor one stage at a time
("implement Stage 2"), run the **Done when** check, then stop.

> **Priority:** Stages 1–4 are the interview core (API design, errors, gateway
> controls, Lambda sizing, async create). Stages 5–7 are the DevOps screen
> (IAM, alarms, CI). Stage 8 is CloudFront brush-up and is optional.

This lab is **separate** from `llm-platform/`. Do not fold it into the RAG
monorepo. Keep blast radius and mental models apart.

---

## What this is for

Caleb's round is a judgment screen: *can this person be handed an AWS account
and not create an incident?* Trivia will not save you. A repo you actually
applied (or at least `terraform plan`ned) will.

**Domain (pinned, matches the talking points):** `assets` with nested
`harvests`. A harvest create is **async** (202 + job resource + EventBridge/SQS
worker). That is the Sinclair harvest/VOD shape without dragging media
packaging into the lab.

**How you will use it the night before:** each interview question maps to a
folder. Open the file, say the default, name the tradeoff, point at the thing
you shipped. Mapping is at the bottom of this document.

---

## Architecture

```
 Client
   │  HTTPS, Idempotency-Key on POST, If-Match on PUT/PATCH
   ▼
 API Gateway REST API  (/v1)
   │  request validators (JSON Schema from OpenAPI)
   │  Gateway Responses → same problem+json envelope as the app
   │  JWT authorizer (coarse) + usage plan (identification, not auth)
   │  throttle per method
   ▼
 Lambda  (thin adapter — one function per scaling/IAM unit)
   │  domain module has zero aws-lambda types
   ▼
 DynamoDB  (assets, harvests, jobs)
   │
   │  POST /assets/{id}/harvests → 202 + Location: /v1/jobs/{jobId}
   ▼
 EventBridge ──▶ SQS ──▶ harvest-worker Lambda
                          writes harvest row, updates job status
```

**Out of VPC by default.** These functions talk to DynamoDB, S3, SQS, SNS,
EventBridge, Secrets Manager. A VPC would buy NAT bills and nothing else.
Record that decision in Terraform comments so you can say it out loud.

---

## Tech stack (pinned — don't re-litigate mid-build)

| Concern | Choice | Why |
|---|---|---|
| IaC | Terraform (modules + `envs/dev`) | Interview stack; plan review is the gate |
| API | **REST API (v1), not HTTP API** | Gateway Responses, request validators, API keys/usage plans, WAF association — the Q3 architectural decision |
| Compute | Node 20, TypeScript, **esbuild bundle** | Q7 opinionated take: no layers for TS; tree-shake; lockfile stays in repo |
| HTTP adapter | Hono on Lambda, or a 40-line mapper | Handler is a thin adapter either way |
| Validation | OpenAPI 3.1 → JSON Schema at the gateway; Zod in the domain | Edge rejects junk you would otherwise pay to invoke |
| Data | DynamoDB on-demand, **three tables** (`assets`, `harvests`, `jobs`) | Cursor pagination and ETags are the lesson; single-table is a flex this lab does not need |
| Async | EventBridge rule → SQS queue → worker Lambda | Decoupling, not Lambda-invokes-Lambda |
| Errors | RFC 9457 `application/problem+json` | Q2 lead; one mapping layer |
| AuthN | JWT authorizer (issuer/audience/exp) | Coarse-grained at the gateway |
| AuthZ | Ownership check in the service | "User A owns asset B" is not a gateway concern |
| API keys | Usage plan only | Identification + quota. **Not authentication.** |
| Packaging | Zip via esbuild, 512 MB memory to start | Tune per function later; do not share one Lambdalith |
| Observability | JSON logs with `requestId`; CloudWatch alarms on **5xx** and authorizer failures | Do not page on 4xx |
| CI | GitLab CI + **OIDC → IAM role** | Your real strength; no long-lived keys |
| Static analysis | `tsc --strict`, ESLint, `terraform fmt/validate`, tflint, Checkov | Gate on **new** issues in the MR |
| Local | Vitest + DynamoDB Local (or `aws-sdk-client-mock`); `terraform plan` | You can finish Stages 1–2 without an AWS account |

**Explicitly not in v1:** HTTP APIs, Lambda layers, Lambda-in-VPC, NAT,
CodePipeline/CodeBuild/CodeDeploy, mTLS, WAF web ACL, CloudFront (Stage 8),
RDS, Step Functions (one queue is enough), Lambdalith behind a `{proxy+}`.

---

## Incident-prevention rules (Stage 0, non-negotiable)

Treat these as the lab's "do not create an incident" checklist. If a stage
would violate one, change the stage.

1. **Sandbox only.** Dedicated AWS account or a clearly named `aws-api-lab-dev`
   prefix. No shared prod account.
2. **Budget alarm** on day one (e.g. $20) plus an email. DynamoDB on-demand +
   Lambda is cheap; a forgotten NAT or a log-group that never expires is not.
3. **No NAT gateway. No public subnet Lambdas.** Functions stay out of the VPC.
4. **No `Resource: "*"`** on execution roles except where an AWS API truly
   requires it (and then condition it). Per-function roles.
5. **S3 (if Stage 8) is private.** CloudFront OAC only. Block public access on.
6. **Log retention 14 days** on every log group. Default "never expire" is how
   labs get expensive.
7. **`terraform destroy` is a documented, tested path**, not a hope.
8. **Secrets in Secrets Manager or SSM**, never in Terraform `tfvars` committed
   to git, never in Lambda env for credentials.

---

## Repo layout (target end state)

```
aws-api-lab/
├─ PLAN.md
├─ README.md                          # 60s pitch + how to run
├─ openapi/
│  └─ assets@v1.yaml                  # contract lives here first
├─ packages/
│  ├─ errors/                         # Problem Details, domain errors, catalog
│  └─ domain/                         # assets/harvests/jobs — no AWS types
├─ apps/
│  ├─ assets-api/                     # API Lambdas (thin adapters)
│  └─ harvest-worker/                 # SQS consumer
├─ terraform/
│  ├─ modules/
│  │  ├─ rest-api/                    # REST API, validators, Gateway Responses
│  │  ├─ lambda-fn/                   # zip, role, log group, alarms
│  │  ├─ dynamodb-table/
│  │  └─ async-harvest/               # bus rule, queue, DLQ, worker
│  └─ envs/dev/
├─ .gitlab-ci.yml
├─ .tflint.hcl
└─ checkov.yaml
```

---

## Prerequisites

- Node 20+, pnpm, Terraform >= 1.6.
- An AWS sandbox account **or** the patience to stop at `terraform plan`
  until you have one.
- GitLab project (or GitHub — the OIDC pattern is the same; GitLab is what
  you will say in the interview).
- Optional: DynamoDB Local via Docker for Stage 2 tests.

---

# Stage 0 — Lab scaffold + guardrails

**Goal:** a repo where `pnpm -r build` works, Terraform has a `dev` root
module that creates **zero expensive resources**, and the incident rules are
encoded (budget, name prefix, log retention).

**Depends on:** nothing.

**Tasks:**
- [x] pnpm workspace (`packages/*`, `apps/*`), root `tsconfig.base.json`.
- [x] `packages/errors` and `packages/domain` stubs that compile.
- [x] `terraform/envs/dev` with backend config (S3+DynamoDB lock **or** local
      backend until the account exists — local is fine for Stage 0).
- [x] `aws_budgets_budget` + SNS email (or a comment + skipped resource if
      you have no account yet).
- [x] `locals { name_prefix = "aws-api-lab-dev" }` used on every resource.
- [x] README: how to plan, how to destroy, the incident rules above.

**Key files:** `terraform/envs/dev/main.tf`, `README.md`, workspace manifests.

**Done when:** `pnpm -r build` passes; `terraform -chdir=terraform/envs/dev plan`
runs without error (empty or budget-only is fine); README states destroy steps.

---

# Stage 1 — Contract first + consistent errors  ⭐

**Goal:** OpenAPI is the source of truth, and **no handler invents its own
error shape**. This stage is pure TypeScript. No AWS required.

**Depends on:** Stage 0.

This is Q1 + Q2. Build it until you can recite it from the files.

## OpenAPI (`openapi/assets@v1.yaml`)

Resources, not verbs:

| Method | Path | Semantics |
|---|---|---|
| GET | `/v1/assets` | List. Cursor pagination. Cacheable. |
| POST | `/v1/assets` | Create. `Idempotency-Key` required. 201 + `Location`. |
| GET | `/v1/assets/{assetId}` | 200 + `ETag`. |
| PUT | `/v1/assets/{assetId}` | Full replace. Idempotent. `If-Match` required. 412 on mismatch. |
| PATCH | `/v1/assets/{assetId}` | JSON Merge Patch. `If-Match` required. |
| DELETE | `/v1/assets/{assetId}` | Idempotent. 204. `If-Match` required. |
| GET | `/v1/assets/{assetId}/harvests` | List by asset. Cursor. |
| POST | `/v1/assets/{assetId}/harvests` | **Async.** 202 + `Location: /v1/jobs/{jobId}`. |
| GET | `/v1/jobs/{jobId}` | Job status resource. |

**Pin these in the spec, not in a comment:**

- Versioning: `/v1` in the path. Additive changes do not bump it.
- Pagination: `{ items, nextCursor }`. `nextCursor` is opaque. Document that
  it is a base64 `LastEvaluatedKey` and that offset pagination is rejected
  because it breaks under concurrent writes and does not map to DynamoDB.
- Optimistic concurrency: `ETag` on GET; `If-Match` on PUT/PATCH/DELETE.
- Status codes: 201, 202, 204, 400, 401, 403, 404, 409, 412, 422, 429, 500.
- Error media type: `application/problem+json`.
- Components: JSON Schema for `Asset`, `Harvest`, `Job`, `ProblemDetail`.

**Do not add GraphQL.** CRUD over well-known resources with cacheable GETs
does not need it. Say that if asked; do not implement a second API.

## Error package (`packages/errors`)

RFC 9457 fields: `type`, `title`, `status`, `detail`, `instance`, plus
extensions `code` and `requestId`.

Rules:
1. Clients branch on **`code`** (`ASSET_NOT_FOUND`). Humans read `detail`.
   Never make clients parse `detail`.
2. Domain errors: `NotFoundError`, `ValidationError`, `ConflictError`,
   `PreconditionFailedError`, `ThrottleError`. Thrown from `packages/domain`.
3. **One mapper** `toProblem(err, ctx) → ProblemDetail`. Unknown errors
   become a generic 500 with `requestId` and **no internals**. Stack goes to
   the log only.
4. Existence-sensitive resources return **404 not 403** when the caller
   must not learn that the id exists.
5. Catalog documented in OpenAPI (`components.schemas` + a `x-error-codes`
   list). A contract test asserts every thrown domain error maps to a catalog
   entry and the envelope has the five RFC fields.

**Do not leak:** stack traces, table names, hostnames, IAM ARNs, whether an
unauthorized id exists.

**Key files:** `openapi/assets@v1.yaml`, `packages/errors/src/{problem,errors,map,catalog}.ts`.

**Done when:**
- [x] Spec linted (`@redocly/cli` or `swagger-cli`) with zero errors.
- [x] Vitest: mapper coverage for each domain error; unknown `Error` → 500 with
      no `detail` from the stack; catalog codes are stable strings.
- You can answer out loud: "why cursor not offset" and "what is
  `application/problem+json`" while looking at `openapi/assets@v1.yaml` and
  `packages/errors`.

---

# Stage 2 — Domain + DynamoDB access (thin Lambda later)  ⭐

**Goal:** business logic that unit-tests **without importing `aws-lambda`**.
DynamoDB access implements cursor pagination and optimistic concurrency.

**Depends on:** Stage 1.

**Principle (Q8):** handler is a thin adapter. Parse/validate event → call
domain → map result. Test: `packages/domain` has zero `aws-lambda` and zero
`@aws-sdk` in its `package.json`. Persistence sits behind a port
(`AssetStore`, `JobStore`).

## Tables

**`assets`**
- PK: `assetId`
- Attributes: `ownerId`, `name`, `status`, `version` (number), `createdAt`,
  `updatedAt`, plus payload fields from the spec.
- ETag: `W/"{version}"` (weak is fine; the version is the concurrency token).
- Conditional writes: `attribute_not_exists(assetId)` on create; `version = :v`
  on update/delete. Failure → `PreconditionFailedError` (412) or
  `ConflictError` (409) as appropriate.

**`harvests`**
- PK: `assetId`, SK: `harvestId`
- GSI not required if list-by-asset is a PK query with `Limit` +
  `ExclusiveStartKey`.

**`jobs`**
- PK: `jobId`
- Attributes: `type`, `status` (`pending|processing|succeeded|failed`),
  `assetId`, `errorCode?`, `createdAt`, `updatedAt`.

## Pagination

`listAssets({ ownerId, limit, cursor })`:
- Decode cursor → `ExclusiveStartKey`. Invalid cursor → 422, not a scan.
- `Limit = limit`. Encode `LastEvaluatedKey` as url-safe base64 `nextCursor`.
- Never `Scan` for a user-facing list in this lab.

## Idempotency

POST `/v1/assets` stores `Idempotency-Key` (scoped to `ownerId`) in a small
`idempotency` table or as a condition on a dedicated item. Replay within the
window returns the **original** 201 body, not a second row.

## Ports and adapters

```
packages/domain/          # createAsset, updateAsset, requestHarvest, ...
apps/assets-api/src/
  dynamodb/               # implements AssetStore with Document Client
  http/                   # API Gateway event → domain → response
  handlers/*.ts           # one exported handler per function (thin)
```

**Sizing (Q8), decide now and split functions accordingly:**

| Function | Why it is separate |
|---|---|
| `getAsset` / `listAssets` | Read-heavy, cacheable, read-only IAM |
| `writeAsset` | PUT/PATCH/DELETE, write IAM, If-Match path |
| `createAsset` | Idempotency, 201 — different failure mode than update |
| `createHarvest` | 202 only; publishes event; must not do the work |
| `getJob` | Read-only jobs table |
| `harvestWorker` | SQS, different memory/timeout, different IAM |

Do **not** put Express/Hono behind a single `{proxy+}` (Lambdalith). Do **not**
split `getAsset` into five nanoservices. The table above is the grain.

**No Lambda pinball:** `createHarvest` publishes to EventBridge. It does not
`Lambda.Invoke` the worker.

**Key files:** `packages/domain/src/*.ts`, `apps/assets-api/src/dynamodb/*.ts`.

**Done when:**
- [x] Vitest (mocked store or DynamoDB Local): create → get with ETag → PUT with
      stale If-Match → 412; PUT with current ETag → version bumps.
- [x] List with two pages: `nextCursor` round-trips; inserting an item on page 1
      does not duplicate-or-skip the way offset would (write a test that
      documents this).
- [x] `packages/domain` tests import nothing from `aws-lambda`.
- [x] POST harvest returns a job id and does not write a harvest row (the worker
      does that in Stage 4).

---

# Stage 3 — API Gateway + Terraform  ⭐

**Goal:** a REST API whose **gateway-generated errors look like your app
errors**, with request validation at the edge so malformed bodies never
invoke Lambda.

**Depends on:** Stage 2 (handlers exist even if still dummy-wired).

This is the Q2 differentiator and most of Q3.

**Tasks:**
- [ ] Terraform module `rest-api`: regional REST API, stage `v1` (or a stage
      named `dev` with path `/v1` in the resource). Pick one and document it.
      Recommendation: **path `/v1` on the API**, stage = environment (`dev`).
- [ ] Resources and methods from the OpenAPI spec. `aws_api_gateway_model`
      + `aws_api_gateway_request_validator` (`validate_request_body = true`,
      `validate_request_parameters = true`).
- [ ] Lambda integrations (AWS_PROXY) per function from Stage 2. Permission
      `apigateway.amazonaws.com` scoped to that API/stage/method — not `*`.
- [ ] **Gateway Responses** (this is the whole point of choosing REST API):
      override `DEFAULT_4XX`, `DEFAULT_5XX`, `UNAUTHORIZED`, `ACCESS_DENIED`,
      `BAD_REQUEST_BODY`, `BAD_REQUEST_PARAMETERS`, `THROTTLED`,
      `MISSING_AUTHENTICATION_TOKEN`, `INTEGRATION_FAILURE`,
      `INTEGRATION_TIMEOUT` with VTL templates that emit
      `application/problem+json` using the same `type/title/status/detail/code/requestId`
      envelope. Pull `context.requestId` into `requestId` and `instance`.
      Put these in Terraform. Never click them in the console.
- [ ] Throttling: account/stage defaults plus a tighter burst/rate on POST
      harvest. Method-level.
- [ ] Usage plan + API key **wired but documented as identification**. A
      comment in Terraform: "NOT authentication."
- [ ] JWT authorizer (Cognito user pool **or** a REQUEST Lambda authorizer
      that validates a stub JWT in dev). Pass `sub` / `tenantId` via
      `context` so the integration does not re-parse the token.
- [ ] Authorizer **result cache**: TTL ~300s, identity source = Authorization
      header **only** (or header + tenant header if that is part of the key).
      Comment the failure mode: a cache key that omits user identity leaks
      authorization; a cache key that includes a changing header destroys
      latency.
- [ ] Access logs to CloudWatch: request id, status, route, caller, latency.
      Retention 14 days.
- [ ] Resource policy stub: optional IP allowlist variable, default open in
      sandbox with a comment on PRIVATE + `execute-api` VPC endpoint for
      internal APIs. Do not actually build a Private API in v1 unless you
      already have a VPC you are willing to pay for.

**HTTP API vs REST API (write this in the module README, one paragraph):**
HTTP APIs are cheaper and have a native JWT authorizer. They do **not**
give you API keys/usage plans, request validators, or Gateway Responses the
way REST APIs do. This lab picks REST API because the interview's
differentiator lives there.

**Closing line to practice:** "The gateway does coarse-grained authorization.
Object-level authorization stays in the service."

**Key files:** `terraform/modules/rest-api/*`, Gateway Response templates,
`apps/assets-api` handler wiring.

**Done when:**
- `terraform plan` shows REST API, validators, Gateway Responses, four-plus
  Lambda integrations, usage plan, authorizer.
- Contract test or a scripted `aws apigateway test-invoke-method` (or a
  recorded fixture): invalid JSON body is **rejected at the gateway** with
  the problem+json envelope and **zero** Lambda invocations (check
  `Invocations` metric or a log absence).
- Authorizer deny returns the **same envelope**, not the default
  `{"message":"Unauthorized"}`.
- You can say what a Gateway Response is without looking it up.

---

# Stage 4 — Async harvest (202 + EventBridge + SQS)

**Goal:** long-running create matches the interview follow-up and the
Sinclair workflow shape. API returns immediately; work happens off the
request path; failures go to a DLQ with a reason.

**Depends on:** Stages 2–3.

**Flow:**
1. `POST /v1/assets/{assetId}/harvests` checks ownership, writes `jobs`
   item `pending`, puts an EventBridge event (`source = assets.api`,
   `detail-type = HarvestRequested`), returns **202** with
   `Location: /v1/jobs/{jobId}` and a body `{ jobId, status: "pending" }`.
2. EventBridge rule targets SQS (not a Lambda target — the queue is the
   buffer).
3. `harvest-worker` consumes SQS, sets job `processing`, does the fake
   work (sleep + write `harvests` row is enough), sets job `succeeded`.
4. Redrive: after N receives, SQS DLQ. Job marked `failed` with a catalog
   `code`. Do not swallow poison messages.

**IAM:** `createHarvest` may `events:PutEvents` on **one** bus/source and
`dynamodb:PutItem` on `jobs` + `GetItem` on `assets`. It cannot write
`harvests`. The worker can write `harvests` and `jobs`, consume the queue,
and nothing else.

**Timeouts:** API Lambda 5s. Worker 60s (still far under 15 min; if you
needed longer you would not use Lambda — say that).

**Key files:** `apps/harvest-worker/`, `terraform/modules/async-harvest/`,
`packages/domain` `requestHarvest` / `completeHarvest`.

**Done when:**
- POST harvest returns 202 in the API Lambda without writing a harvest.
- Worker writes the harvest and the job becomes `succeeded`.
- `GET /v1/jobs/{id}` polls that transition.
- Kill the worker, send one poison payload, confirm DLQ depth > 0 and the
  API still serves GETs (blast radius).
- You can say "no Lambda pinball" and point at EventBridge/SQS.

---

# Stage 5 — Security controls that are actually in the repo

**Goal:** Q3 + Q4 become a walk through Terraform and one ownership test,
not a word cloud.

**Depends on:** Stage 3.

**Layer the implementation so the answer has a spine:**

1. **Identity.** JWT authorizer: issuer, audience, expiry, signature
   (JWKS). Scopes optional. `sub` in context.
2. **Authorization.** `assertOwner(asset, callerSub)` on every get/write.
   Deny by default. Test: user B requesting user A's `assetId` → 404
   (existence-sensitive) or 403 if the spec says ids are enumerable.
   **Pick 404** for this lab and document why.
3. **Least privilege.** Each function's role in `lambda-fn` module:
   resource ARNs + `dynamodb:LeadingKeys` condition where it helps.
   `checkov` fails the MR on `Resource: "*"`.
4. **Input.** Gateway JSON Schema + Zod. Payload size: API Gateway 10 MB
   default; set a tighter model / Lambda `maxReceive` as needed. No string
   concat into queries (you are on DynamoDB — parameterized by construction;
   still worth a comment).
5. **Abuse.** Stage/method throttle already in Stage 3. Usage plan quota.
   WAF: **module stub or README-only** — do not attach a web ACL that
   you will forget to destroy unless you are comfortable with the charge.
6. **Secrets.** If the authorizer needs a JWKS URL only, no secret required.
   If you add a shared secret for the stub authorizer, SSM SecureString +
   Lambda Parameters and Secrets extension **or** SDK get at init, not an
   env var with the value.
7. **Data.** DynamoDB encryption: AWS-owned key is fine for the lab; add a
   CMK only if you want the talking point. Point-in-time recovery **off** in
   sandbox (cost). PITR on is a prod default you should *say*.
8. **Detection.** CloudTrail is account-level — do not try to own it from
   this module. API Gateway access logs + app logs + alarms (Stage 6).

**Concrete hook to practice:** the GitLab OIDC trust policy (Stage 7) is
the security-adjacent artifact DevOps interviewers respect. Preview the
role's `sts:AssumeRoleWithWebIdentity` conditions here in a comment if
Stage 7 is not done yet.

**Key files:** ownership tests, IAM policy documents in Terraform,
authorizer cache-key comment.

**Done when:**
- A test proves cross-user get is 404.
- `terraform plan` shows distinct IAM roles; Checkov (or a grep in CI)
  fails a deliberate `Resource: "*"` you add in a branch and revert.
- You can list gateway controls cheapest-first without reading Q3.

---

# Stage 6 — Observability: 5xx is yours, 4xx is the client

**Goal:** alarms you would actually page on, and a support workflow that
starts with "give me the request id."

**Depends on:** Stage 3.

**Tasks:**
- [ ] Structured JSON logs: `requestId`, `route`, `code`, `ownerId` (not
      PII beyond that), `latencyMs`. Propagate `X-Request-Id` if present,
      else the API Gateway request id. Echo it on every problem+json body.
- [ ] Log groups: retention 14 days, via the `lambda-fn` module so a new
      function cannot forget.
- [ ] Alarms (SNS email is enough):
      - 5xx rate on the API stage
      - Authorizer 4xx **spike** (misissued tokens or an attack — this one
        is yours even though the status is 4xx)
      - Worker DLQ depth
      - Lambda errors / throttles per function
      - **Do not alarm on 4xx rate** for validation errors
- [ ] Dashboard optional. Alarms are not.

**Key files:** `terraform/modules/lambda-fn/alarms.tf`, logger in shared
code.

**Done when:** forcing a 500 (a test handler or a fault flag) pages the
alarm; forcing a 422 does not. An error body contains a `requestId` you
can search in CloudWatch Logs Insights.

---

# Stage 7 — Pipeline hygiene (the DevOps half)

**Goal:** Q9 + Q10. Your honest answer stays "GitLab CI, not Code* in
prod." The repo proves the **practice**: OIDC, plan on MR, apply on main,
static analysis as a gate, no long-lived keys.

**Depends on:** Stage 0; better after Stage 3 so plan has real resources.

**MR pipeline (fail the merge request, not a nightly job):**
- [ ] `tsc --strict` + ESLint (type-aware) + Prettier check
- [ ] Vitest
- [ ] OpenAPI lint
- [ ] `terraform fmt -check`, `terraform validate`, tflint, Checkov
- [ ] `terraform plan` against `envs/dev` with the OIDC role; **plan
      artifact attached to the MR**
- [ ] Apply only on `main`, with a manual gate if you want to mimic
      protected environments

**OIDC (the thing to lead with):**
GitLab IdP → IAM role trust `sub` = project + `ref:refs/heads/main` (apply)
and a narrower role for plan on MRs. No access keys in CI variables.

**Ratchet:** if you add Sonar or similar later, gate **new** issues. Do not
boil the ocean.

**Code* mapping (README section, do not implement):**

| This repo (GitLab) | AWS native equivalent |
|---|---|
| `.gitlab-ci.yml` stages | CodePipeline + CodeBuild `buildspec.yml` |
| GitLab runner | CodeBuild project |
| OIDC to IAM | CodeConnections + per-stage service roles |
| Manual prod gate | CodePipeline approval action |
| Terraform plan/apply jobs | Same, inside CodeBuild |

**CodeDeploy (know, don't build):** Lambda aliases +
`Canary10Percent5Minutes` / `Linear10PercentEvery1Minute`, `appspec.yml`
hooks, **automatic rollback on CloudWatch alarms**. That last sentence is
the point of the service. A plain `update-function-code` has none of it.
This lab uses Terraform apply for function code; document that a prod
service would put the worker and the write APIs behind aliases.

**Current AWS trivia to remember, not to implement:**
- CodeGuru Reviewer: maintenance, no new repo associations (2025-11-07);
  CodeGuru Security discontinued (2025-11-20); AWS points at Amazon Q
  Developer + Inspector.
- CodeCommit closed to new customers in 2024, GA again Dec 2025. Most
  teams still use GitLab/GitHub for source.

**Key files:** `.gitlab-ci.yml`, `terraform/modules/ci-oidc/` (or a
`iam-gitlab-oidc.tf` in `envs/dev`), README mapping table.

**Done when:**
- A merge request runs fmt/validate/tflint/checkov/test/plan with no AWS
  access keys in the project.
- README contains the GitLab→Code* table and the CodeDeploy rollback line.
- You can say the Q10 script without apologizing or bluffing.

---

# Stage 8 — CloudFront brush-up (optional)

**Goal:** Q5 becomes "yes, and here is a distribution in the lab," not a
flashcard. Skip this if Stages 1–7 are not solid. It is the lowest-yield
build for this interviewer.

**Depends on:** Stage 3. Needs an S3 bucket for **static metadata or a
dummy thumbnail**, not a real VOD pipeline.

**Tasks (keep tiny):**
- [ ] S3 bucket, public access blocked, encryption, no static-website
      hosting.
- [ ] CloudFront distribution, **OAC** (not OAI) on the S3 origin. OAC
      signs SigV4 and works with KMS-encrypted buckets; OAI does not.
- [ ] Cache policy + origin request policy + response headers policy
      (modern names). Cache key: do **not** forward `Authorization`.
      Origin request policy can forward what the origin needs without
      putting it in the cache key.
- [ ] Versioned object keys (`thumb.{etag}.jpg`). No invalidation in the
      happy path. Invalidations are slow and metered.
- [ ] Comment in Terraform: signed **cookies** for a path prefix (HLS:
      one signature for manifest + segments); signed **URL** for a single
      object. Do not implement a signer unless you have time.
- [ ] One sentence in README: CloudFront Functions = viewer-only JS, no
      network, header rewrites; Lambda@Edge = origin/viewer, can call out,
      heavier. This lab uses neither until a rewrite is needed.
- [ ] Metric to look at: **cache hit ratio by behavior**. Low ratio → the
      cache key includes something it should not.

**Still out of VPC.** If you were fronting the API with CloudFront, that is
a cache-behavior decision (usually don't cache authenticated CRUD). Do not
put the API Lambdas in a VPC to "make CloudFront work."

**Done when:** an object is reachable only via CloudFront (direct S3 GET is
denied), hit ratio is visible in the console, and you can explain OAC vs
OAI and cache policy vs origin request policy from the Terraform.

---

## Explicit non-goals (so they don't sneak in)

- GraphQL, Lambdalith, Lambda-invokes-Lambda, Step Functions (yet).
- Lambda Layers for `node_modules`. Bundle with esbuild. If a binary ever
  appears, prefer a **container image** (10 GB) over fighting 250 MB / 5
  layers.
- Putting these Lambdas in a VPC, "just in case."
- AWS native CI/CD as the source of truth. Mapping only.
- A real Cognito user pool UI. A stub JWT in dev is enough.
- Media processing, ffmpeg layers, MediaPackage.

---

## Interview question → folder to open

| # | Question | Open this after it is built |
|---|---|---|
| 1 | REST CRUD design | `openapi/assets@v1.yaml` |
| 1 follow-up | Long-running create | `apps/assets-api` createHarvest + `apps/harvest-worker` |
| 1 follow-up | Why not GraphQL? | Spec + README one-liner |
| 2 | Consistent errors | `packages/errors` + `terraform/modules/rest-api` Gateway Responses |
| 3 | Other access controls | `terraform/modules/rest-api` (policy, authorizer, keys, throttle) |
| 4 | Security controls | Stage 5 IAM + ownership test + OIDC role |
| 5 | CloudFront | Stage 8 module, or skip and use the README brush-up |
| 6 | Lambda in VPC? | `terraform` comments on the functions: **outside**, and why |
| 7 | Layers | `apps/*/esbuild` config — the absence of layers **is** the answer |
| 8 | How much logic in a Lambda? | `packages/domain` vs `apps/assets-api/src/handlers` |
| 9 | Static analysis | `.gitlab-ci.yml` + tflint/checkov |
| 10 | AWS native CI/CD | README mapping table; do not bluff |

---

## Rapid-fire → what the lab must make true

After Stage 4 you should answer these from memory. If you stumble, the
stage in parentheses is the one to re-read.

1. Cursor vs offset? Concurrent writes + DynamoDB `LastEvaluatedKey`. (S2)
2. `application/problem+json` five fields: `type`, `title`, `status`,
   `detail`, `instance`. (S1)
3. Gateway Response: gateway-generated errors never hit your mapper. (S3)
4. API keys: identification, not authentication. (S3)
5. OAC vs OAI: SigV4 + KMS vs the old OAI identity. (S8)
6. Signed cookie vs URL: cookie for a *set* (HLS). (S8)
7. CloudFront Functions vs Lambda@Edge: viewer/no-network vs origin+network. (S8)
8. VPC Lambda can't reach S3: **gateway VPC endpoint (free)** vs NAT (not
   free). Prefer endpoint. (S6 talk track; not built)
9. VPC cold start: Hyperplane ENIs; the 10s ENI penalty is pre-2019 folklore. (talk track)
10. Layers: max 5; 250 MB unzipped **function + layers**. (S7 opinion: don't)
11. Lambda pinball: sync Lambda→Lambda; use Step Functions or EventBridge/SQS. (S4)
12. CodeDeploy vs `update-function-code`: alias traffic shift + alarm rollback. (S7 README)

---

## 60-second pitch (put on the README, say it once)

> I've been building event-driven services on AWS — Lambda, DynamoDB,
> EventBridge — with everything in Terraform and GitLab CI federated into
> IAM through OIDC, no long-lived keys. I carry the pager for what I ship.
> This lab is a contract-first REST API with problem+json errors including
> API Gateway responses, cursor pagination and ETags on DynamoDB, and
> async harvests over a queue so the request path stays boring.

Then stop. Let him pick a thread.

---

## Questions to ask him (pick two)

- How are environments and AWS accounts separated, and who owns Terraform state?
- Where is the line between product-owned and platform-owned infrastructure?
- What does merged-PR-to-production look like, and how long does it take?
- Do product engineers carry the pager for their own services?
- What is the current pain point in the deployment pipeline you would most like fixed?

---

## How to work this in Cursor

1. Keep this file at `aws-api-lab/PLAN.md`.
2. One stage per session. Paste the stage heading: **"implement this stage;
   stop at the Done-when check."**
3. After each stage, actually run the check. Later stages assume the
   contract and error envelope are stable.
4. If you have no AWS account, stop at plan-level Terraform and Vitest.
   Applying is better for muscle memory but is not required to study.
5. Do not start Stage 8 until you can pass the rapid-fire for 1–4 and 8–12
   without the cheat sheet.

## Suggested order and effort

| Stages | Effort | Interview coverage |
|---|---|---|
| 0–1 | Short evening | Q1 contract, Q2 app errors |
| 2–3 | The heart — budget a weekend | Q1–Q3, Q6 default, Q8 grain |
| 4 | One evening | Async follow-up, pinball, Sinclair hook |
| 5–7 | One evening | Q4, Q9, Q10 honesty + mapping |
| 8 | Optional | Q5 |

Stages **1–4** are the core. If time is short, skip 8, keep 7's README
mapping even if OIDC is a stub, and still build Gateway Responses. That
one Terraform file is worth more than a CloudFront distribution you cannot
explain.
