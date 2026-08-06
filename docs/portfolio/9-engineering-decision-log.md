# 9 — Engineering Decision Log

Key decisions, the alternatives considered, and why the shipped choice won. Each is grounded in the codebase.

## 1. Rank-calibrated tiers rather than fixed thresholds

- **Decision:** tiers are percentiles of each beach's own annual score distribution (`Severe ≥ 95th`, etc.), stored as 101-point ladders at `climatology(month=0)`.
- **Alternatives:** fixed absolute cutoffs (e.g. "Severe if wave > 3 m"); a single global distribution across all beaches.
- **Rationale:** absolute thresholds would mean wildly different things at sheltered Fountainstown vs Atlantic Ballybunion and would drift by season. Rank calibration keeps "Severe ≈ worst 5% of days here" stable across beaches and months. `tier-frequency.ts` verifies the realised frequencies actually hold.

## 2. One `scoreDay()` shared by forecast, backtest, and climatology

- **Decision:** a single pure scoring function in `risk.ts` is imported by the live forecast, the retrospective pages, the climatology builder, and the backtest.
- **Alternatives:** a fast "backtest proxy" separate from production scoring (common in ML pipelines).
- **Rationale:** a proxy inevitably drifts from production and invalidates the evaluation. Sharing one implementation guarantees the score you're evaluated on is the score users see. The cost — replaying `scoreDay()` over all history during calibration — is acceptable for an offline batch job.

## 3. Missing data is `null`, never `0`

- **Decision:** `percentileOf()` returns `null` for absent inputs; `hazardIndex()` returns `null` below half-coverage; coverage gating forces `unknown`.
- **Alternatives:** default missing values to 0 (simpler code, no null-plumbing).
- **Rationale:** a prior version that defaulted to 0 produced silent "severe" alerts on data outages — the worst possible failure for a safety-adjacent tool. Null-propagation makes a data gap visible as `unknown` instead of a false reading.

## 4. Similarity matching built, then demoted to informational

- **Decision:** the 15-feature weighted-Gaussian similarity engine (`similarity.ts`) remains in the codebase and UI but no longer drives the tier.
- **Alternatives:** keep similarity as the alert driver (the original product concept); delete it.
- **Rationale:** the discrimination null result ([5](5-evaluation-framework.md)) showed similarity to past incidents was not a defensible predictor. It was demoted to "precedent context" and the tier moved to the rank-calibrated anomaly model. It was kept, not deleted, because per-feature explainability is genuinely useful UI.

## 5. Neon serverless Postgres

- **Decision:** Neon via the `@neondatabase/serverless` HTTP driver.
- **Alternatives:** SQLite/file DB; a traditional connection-pooled Postgres; a document store.
- **Rationale:** the workload is relational (joins across beaches/observations/incidents/climatology) and benefits from real SQL (percentile queries, `unnest`-based bulk upserts, JSONB). Neon's HTTP driver works from serverless/edge functions without connection-pool management, matching a Vercel deployment. The same `DATABASE_URL` serves local ETL and production.

## 6. Next.js (App Router) for a data-heavy app

- **Decision:** Next.js 16 App Router with server components; scoring runs server-side, only rendered results reach the client.
- **Alternatives:** a static site generator with a separate API; a SPA + standalone backend.
- **Rationale:** server components let pages query Neon and call `scoreDay()` directly without shipping a scoring bundle or an extra API tier. `force-dynamic` on data routes keeps forecasts live. One deployable artifact (with `/api/*` routes for the JSON surface) rather than two.

## 7. SunCalc for moon phase and the pre-gauge tide proxy

- **Decision:** compute moon phase/illumination and daylight with SunCalc; derive a spring/neap tide-range proxy from moon phase before real gauge data exists (pre-2006).
- **Alternatives:** a paid ephemeris/tide API; omit tides before 2006.
- **Rationale:** SunCalc is deterministic, free, offline, and works for any historical date — essential for building deep climatology. The spring/neap proxy (spring when the moon is within 0.12 of new or full) is a transparent, physically-grounded approximation, clearly flagged in `source_flags` as `"tide":"estimated"` so it is never confused with gauge data.

## 8. Offshore wave-point probing

- **Decision:** `probe-wave-points.ts` walks seaward along each beach's bearing to find the nearest Open-Meteo marine grid cell that returns real (non-null) wave data, and stores it as `wave_lat/wave_lon`.
- **Alternatives:** query the beach's own coordinates; hard-code offshore points by hand.
- **Rationale:** the marine grid returns all-nulls at coastal points, so querying the beach coordinate yields nothing. Automated seaward probing is reproducible and self-documenting, and keeps the offshore point tied to each beach's actual exposure direction.

## 9. LLM only for the ambiguous residue, wrapped in deterministic guards

- **Decision:** Claude Haiku classifies only incidents the cheap regex pass left `condition_related IS NULL`, with a hallucination guard on extracted times and strict JSON/enum validation.
- **Alternatives:** LLM-classify every incident; no LLM at all (regex only).
- **Rationale:** most RNLI exclusions are keyword-obvious and don't need an LLM; running the model only on the ambiguous minority minimises cost and blast radius. Guards (`verifyReportedTime`, DB `CHECK`s, fail-open parsing) mean a bad model response degrades gracefully rather than corrupting the dataset. See [4](4-prompt-engineering-lifecycle.md) and [6](6-ai-safety-and-considerations.md).

## 10. Exposure weighted above hazard (0.65 / 0.35), chosen by sweep

- **Decision:** the blend weights exposure at 0.65, chosen from the `backtest.ts` out-of-fold lift sweep, with a hazard-only comparison confirming hazard still adds signal above the noise floor.
- **Alternatives:** equal weighting; hazard-dominant; hand-picked weight.
- **Rationale:** empirically the exposure/seasonality structure carries more of the incident-ranking signal than any single physical hazard variable (consistent with the discrimination null). The weight is *derived from evaluation*, not asserted, and the sweep is re-runnable.

## 11. Pure core, impure edges (testability policy)

- **Decision:** all scoring lives in network-free, DB-free modules in `src/lib/` with Vitest unit tests; all I/O lives in `scripts/` and `db/queries.ts`. No `*.test.*` file imports the Anthropic SDK or hits a network.
- **Alternatives:** integration-test the scoring against a live DB.
- **Rationale:** pure functions make the safety-critical logic (percentiles, null-propagation, tier thresholds, time verification) fast and deterministic to test, and keep CI free of external cost. API-dependent behaviour is confined to scripts that CI can skip via `--skip-enrich` / seed-only paths.

## 12. Publishing the null result in-product

- **Decision:** the `/methodology` page renders the live discrimination table and states plainly that no feature discriminates at this sample size.
- **Alternatives:** present only the positive backtest numbers; keep caveats in internal docs.
- **Rationale:** for a safety-adjacent tool, over-trust is the real risk. Surfacing the honest limitation prevents users (and reviewers) from reading tiers as predictions, and it is a stronger engineering signal than a polished but overclaimed dashboard.
