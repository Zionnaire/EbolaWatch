# Questions for the model developer

Answers received from the model developer are recorded here. Items still marked ASSUMED are built into our
contract files and fixtures and need confirming.

| # | Question | Answer |
|---|---|---|
| 1 | Auth header for the model API? | **`X-ML-API-Key: <key>`**. Implemented: set `MODEL_API_KEY`; sent on classify, health and taxonomy. A 401/403 is treated as our configuration bug (no retry, critical alert, status `error`). |
| 2 | Is `X-Request-Id` echoed back? | **No.** We do not rely on it. |
| 3 | Error body for 400 / 422? | **FastAPI standard: `{"detail": "message"}`.** Implemented: the message is shown in item errors and logs. (Real FastAPI sometimes sends a list of validation errors as `detail`; that is understood too.) |
| 4 | Are `categories` populated when `is_ebola_related` is false? | **Yes, all categories, with low scores.** Matches our assumption. (Only relevant to `multilabel-v1`.) |
| 5 | Taxonomy shapes for `stances` and `languages`? | **`{ "id": "...", "display_name": "..." }`.** Matches our assumption. (Only relevant to `multilabel-v1`.) |
| 6 | Definitions of severity levels 0 to 4? | **0 = Irrelevant, 1 = Low risk, 2 = Moderate, 3 = High risk misinformation, 4 = Critical misinformation.** To be used for the severity labels in `Frontend/src/config/`. |
| 7 | Text limit in characters or code points? | **2,000 characters, but still being decided** (could become lower or higher). Implemented as a setting: `MODEL_MAX_TEXT_CHARS` (default 2000). We cut longer text ourselves and mark the result `truncated`. **Still open:** characters vs code points, and the final number. |
| 8 | Is mock/staging identifiable? | **Yes, by `model_version`: mock returns `v0.0.0-mock`, production returns `v1.0.0`.** Our `MODEL_MOCK_MARKER` (default `mock`) matches it. |
| 9 | Which output shape is the real one? | **`threeclass-v0`** (Misinformation / Factual / Irrelevant with confidence scores). Set `MODEL_CONTRACT=threeclass-v0` for the real model. |
| 10 | Is the 3-class batch envelope and per-item shape as in `threeclass.ASSUMED.json`? | **Answered "yes, same shape" but the field list given does not match it. See below: OPEN.** |

## OPEN: the real `threeclass-v0` shape

The developer said the envelope is "the same shape as `threeclass.ASSUMED.json`" and that each item returns
`post_id, label, confidence, entropy, language, platform, model_version, alternatives`. Our assumed item is
different:

| Assumed (`threeclass.ASSUMED.json`) | Described by the developer |
|---|---|
| `item_id` | `post_id` |
| `status` (`completed` / `failed`) and an `error` object for failures | not mentioned |
| `probabilities: {misinformation, factual, irrelevant}` | `confidence` (one number?) and `alternatives` (the other classes?) |
| `latency_ms` | not mentioned |
| model identity in the envelope (`model.name`, `model.version`) | `model_version` on each item |
| `language`, `entropy`, `label` | same names |
| (none) | `platform` |

We will not guess these field names: the `"complete"` vs `"completed"` bug is exactly what the runtime schemas are
there to prevent. What we need from the developer, in order of usefulness:

1. The service's **`/openapi.json`** (FastAPI generates it; `pnpm contracts:schema` exports ours for diffing), or
2. one real **request body and response body** (`curl` output) for a batch with a mix of normal and failing items.

Specific questions the sample must answer:

- Request: is the item id called `post_id` or `item_id`? Is `taxonomy_version` sent? Any `request_id`?
- Response envelope: what are the top-level keys? Is there a batch `status`, a `request_id`, a `model` object?
- Per item: how does a failed item look (empty text, internal error)? Is there an item `status`?
- Is `confidence` the probability of the predicted `label` on a 0 to 1 scale? What exactly is in `alternatives`
  (a list of `{label, confidence}` for the other classes)?
- Label spelling: lowercase `misinformation | factual | irrelevant`, or capitalised?
- Are `entropy` and `language` ever null? Which language values appear (`en`, `pcm`, `ha`, `yo`, `ig`, `fr`, `und`)?
- Does the 3-class service have `GET /v1/health` (same shape) and `GET /v1/taxonomy` (we assume no taxonomy)?
- Is there a severity in the output, or is it derived by us from the confidence bands (current placeholder)?

When the sample arrives, the change is confined to: `Backend/src/contracts/model/threeClassV0.ts`, the fixture
`threeclass.ASSUMED.json` (and its name), `Backend/src/classifier/adapters/threeClassV0.ts`, and the three-class
mode of the mock model.
