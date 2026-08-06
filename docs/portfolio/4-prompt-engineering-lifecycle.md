# 4 — Prompt Engineering Lifecycle

Claude is used in exactly one place: **incident enrichment** in `scripts/etl/enrich-incidents.ts`. It runs offline during ETL, never at request time, and never in a unit test. This document covers what it extracts, the prompt design, and the guards around it.

## Where it sits in the pipeline

Incidents arrive from two ingest paths:

1. **RNLI** (`ingest-rnli.ts`) — a regex classifier tags obvious exclusions (`man_overboard`, `medical`, `mechanical`, `false_alarm`). Everything it cannot confidently exclude is left `condition_related = NULL`.
2. **Curated JSON** (`seed-incidents.ts`) — hand-written events, usually with no activity/condition classification.

`enrich-incidents.ts` then processes **only rows where `condition_related IS NULL`** — i.e. exactly the ambiguous residue the cheap deterministic pass could not resolve. This keeps LLM usage minimal and idempotent: re-running enrichment does nothing once every row is classified.

## The extraction contract

The model receives a batch (chunks of 20) of `{ id, description }` objects and must return a JSON array with, per incident:

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Echoed back unchanged (the join key) |
| `time_of_day` | `"HH:MM"` \| null | Only if an explicit clock time is stated |
| `activity` | enum | `swimmer` \| `watercraft` \| `shore` \| `other` \| `unknown` |
| `condition_related` | boolean | Was the incident *caused* by sea/weather conditions? |
| `exclusion_cause` | enum \| null | Set only when `condition_related` is false |
| `evidence` | string (<20 words) | A supporting quote from the description |

The system prompt spells out the semantics of each enum value (e.g. `watercraft` = kayak/lilo/inflatable/dinghy/jet ski) and encodes two deliberate biases: **when uncertain about `condition_related`, prefer `true`** (coastal conditions are usually involved, and downstream scope filters are conservative), and **return `null` for `time_of_day` unless a specific clock time is present**.

## Model and cost design

- **Model:** `claude-haiku-4-5-20251001` — the cheapest capable tier, appropriate for short structured classification over a few hundred rows.
- **Prompt caching:** the system prompt is sent with `cache_control: { type: "ephemeral" }`, so the (long, static) instruction block is cached across every batch in a run rather than re-billed per chunk.
- **Batching:** 20 incidents per request with `max_tokens: 2048` amortises request overhead.
- **The `evidence` field** doubles as an audit trail — it is persisted to `incidents.activity_evidence` so a human can later check *why* the model classified something.

## Guards (input and output)

The code treats the model as fallible and untrusted-ish, even though the source text (RNLI) is trusted:

- **Input sanitisation** — `sanitizeDescription()` strips control characters and caps length at 2000 characters before the text reaches the prompt.
- **Strict output parsing** — the response is trimmed, markdown code-fences (```` ```json ````) are stripped, then `JSON.parse`d and checked to be an array. A parse failure logs a warning and returns `[]` for that batch (the rows simply stay `NULL` and get retried on the next run).
- **Time-hallucination guard** — the single highest-risk output is `time_of_day`, so `verifyReportedTime(description, extracted)` (in `src/lib/extract-time.ts`, unit-tested) **rejects any time not independently confirmed** in the source: either the local regex time parser finds the same value, or the literal `HH:MM` string appears verbatim in the text. Anything else is nulled out. The model cannot invent a clock time.
- **Enum trust** — `activity`, `condition_related`, and `exclusion_cause` are written straight through, but the DB `CHECK` constraints on those columns reject out-of-vocabulary values at the write boundary.

## How the prompt was designed

The prompt's shape reflects the downstream needs rather than generic extraction:

- The `activity` enum exists because the scoring scope is specifically `swimmer`/`shore` incidents — watercraft and other pathways are excluded (see [0](0-product-design-brief.md) and [3](3-data-model-reference.md)).
- The `exclusion_cause` enum mirrors the RNLI regex classifier's categories, so LLM and keyword classifications land in the same vocabulary and can be reconciled.
- The `condition_related`-prefers-true bias exists because the analysis pipeline already applies conservative scope filters (`IS NOT FALSE`); the safer failure mode is to keep a borderline incident in scope and let the human-reviewable evidence field flag it.

## The bigger point

The LLM is a **last-resort classifier for the ambiguous minority**, wrapped in deterministic guards. The expensive/uncertain path (an LLM) only runs where the cheap/certain path (regex + curated fields) has already given up, and its single hallucination-prone output is verified against source text before it is trusted.
