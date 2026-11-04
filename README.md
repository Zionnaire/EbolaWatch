# EbolaWatch Nigeria

Real-time Ebola misinformation surveillance and counter-response platform for NCDC outbreak analysts.
A sibling of ImmuniWatch; it shares no code with it.

`Backend/` and `Frontend/` are two independent projects (no pnpm workspace). The root `package.json` only
holds a convenience `dev` script.

## Status

| Phase | State |
|---|---|
| B0 Bootstrap, B1 Contracts, B2 Mock model, B3 Foundations, B4 Pipeline and data, B5 Counter-narrative and dispatch (mocked), B6 Analytics, B7 Integration (the whole backend) | done |
| F0 Bootstrap, F1 Shell and queues, F2 Post detail and settings, F3 Counter-narrative and dispatch, F4 Dashboard, geography, model health, plus sign-in, team and organizations | done |

The classifier belongs to a separate model developer whose API docs have not arrived. Everything is built
against mocks. When the docs arrive, changes are confined to `Backend/src/contracts/model/`, the fixtures in
`Backend/src/contracts/fixtures/` and `Backend/src/classifier/adapters/`.
Open questions for the model developer: [docs/model-api-questions.md](docs/model-api-questions.md).

## Run the backend

```bash
cd Backend
pnpm install
cp .env.example .env       # set MONGODB_URI and the two secrets
pnpm check:env             # validates .env and pings MongoDB (prints no secrets)
pnpm mock-model            # optional: mock model HTTP server on :4100
pnpm dev                   # API + Socket.io on :4000
```

| Script | Purpose |
|---|---|
| `pnpm dev` | API with reload |
| `pnpm mock-model` | Mock model server implementing the external contract |
| `pnpm check:env` | Validate `.env` and ping MongoDB |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | Quality gates |
| `pnpm contracts:schema` | Export JSON Schema of the model contracts to `Backend/schema/` for diffing against the model developer's Pydantic schema |

From the repo root (after `pnpm install` there), `pnpm dev:api` runs the mock model and the API together, and
`pnpm dev` adds the Frontend. To make the API talk to the mock model over HTTP instead of the
in-process fixtures, set `MODEL_MODE=live` in `Backend/.env` (`MODEL_BASE_URL` defaults to
`http://localhost:4100`). In live mode the backend **waits for the model's `/v1/health`** before it starts (up to
`MODEL_WARMUP_MAX_WAIT_MS`), so starting both together does not race. A model that answers `warming` counts as up;
a model that never answers is not fatal: the backend starts anyway and shows the model status as `error`.

The mock model has simulation modes for testing the failure handling (cold start, latency, per-item failures,
taxonomy mismatch, malformed responses, and the three-class contract). Use `POST /__control`, for example:

```bash
curl -X POST localhost:4100/__control -H 'content-type: application/json' -d '{"warmupSeconds": 30}'
curl -X POST localhost:4100/__control -H 'content-type: application/json' -d '{"reset": true}'
```

Node 22 LTS (see `.nvmrc`; `engines` allows >= 20.19). Tests that use `mongodb-memory-server` download a MongoDB binary
on first run (about 700 MB on Windows) and cache it in `~/.cache/mongodb-binaries`.

## AI-assisted counter-narratives (Groq + fact base)

The writer is a retrieval-augmented generator (RAG): it searches a curated, source-attributed fact base
(`Backend/knowledge/ebola-facts.v1.json`), then asks Groq to write a short reply using **only** the facts found.

- **Turn it on:** in `Backend/.env` set `GENERATOR_MODE=groq` and `GROQ_API_KEY`. `pnpm check:groq --models` lists the
  models your key can use; `pnpm check:groq "a claim"` tries one real draft.
- **Retrieval** is keyword search (BM25) over a few dozen facts, with rumour-to-guidance synonyms and category topics.
  Groq has no embedding models, so none are used; the writer only sees what retrieval returns.
- **Guardrails:** the reply must cite only facts it was shown, may add no number, phone number, link or email that the
  cited facts do not contain, and must fit the platform limit (one automatic repair attempt, then an error). With no
  relevant fact it writes nothing and says so. Claim text is untrusted and sits inside markers; only PII-scrubbed text is sent.
- **Facts expire:** entries carry `validUntil` (the WHO Bundibugyo vaccine guidance ends 2027-02-28) and are not used after it.
- **Review gate:** the file starts as `pending_ncdc_review`; drafts then carry a warning. Set `KNOWLEDGE_REQUIRE_REVIEW=true`
  to refuse until a reviewer changes it to `approved`. Settings shows every fact, its source, and what is missing.
- **Nothing is sent automatically.** A draft is still read, edited and approved by a person.

## Recurring claims (narrative clustering)

Flagged posts from the last two weeks are grouped by the claim they make (TF-IDF word similarity, deterministic and
offline), so this week's count and last week's sit side by side and each group gets a trend (new, rising, steady,
falling). One-off posts are counted but not listed. Only the PII-scrubbed text is used.

- **AI step (optional):** `CLUSTER_REFINER=ai` lets Groq merge the same rumour written in different languages (for
  example the salt-water claim in English, Pidgin, Hausa, Yoruba and Igbo) and give each group a title and one-sentence
  summary. It runs in the background: the page answers at once with keyword groups and upgrades on the next refresh. If
  Groq is slow, down or wrong, the keyword groups stay. AI-written titles are labelled "AI-named".
- Shown on the Overview ("Recurring claims") and in full on **Recurring claims**, where a response can be drafted from a
  claim's sample post. The Overview also has a surge map under the weekly chart.

## Run the Frontend

```
cd Frontend
pnpm install
pnpm dev          # http://localhost:5173
```

In development Vite proxies `/api` and `/socket.io` to the backend (`DEV_PROXY_TARGET`, default `http://localhost:4000`), so
the session cookies are first-party and there is no CORS to configure. In production set `VITE_API_URL` and
`VITE_SOCKET_URL` and allow the site's origin in the backend's `FRONTEND_URL`.

**Try it without Atlas:** `pnpm dev:demo` in `Backend/` starts the API on an in-memory database with the mock model,
the synthetic feed and demo accounts (printed on start; password `demo-password-123`). Nothing is kept when it stops.
Run it with `PORT=4010` and `DEV_PROXY_TARGET=http://localhost:4010 pnpm dev` to keep it apart from a real backend.

| Command (in `Frontend/`) | What it does |
|---|---|
| `pnpm sync:contracts` | Copy `Backend/src/contracts/api` into `src/contracts` (a Backend test fails if the copy drifts) |
| `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` | The usual gate |

**How it is built**

- Server state lives only in TanStack Query. Context is used for two things: who is signed in, and toasts.
- Every API response is validated with the shared zod contracts; a drifted response shows a clear error, not a crash.
- Socket.io events patch or invalidate those same queries. A burst of urgent posts becomes one toast and a summary.
- Desktop notifications use the browser Notification API (opt-in, bell in the header, only while the tab is in the
  background). Real background push (app closed) needs a service worker and Web Push keys on the backend.
- Category, stance and language names come from `/api/taxonomy` by the classification's own version. Severity looks
  and words live in `src/config/severity.ts`: each level has its own glyph and a text label, never colour alone.
- Icons and illustrations are drawn in code for this product (`src/icons`, `src/illustrations`); no icon library.
- What a person sees follows their permissions (`/api/auth/me`); the server enforces the same rules.

## Modes

| Setting | Values | Meaning |
|---|---|---|
| `MODEL_MODE` | `mock` | In-process fixtures, no network |
| | `live` | HTTP to `MODEL_BASE_URL` (this can be the mock model server; provenance follows what the model says about itself) |
| `MODEL_CONTRACT` | `multilabel-v1`, `threeclass-v0` | Which external shape the adapter reads. `threeclass-v0` is an assumed shape |
| `INGESTION_MODE` | `mock` | Synthetic feed (MockConnector) |
| | `push` | Posts arrive through `POST /api/ingest` |

`GET /api/system/status` reports the provenance of every stage (ingestion, classifier, generator,
dispatcher). Mock data is stamped `isMock` and every read is scoped to the current run, so mock and real data
never mix.

## Pipeline

```
ingest (MockConnector or POST /api/ingest, X-Api-Key)
  -> scrub PII (handles, URLs, emails, phones incl. +234 / 0803)  -> author HMAC-SHA256
  -> store Post (raw text is never persisted)
  -> in-process queue -> ClassifierClient (adapter per contract)
  -> Classification (append-only)  -> Decision (pure rules, mode-aware, recomputable)
  -> Post.triage (denormalised for queues) -> socket event post:classified
```

The database is the source of truth. The queue is rebuilt on boot from `pending|classifying` posts.

## Decisions are data

Thresholds, severity floors, keyword rules and confidence bands live in `RulesConfig` (Mongo, keyed by
taxonomy version) and are shown read-only in the UI. Changing the operating mode (`dormant`, `surge`)
affects new decisions only. `POST /api/admin/recompute-decisions` re-runs them explicitly and appends new
`Decision` rows; old ones are never rewritten.

## Privacy

PII is scrubbed before storage and before anything is sent to the model. Author handles are stored only as an
HMAC-SHA256 with `AUTHOR_HASH_SECRET`. Only coarse location (state / LGA) is kept. Fixtures and the synthetic
feed are invented; never use real scraped posts.

## Counter-narratives and dispatch (mocked)

`MockGenerator` writes canned drafts (English only, and it says so) that fit each platform's limit
(platform limits are configuration) and cite NCDC and WHO. `MockDispatcher` posts nowhere.
**No autonomous dispatch:** `DispatchService` sends only if the narrative is `approved`, the latest analyst
review is an approval of the *exact current text* (hash-bound), and it can atomically claim the narrative.
It re-checks the database rather than trusting the status flag, and the dispatcher verifies the approval proof
again. Editing after approval sends the narrative back to `draft`. All of this is tested, including attempts to
tamper with the database directly.

## Analytics

Read-only, open, and scoped to the current run's `isMock`. "Days" are Nigerian calendar days (WAT, UTC+1).

| Endpoint | What it returns |
|---|---|
| `/api/analytics/summary` | posts today, flagged in 7 days, review queue size with a cap warning (from 80% of `QUEUE_CAP`), overdue, dispatched today, pipeline states |
| `/timeseries` | last 7 days stacked by label (a flagged post counts under its top category) |
| `/breakdown?days=` | platform and language, with flagged counts |
| `/clusters` | placeholder: flagged posts grouped by top category (real clustering is `TODO(ext)`) |
| `/geo` (`?format=csv`) | every state and the FCT: density, week-on-week change, surge flag, dominant platform and language, top categories, LGA table |
| `/model-health?days=` | override rate, confidence histogram, latency P50/P95/P99, language agreement, and review-derived precision / recall / F1 |

**Surge:** more than +50% flagged posts week on week (exactly +50% is not a surge), with at least 3 flagged posts
this week. A state with none last week and at least 3 now counts as a surge (`newActivity`).
**Precision / recall / F1** come only from analyst reviews (latest review per post) and are always returned with
the sample size and a caveat: reviewers mostly see what the model flagged, so recall is optimistic.

## Multi-tenancy and sign-in

Posts are global; each organization (NCDC national, state epidemiology teams, partners) owns its users, analyst
reviews, counter-narratives, dispatches and settings. A state team can be limited to `scopeStates`. Review state is
kept per organization on the post (`orgState`), so one team confirming a post does not mark it reviewed for another.

**Onboarding**

1. `pnpm admin:create-super` creates the platform operator (the only way to make one).
2. The operator creates an organization (`POST /api/organizations`) and gets a one-time claim link.
3. The first person to open the link becomes that organization's admin; the link is single use and expires.
4. The org admin invites analysts, senior analysts and supervisors (`POST /api/users-invites`), again by one-time link.

**How it is enforced**

- Sessions are HttpOnly cookies (`ew_access`, `ew_refresh`) or a bearer token; cookie requests from another origin are refused.
- Every request re-reads the user and organization (30 s cache, invalidated on change), so deactivation and
  suspension apply at once, and suspending an organization disconnects its sockets.
- Routes ask for permissions (`src/auth/permissions.ts`), never roles. The operator never acts inside a tenant.
  Only a national organization's supervisor or admin can change the operating mode.
- Tenant-owned models carry a required `organizationId`, and a Mongoose guard throws on any query or aggregate
  without a tenant condition. Sockets join `org:<id>` rooms, never one global room for tenant data.
- Emails are globally unique. Settings reject unknown keys.
- `tests/tenancy.test.ts` holds the cross-tenant matrix: org A's token gets 404 on org B's resources by id, and
  B's lists and analytics do not change when A acts.

**Existing data:** `pnpm migrate:tenancy --dry-run`, then `pnpm migrate:tenancy` (and `--assign-org <slug>` to give
earlier reviews, narratives and dispatches to an organization).

## Not built yet (TODO(ext) markers in code)

Real platform connectors (they run in the Python / HuggingFace service and push to `/api/ingest`), real RAG and
LLM calls, real platform posting, alert and escalation delivery, surge auto-detection, PDF export, organization-owned ingest keys (posts with `visibility: "org"` are read-aware but nothing writes them yet).
