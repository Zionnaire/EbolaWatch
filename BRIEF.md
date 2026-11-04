# EbolaWatch Nigeria — Build Prompt for Claude Code (v4)

You are working with the Fullstack Team at AHFID AI Labs (Abuja). Build **EbolaWatch Nigeria**: a real-time Ebola misinformation surveillance and counter-response platform for NCDC outbreak analysts. It is a sibling of ImmuniWatch. **This is a new project. Do not touch or import from ImmuniWatch.**

The classifier belongs to a separate model developer who has not yet delivered API docs. Build the full backend and frontend against mocks now, so that when his docs arrive, changes are confined to: the model contract files, the fixtures, and one adapter file in the backend.

## 0. How to work
- Create the folder tree in §3 first and show it to me. Then work phase by phase (§8). After each phase: typecheck, lint, tests, then a short summary (what exists, what you assumed, what you deferred).
- This is a scaffold: working seams, not every feature. Use interfaces and `// TODO(ext):` markers for out-of-scope items.
- Stop and ask if something here is contradictory. Defaults are in §11.
- Ask before adding any dependency outside §4.

## 1. Settled decisions
1. **Model shape: support both via adapter.** The model developer may deliver (a) the multi-label contract `multilabel-v1` (§6a) or (b) the legacy 3-class model (Misinformation / Factual / Irrelevant + entropy) (§6b). The backend works on one neutral internal `Classification` type; one adapter per contract maps into it. `MODEL_CONTRACT=multilabel-v1|threeclass-v0` selects it.
2. **Ingestion:** Node backend has a `MockConnector` plus an API-key-protected `POST /api/ingest`, so the Python/HuggingFace connectors can push posts in later. No real platform connectors in Node.
3. **Scope includes:** dashboard, counter-narrative + dispatch (mocked behind interfaces), geo surge view, model-health dashboard.

## 2. Lessons from ImmuniWatch → enforceable rules
1. **Mock mode is wired end-to-end and cannot lie.** The UI always shows the provenance of each stage (ingestion, classifier, counter-narrative generator, dispatcher). A config flag that never reaches the client is a bug.
2. **Types match the ML service exactly** (we shipped `"complete"` vs `"completed"`). Every model response is zod-validated at runtime against one schema. Frontend also validates our own API responses.
3. **Schemas never out-require the contract.** Mongo marks a field required only if the contract or our code guarantees it. Store the full validated model output as `Mixed` plus a few extracted, indexed fields.
4. **Statuses and settings are data** (DB/config), never hardcoded in UI or business logic.
5. **Cold starts are normal.** "Warming" is a state with a countdown, not an error. Retry automatically.

## 3. Project structure (two independent projects)
No pnpm workspace. `Backend/` and `Frontend/` each have their own `package.json`, lockfile, tsconfig and scripts.

```
EbolaWatch/
├── Backend/                         # Node + Express + Socket.io + Mongoose
│   ├── src/
│   │   ├── index.ts                 # startup, graceful shutdown
│   │   ├── config.ts                # zod-validated env, fail fast
│   │   ├── types/                   # backend-internal types only
│   │   ├── utils/                   # logger (pino), AppError, hashing, pii scrubber
│   │   ├── middlewares/             # requireAuth (stub), errorHandler, notFound, rateLimiter, ingestKey
│   │   ├── models/                  # Mongoose models
│   │   ├── controllers/
│   │   ├── routes/
│   │   ├── services/                # decision engine, rules, analytics, counter-narrative, dispatch
│   │   ├── classifier/              # ClassifierClient, InProcessMock, HttpClassifier, adapters/
│   │   ├── pipeline/                # queue, connectors/, ingest -> scrub -> classify -> decide
│   │   ├── sockets/                 # Socket.io setup and typed events
│   │   ├── contracts/               # SINGLE SOURCE OF TRUTH
│   │   │   ├── model/               # EXTERNAL model contracts (multilabel-v1, threeclass-v0). Backend only.
│   │   │   ├── api/                 # OUR API DTOs, internal Classification, socket event types. Shared with Frontend.
│   │   │   └── fixtures/            # canonical JSON
│   │   └── mock-model/              # separate HTTP server implementing the model contract (own entry point)
│   ├── scripts/export-schema.ts     # JSON Schema export
│   ├── tests/
│   ├── package.json  tsconfig.json  eslint.config.js  .env.example
├── Frontend/                        # React 18 + Vite + TypeScript
│   ├── src/
│   │   ├── main.tsx  App.tsx
│   │   ├── contracts/               # GENERATED copy of Backend/src/contracts/api (do not edit)
│   │   ├── api/                     # fetch client (zod-validated), query hooks
│   │   ├── sockets/                 # socket.io-client, event -> query cache wiring
│   │   ├── config/                  # severity colours/labels (the only place for these)
│   │   ├── components/  pages/  layouts/  hooks/  utils/
│   ├── scripts/sync-contracts.ts    # copies Backend/src/contracts/api -> src/contracts with a DO-NOT-EDIT header
│   ├── package.json  tsconfig.json  vite.config.ts  .env.example
├── docs/                            # model-api-questions.md
├── BRIEF.md                         # this file
├── package.json                     # convenience only: `dev` runs mock-model + Backend + Frontend via concurrently
├── .gitignore
└── README.md
```

**Sharing types without a workspace:** the Frontend never imports from `../Backend` (the folders may deploy separately on Render). Only `contracts/api` is shared, through `pnpm sync:contracts` in Frontend, which regenerates the copy. A Backend test fails if the Frontend copy has drifted. Raw model shapes live in `contracts/model` and are never visible to the Frontend. Raw model shapes are read only inside `Backend/src/classifier/adapters/`.

## 4. Stack and dependency policy
- Node (engines >=20.19; Render target Node 22 LTS), TypeScript strict, ESM, pnpm per folder.
- Backend: Express, Mongoose (MongoDB Atlas), Socket.io, **zod v4** (built-in `z.toJSONSchema`; no `zod-to-json-schema`).
- Frontend: React 18, Vite, TanStack Query, Recharts, socket.io-client, zod.
- Tests: Vitest, msw, supertest.
- **Pre-approved:** `cors`, `dotenv`, `helmet`, `express-rate-limit`, `pino`, `tsx`, `eslint`, `typescript-eslint`, `prettier`, `@vitejs/plugin-react`, `react-router-dom`, `mongodb-memory-server` (tests), `concurrently` (root only), `@types/*`. Use `crypto.randomUUID()`. No map library: the geo view is a hand-built SVG tile-grid cartogram. Anything else: ask.
- Note: jsdom-based component tests need Node 22+. If the local Node is 20, keep Frontend tests logic-only (node environment) or upgrade local Node to 22 LTS (recommended).

## 5. Env vars
Backend `.env.example` (naming follows ImmuniWatch): `NODE_ENV`, `PORT`, `FRONTEND_URL` (CORS lock, never `*`), `COOKIE_SECURE`, `COOKIE_SAME_SITE` (reserved for the later auth work), `MONGODB_URI`, `MONGODB_DB`, `AUTH_STUB_ENABLED`, `INGEST_API_KEY`, `AUTHOR_HASH_SECRET`, `MODEL_MODE` (`mock|live`), `MODEL_CONTRACT`, `MODEL_BASE_URL`, `MODEL_TIMEOUT_MS`, `MODEL_MOCK_MARKER` (default `mock`), `MODEL_WARMUP_MAX_WAIT_MS`, `INGESTION_MODE` (`mock|push`), `QUEUE_CAP` (500), `OVERDUE_HOURS` (48), `MOCK_MODEL_PORT`. Frontend: `VITE_API_URL`, `VITE_SOCKET_URL`. Validate with zod at startup; fail fast with a clear message.

## 6. Model contracts
### 6a. `multilabel-v1` (draft sent to the model developer: implement exactly)
Endpoints (base `MODEL_BASE_URL`): `POST /v1/classify`, `GET /v1/health`, `GET /v1/taxonomy`.
Rules: every field always present, absent = `null`, never an omitted key (failed items are the only exception); lowercase snake_case enums; max 32 items per request; max 2,000 chars per text (model truncates, sets `truncated: true`); per-item failures never fail the batch; request `taxonomy_version` mismatch → **HTTP 409**; warming → **HTTP 503** + `Retry-After` (seconds); category scores are independent multi-label probabilities (they do not sum to 1).

Request:
```json
{ "request_id": "uuid", "taxonomy_version": "ebola-tax-1.0",
  "items": [{ "item_id": "bsky_3kxyz", "text": "<PII-scrubbed>", "platform": "bluesky",
              "language_hint": null, "context_text": null }] }
```
Response:
```json
{ "request_id": "uuid", "status": "completed | partial | failed",
  "model": { "name": "ebola-clf", "version": "1.0.0", "taxonomy_version": "ebola-tax-1.0",
             "base_model": "afro-xlmr-base", "trained_at": "2026-09-01T00:00:00Z" },
  "results": [
    { "item_id": "bsky_3kxyz", "status": "completed",
      "language": { "primary": "pcm", "confidence": 0.91, "code_switched": true },
      "relevance": { "is_ebola_related": true, "confidence": 0.97 },
      "stance": { "label": "endorses", "confidence": 0.82 },
      "categories": [{ "label": "fake_cure_prevention", "score": 0.88 }],
      "severity": { "level": 4, "confidence": 0.74, "distribution": [0.02,0.03,0.06,0.15,0.74] },
      "truncated": false, "latency_ms": 142 },
    { "item_id": "yt_c_998", "status": "failed",
      "error": { "code": "empty_text", "message": "Text was empty after normalisation" } } ] }
```
Error codes: `empty_text`, `text_too_long`, `unsupported_input`, `internal`.
Health: `{ "status": "ready|warming|degraded", "model_version", "taxonomy_version", "retry_after_seconds": number|null }`
Taxonomy: `{ "taxonomy_version", "categories": [{id, display_name, description}], "stances": [{id, display_name}], "severity_levels": [0,1,2,3,4], "languages": [{id, display_name}] }` (stance/language element shapes ASSUMED: flag to the model dev).
Enums: stance `endorses|refutes|questions|neutral_report`; language `en|pcm|ha|yo|ig|fr|und`; severity `0|1|2|3|4`. Category IDs (`ebola-tax-1.0`): fake_cure_prevention, transmission_misinfo, outbreak_denial, origin_conspiracy, response_distrust, vaccine_trial_distrust, burial_resistance, stigma_discrimination, false_case_report, fake_official_notice, incitement_against_response, other_ebola_misinfo.

**Category labels are data, not a TS union.** Typed `string`, validated at runtime against the taxonomy synced from `/v1/taxonomy`. Unknown label → log + flag `needs_review`; never crash. Stance, language, severity, status are strict zod enums.

**Invariants (zod refinements; each has a passing and failing test):** items are a discriminated union on `status` (failed item has only `item_id`, `status`, `error`); batch status: completed = all items completed, partial = ≥1 failed and ≥1 completed, failed = all failed; `categories` contains all categories, sorted by score descending, unique, scores in [0,1]; all confidences in [0,1]; `distribution` length 5, sums ≈1 (±0.01); `is_ebola_related: false` ⇒ `stance` and `severity` null.

**Strictness:** runtime schemas strip unknown keys; export a `.strict()` variant used only in contract tests so drift is caught loudly.

### 6b. `threeclass-v0` (legacy; shape ASSUMED: no API doc exists)
Per item: `{ item_id, status, label: "misinformation|factual|irrelevant", probabilities: {misinformation, factual, irrelevant}, entropy, language: string|null, latency_ms }`. Fixtures must carry an `ASSUMED` marker. Reconfirm with the model developer.

### 6c. Internal `Classification` (neutral; in `contracts/api`)
`{ contract, modelName, modelVersion, taxonomyVersion|null, isRelevant, relevanceConfidence, language|null, stance|null, categories: [{label,score}], severity: {level,confidence,distribution}|null, threeClass: {label,probabilities,entropy}|null, truncated, latencyMs }`. Both adapters produce it. Decisions, DTOs and the UI depend only on this.

### 6d. Questions for the model developer (track in `docs/model-api-questions.md`)
Auth header? `X-Request-Id` echo? Error body for 400/422? Are `categories` populated when irrelevant? Taxonomy shapes for stances/languages? Definitions of severity 0–4? Text limit in chars or code points? Mock/staging identifiable via `model.name`? Which of the two output shapes is the real one?

## 7. Cross-cutting rules
- **Provenance:** `ingestion: mock|push`, `classifier: mock-inprocess|mock-server|live`, `generator: mock|live`, `dispatcher: mock|live`. `mock-server` is detected when response `model.name`/`version` matches `MODEL_MOCK_MARKER`; the mock model must identify itself (`mock-ebola-clf`, `0.0.0-mock`). Every post and classification stores `isMock`; API queries are scoped to the current run's `isMock`, so mock data never mixes with real data.
- **Security:** CORS locked to `FRONTEND_URL`; helmet; rate limiting; `requireAuth` stub fails closed in production unless `AUTH_STUB_ENABLED=true`, and guards review, dispatch and admin routes. `POST /api/ingest` requires `INGEST_API_KEY` (constant-time compare). Socket.io uses the same origin lock. No secrets in the Frontend.
- **Privacy:** PII scrubbed before storage and before anything goes to the model. Author handles stored as HMAC-SHA256 with `AUTHOR_HASH_SECRET` (never bare SHA-256, which is brute-forceable). Raw text never persisted. Coarse location only (state/LGA). Fixtures are synthetic only: never real scraped posts.
- **Restarts:** the DB is the source of truth. The in-process queue is rebuilt on boot by re-enqueueing `pending|classifying` posts.
- **No autonomous dispatch:** `DispatchService` refuses unless an analyst-approved review exists for that counter-narrative. Enforced in code and tested.

## 8. Phases
### Backend
**B0 Bootstrap.** Tree from §3, ESM, strict TS, ESLint/Prettier, Vitest, `.env.example`, `config.ts`, logger, hello test.
**B1 Contracts.** zod schemas for 6a and 6b; internal Classification; API DTOs and typed Socket.io events (`model:status`, `post:classified`, `system:update`, `alert`); fixtures (completed batch, partial batch with one failed item, irrelevant post, warming/ready/degraded health, full v1 taxonomy, one fixture per category covering all 12, a 3-class set, with en/pcm/ha/yo/ig/fr/und covered); `pnpm contracts:schema` exports JSON Schema for diffing against the model dev's Pydantic schema. Tests: every fixture parses; `"complete"` instead of `"completed"` fails; missing key fails; each invariant; extra key fails strict but passes runtime.
**B2 Mock model.** `src/mock-model/` Express server (entry `pnpm mock-model`) implementing all three endpoints from fixtures. Deterministic: fixture chosen by hash of `item_id`. Enforces limits (>32 items → 400; long text truncated + flag). `POST /__control` and env for warm-up duration (health `warming`, 503 + `Retry-After`), added latency, failure rate, taxonomy mismatch (409), malformed-response mode. Also a `threeclass-v0` mode. supertest tests. Production code must never import from `mock-model/`.
**B3 Foundations.** `ClassifierClient` interface with `InProcessMockClassifier` (fixtures, no network) and `HttpClassifier` (chunks of 32; every response zod-validated; per-request timeout; per-item failures mapped without dropping the rest). Failure handling:

| Condition | Behaviour |
|---|---|
| 200, valid | proceed |
| 200, invalid schema | log raw payload + zod issues; model-status `error`; items `classification_error`; never dropped; no auto-retry |
| 503 | warming: honour `Retry-After` (clamp 1–60s, default backoff if absent) up to `MODEL_WARMUP_MAX_WAIT_MS`; items stay `pending`; emit status |
| 409 | stop, re-sync taxonomy once, raise alert, **no retry** |
| 400 / 422 | our bug: log, no retry |
| 429 / 5xx / network / timeout | exponential backoff + jitter, max N, then `classification_error` |
| per-item `internal` | limited retry; `empty_text`, `text_too_long`, `unsupported_input` are terminal |

Adapters in `classifier/adapters/` (`multilabelV1.ts`, `threeClassV0.ts`). Model-status poller of `/v1/health` stores latest status and emits `model:status` on change, including an absolute `retryAvailableAt` timestamp. Taxonomy sync on startup and on `taxonomy_version` change, stored in Mongo; `GET /api/taxonomy`. `GET /api/system/status` → `{ modelMode, modelContract, dataSource: {ingestion, classifier, generator, dispatcher}, modelStatus, modelVersion, taxonomyVersion, operatingMode, retryAvailableAt }`. msw tests for every table row.
**B4 Pipeline and data.** Models (keep minimal, easy to change; unique upsert indexes):
- `Post`: platform, sourceId (**unique `(platform, sourceId)`**), authorHash, scrubbed text, languageHint, state/LGA (nullable), timestamps, engagement (nullable), `pipelineStatus` (`pending|classifying|classified|needs_review|classification_error`), `reviewStatus` (`unreviewed|confirmed|rejected|corrected`), `latestClassificationId`, `isMock`.
- `Classification`: append-only, one per model call per post; full validated output (`Mixed`) + `modelVersion`, `taxonomyVersion`, `textHash`, `isMock`, extracted indexed fields. A retry of the same `(post, modelVersion, taxonomyVersion, textHash)` is a no-op.
- `Decision`: per classification: `isMisinformation`, `finalSeverity` (nullable), `reasons`, `priorityScore`, `urgent`, `queue` (`review|information_gap|none`), `rulesSnapshot` (thresholds, floors, keyword rules, bands, mode actually used). Recomputable.
- `Taxonomy`, `RulesConfig` (keyed by taxonomy version; includes `confidenceBands`), `Connector` (status `live|not_integrated|error|paused`), `SystemState` (`dormant|surge`), `AnalystReview` (append-only; post, classification, reviewer from auth stub, decision, optional label correction in the model's own label space + taxonomy version, timestamp: exportable for retraining), `CounterNarrative`, `Dispatch`.

Pipeline (in-process queue; no Kafka): ingest (`MockConnector` on an interval, plus `POST /api/ingest` accepting raw posts; `Connector` interface; Bluesky/YouTube/Twitter/Instagram stubs registered `not_integrated`) → scrub PII (handles, mentions, URLs incl. scheme-less, emails, phone numbers incl. Nigerian formats `+234…`/`0803…`/spaced/dashed; unit-tested) → classify via `ClassifierClient` → decide (§9) → upsert and emit `post:classified`.
Seed `RulesConfig` per §9. Routes: `GET /api/posts` (filters: queue, severity, category, language, state, platform; paginated), `GET /api/posts/:id` (post + latest classification + decision + history), `POST /api/posts/:id/review`, `GET /api/connectors`, `GET /api/rules`, `POST /api/admin/mode`, `POST /api/admin/recompute-decisions` (explicit only: mode changes never silently rewrite old decisions), `POST /api/ingest`.
**B5 Counter-narrative and dispatch (mocked).** `CounterNarrativeGenerator` interface + `MockGenerator` (canned drafts; platform character limits from config, e.g. X 280; cites NCDC/WHO). `DispatchService` + `MockDispatcher` with the no-autonomous-dispatch rule. Routes: generate, edit/regenerate, approve, reject, dispatch, list dispatches. `// TODO(ext):` real RAG (multilingual-e5-base + pgvector + Groq; pin model names in config, verify they exist) and real platform posting.
**B6 Analytics endpoints.** `/api/analytics/summary` (posts today, flagged 7d, queue size + cap warning, dispatched today), `/timeseries` (7-day stacked by label), `/breakdown` (platform, language), `/clusters` (placeholder: group by top category; `TODO(ext)` real narrative clustering), `/geo` (per-state density, week-on-week change, **surge flag > +50%**, dominant platform/language/top categories per state/LGA, CSV export; PDF is `TODO(ext)`), `/model-health` (override rate by class/platform, confidence histogram, latency P50/P95/P99, per-language agreement; precision/recall/F1 are derived **only from analyst reviews**, shown with sample size and that caveat). Unreviewed > `OVERDUE_HOURS` is a computed `overdue` flag; escalation delivery is `TODO(ext)`.
**B7 Integration.** Contract tests: `HttpClassifier` vs the running mock-model (every simulation mode, both contracts). End-to-end test with `mongodb-memory-server`: mock connector → scrub → classify → decide → DB → socket event. Root `pnpm dev` (concurrently) starts mock-model, Backend and Frontend; Backend waits for mock-model health in live mode.

### Frontend
**F0 Bootstrap.** Vite + React + TS, router, TanStack Query provider, `sync:contracts`, API client that zod-validates every response, socket client, env handling, hello test.
**F1 Shell and queues.** Persistent header from `/api/system/status` + Socket.io: operating mode; model status (ready / warming with countdown computed from `retryAvailableAt` / degraded / error); **prominent MOCK DATA badge** whenever any `dataSource` stage is not live, naming which. Review queue (sorted by priority, urgent flag, overdue flag): final severity, stance/label, top category display name, language, platform, time; filters for severity, category, language. Information-gaps queue (multilabel contract only; hide when contract is 3-class). Live updates: REST for initial load, Socket.io events patch/invalidate Query caches; refetch on reconnect.
**F2 Post detail and settings.** Text, metadata, Recharts bar chart of all category scores (or 3-class probabilities + entropy), severity distribution, final-severity reasoning (from `decision.reasons` and `rulesSnapshot`), classification history across model versions, analyst review form (confirm / reject / correct labels). Settings: connectors (status from API), read-only rules config.
**F3 Counter-narrative and dispatch UI.** In the detail view: generated draft, editable, approve / reject-and-regenerate / override label. Dispatch Console: dispatched items (platform, original post, text, timestamp). Manual generation panel.
**F4 Dashboard, geo, model health.** Dashboard: counters, 7-day stacked chart, platform and language breakdown, live classification feed, top narrative clusters. Geo: SVG tile-grid cartogram of 36 states + FCT, colour by density, surge flags, state drill-down (platform, language, top categories, LGA table), CSV export. Model Health page per B6, with the review-derived caveat shown.

**Frontend rules (all pages):** every category, stance and label name comes from `/api/taxonomy`, looked up by the classification's own `taxonomyVersion`, falling back to the prettified raw id; no hardcoded label strings in components. Severity colours and labels live in a single `config/` file, never colour alone (also text/icon). Loading, empty and error states for every query; "model warming up" is a neutral state, never red. Plain, tidy styling: a design system comes later.

## 9. Decision logic (pure, unit-tested; in `services/`)
Not relevant ⇒ `isMisinformation=false`, `finalSeverity=null`, `queue='none'`.
**multilabel-v1:** `isMisinformation` = relevant AND stance `endorses` AND any category score ≥ that category's threshold for the current mode (default 0.5 `dormant`, 0.4 `surge`). `finalSeverity` = max(model severity, floor of every over-threshold category, keyword-rule severity). Queue: `review` if misinformation; `information_gap` if relevant and stance `questions`; else `none`. Category floors: fake_cure_prevention 3, transmission_misinfo 2, outbreak_denial 2, origin_conspiracy 2, response_distrust 3, vaccine_trial_distrust 2, burial_resistance 3, stigma_discrimination 2, false_case_report 2, fake_official_notice 3, incitement_against_response 4, other_ebola_misinfo 1. Keyword rules: empty list, fully wired. A category with no rule uses the default threshold and floor 0, and is logged.
**threeclass-v0:** misinformation if label is `misinformation` and confidence ≥ standard band; `urgent` if ≥ urgent band. Bands live in `RulesConfig` (`urgent` 0.90, `standard` 0.75). `finalSeverity` from a config map (urgent → 3, standard → 2: placeholder). No `information_gap` queue (no stance). Below the standard band: stored, not queued.
`priorityScore`: placeholder from `finalSeverity`, engagement and `urgent`. `// TODO: replace with real scoring`. Unknown category label ⇒ `needs_review`.
Edge-case tests: unknown label, nothing over threshold, multiple floors, dormant vs surge, null engagement, 3-class band edges (0.74/0.75/0.89/0.90).

## 10. Out of scope
Real platform ingestion in Node, real RAG and LLM calls, real platform posting, alert and escalation delivery, surge auto-detection, authentication (stub only), Kafka, deployment config, PDF export, choropleth with real GeoJSON. Leave interfaces and `TODO(ext)` markers.

## 11. Defaults chosen (list in the B0 summary; I will override if wrong)
End user is NCDC (vocabulary configurable). Stance/language taxonomy shapes are `{id, display_name}`. Mock/live data separated by `isMock` scoping, not separate databases. ESM, zod v4. The 3-class contract shape is assumed. Model Health precision/recall come from analyst reviews only and are labelled as such. Frontend never imports from `../Backend`.
