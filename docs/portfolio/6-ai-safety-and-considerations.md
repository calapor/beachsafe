# 6 — AI Safety & Considerations

Two distinct "AI safety" surfaces exist in BeachSafe: the **LLM** (Claude, used for incident enrichment) and the **risk model** (the scoring that reaches users). Both are handled conservatively, and both fail open toward *not making things worse*.

## LLM output validation

Claude runs only in `scripts/etl/enrich-incidents.ts`, offline. Its output is never trusted blindly:

- **Structural validation.** The response is trimmed, de-fenced, `JSON.parse`d, and checked to be an array before any use. A malformed response yields `[]` and the batch is skipped.
- **Vocabulary validation.** `activity`, `time_source`, and `exclusion_cause` are constrained by Postgres `CHECK` clauses; an out-of-enum value from the model is rejected at write time.
- **Hallucination guard on the high-risk field.** Extracted `time_of_day` is the most consequential and most hallucination-prone output (a wrong clock time would corrupt any tide-phase analysis). `verifyReportedTime()` accepts the value only if the deterministic regex parser independently finds the same time, or the literal `HH:MM` appears verbatim in the source text. Otherwise it is set to `null`. The model cannot introduce a time that isn't in the evidence.
- **Auditability.** The model's `evidence` quote is persisted (`incidents.activity_evidence`) so classifications remain human-checkable after the fact.

## What happens when enrichment fails

Failure modes and their handling:

| Failure | Behaviour |
|---|---|
| API/network error | The batch throws; the script exits non-zero. Rows stay `condition_related IS NULL` and are retried next run (enrichment only targets NULL rows, so it is idempotent). |
| Malformed JSON from the model | Warning logged, batch returns `[]`, rows stay NULL. |
| Unverifiable extracted time | Time nulled; the rest of the classification is still applied. |
| `ANTHROPIC_API_KEY` absent | Enrichment can be skipped entirely (`pnpm etl:ingest-only`, or `--skip-enrich`); the pipeline still produces a working dataset. |

The critical property: an unclassified incident (`condition_related = NULL`) is **conservatively kept in scope** by the downstream `IS NOT FALSE` filters. A failed or skipped enrichment therefore degrades toward *including* borderline incidents, not silently dropping them.

## Risk-model safety — the "never silently severe/benign" rule

The scoring code treats missing data as the primary hazard to itself. This is stated repeatedly in comments and enforced structurally:

- **Missing inputs produce `null`, never `0`.** `percentileOf()` returns `null` for an absent value or table. A prior bug where missing data defaulted to `0` caused silent "severe" readings on data outages; the current design forbids it.
- **Half-data threshold.** `hazardIndex()` returns `score = null` if fewer than half the components have data, rather than extrapolating from one signal.
- **Coverage gating.** Every scoring context carries `Coverage { weather, waves, tide, swell }`. In both the live forecast and retrospective scoring, when neither weather nor waves are available the tier is forced to `unknown` — the UI shows "data unavailable," not a green light.
- **Offshore vs missing wind.** In the hazard components, an *offshore* wind is scored 0 as a genuine known-absence of onshore hazard, while a *missing* wind reading is `null` — the code distinguishes "we know it's calm/offshore" from "we don't know."

## Product-level safety framing

Because the honest evaluation ([5](5-evaluation-framework.md)) shows the model cannot predict incidents, the product is built to avoid over-trust:

- The dashboard banner, welcome wizard, and methodology page all state **"pattern match, not a prediction"** and **"always follow lifeguard and coast guard advice."**
- Tiers are described as **climatological anomaly**, not incident probability.
- Hazard components carry explicit validation labels (`validated` / `suggestive` / `mechanism-only`) so a technical reader sees which signals are evidence-backed and which are physically-motivated hypotheses.
- The discrimination null result is published *in the app*, not buried — an unusual and deliberate transparency choice.

## Data-handling notes

- No personal data is processed. Incident records are public RNLI/news data; descriptions are the only free text and are length-capped and control-char-stripped before reaching the model.
- The LLM path incurs cost, so it is isolated to ETL, gated behind `ANTHROPIC_API_KEY`, excluded from CI's seed path, and never imported into any `*.test.*` file (unit tests are pure and network-free by policy).
