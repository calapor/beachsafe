# 2 — System Architecture

See [`docs/diagrams/architecture.puml`](../diagrams/architecture.puml) for the rendered component diagram.

BeachSafe has two runtimes that share one scoring core:

- **Offline ETL / analysis** — TypeScript scripts run with `tsx` (`pnpm etl`, `pnpm analysis:*`). They fetch external data, write to Postgres, and pre-compute climatology.
- **Request-time serving** — the Next.js App Router app. Pages and API routes read from Postgres, fetch live forecast inputs, and score days.

The bridge between them is `src/lib/` — pure, network-free scoring code imported by both. The tier a user sees in the live forecast is produced by the exact same `scoreDay()` that the backtest and the climatology builder use.

## Layer 1 — ETL pipeline (`scripts/`)

Orchestrated by `scripts/etl/run-all.ts` in dependency order (skippable via `--skip-*` flags):

1. **`migrate.ts`** — applies `src/db/schema.sql`, seeds the three beach rows, and runs idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` migrations plus an external-id dedup/unique-index step.
2. **`ingest-weather.ts`** — Open-Meteo ERA5 daily weather per beach. Incremental: it queries the latest stored date, re-fetches the last 7 days to catch corrections, and bulk-upserts in chunks. Handles HTTP 429 with `Retry-After` backoff.
3. **`ingest-waves.ts`** — Open-Meteo marine archive at each beach's offshore `wave_lat/wave_lon`; buoy SST fallback via Marine Institute ERDDAP.
4. **`ingest-tides.ts`** — Marine Institute gauge network. Smooths the 6-minute level series, detects HW/LW extrema with a minimum-separation constraint, and computes a robust tidal range bounded against the station's known spring range (rejecting implausible ranges as `NULL`).
5. **`compute-astro.ts`** — SunCalc moon phase/illumination for every observation missing it; sets a spring/neap tide-range proxy where no gauge range exists.
6. **`seed-incidents.ts`** — loads `data/incidents.{beach}.json`.
7. **`ingest-rnli.ts`** — RNLI Return of Service within 15 km of each beach; regex-classifies obvious exclusions (man-overboard, medical, mechanical, false alarm), leaving ambiguous cases `NULL`.
8. **`enrich-incidents.ts`** — Claude Haiku classifies the still-`NULL` incidents (see [4 — Prompt Engineering Lifecycle](4-prompt-engineering-lifecycle.md)).
9. **`build-fingerprints.ts`** — first applies a keyword pass over any RNLI records the LLM missed, then computes a feature vector for every in-scope incident over its 7-day-prior + day-of window (with a SunCalc daylight window).
10. **`build-climatology.ts`** — two passes: per-beach/per-month percentile ladders for 10 raw metrics, then annual (`month=0`) ladders for combined/hazard/exposure scores by replaying `scoreDay()` over all history.

A separate one-time script, `probe-wave-points.ts`, discovers each beach's offshore wave grid point before the first wave ingest.

## Layer 2 — Database (Neon Postgres)

Six tables: `beaches`, `observations`, `incidents`, `incident_fingerprints`, `climatology`, `feature_discrimination`. Full definitions in [3 — Data Model Reference](3-data-model-reference.md). Accessed through `@neondatabase/serverless` (HTTP driver, suitable for serverless/edge). All query helpers live in `src/db/queries.ts`.

## Layer 3 — Scoring core (`src/lib/`)

Pure, importable by both runtimes:

- **`risk.ts`** — `scoreDay()`, the unified entry point: `combined = 0.65·exposure + 0.35·hazard`.
- **`hazard.ts`** — `hazardComponents()` builds the physical/climatological components; `hazardIndex()` averages the available ones (null if <half present).
- **`exposure.ts`** — `computeExposure()`: temperature percentile, calm-wind, harmonic seasonality, weekend/bank-holiday/school-holiday.
- **`calibration.ts`** — `buildLadder()`, `percentileOf()`, `tierFromPercentile()`, `buildClimMap()`.
- **`similarity.ts`** — feature fingerprints, weighted-Gaussian match, tide-state derivation, explainability (informational only).
- **`extract-time.ts`** — regex time parser + `verifyReportedTime()` hallucination guard.

## Layer 4 — Serving (`src/app/`, `src/lib/forecast.ts`)

- **`forecast.ts` `getForecastDays()`** assembles live inputs — Met Éireann forecast wind (XML), Open-Meteo marine waves, Marine Institute tide predictions, SunCalc moon/daylight — into forecast observation rows, calls `scoreDay()`, and rank-calibrates the combined score against the annual ladder to a tier. It also computes daylight ebb windows and IST-localised tide events.
- **`historical-hazard.ts` `getHistoricalHazard()`** scores a past incident date against its own day's conditions and the same annual ladder.
- **`incident-conditions.ts`** fetches hourly ERA5 + marine conditions for an incident's day-of detail view.
- **Pages:** `/` (dashboard cards), `/beach/[slug]` (timeline + 5-day strip + chart), `/beach/[slug]/incident/[id]` (retrospective detail), `/methodology` (provenance + discrimination result).
- **API:** `/api/alerts?beach=<slug>` returns scored forecast days as JSON; `/api/health` is a health probe.

## Layer 5 — Analysis (`scripts/analysis/`)

Offline validation that reads the DB and reuses `scoreDay()`:

- **`backtest.ts`** — 5-fold year-block out-of-fold CV, AUC, lift at 10%/25% budgets, an exposure-weight sweep, a hazard-only comparison, and a calibration check. Exits non-zero if out-of-fold lift@25% < 1.5×.
- **`discrimination.ts`** — case-control per-feature AUC with Wilson CIs; writes `feature_discrimination`.
- **`tier-frequency.ts`** — replays realised tier frequencies against calibration targets.

## Cross-cutting responsibilities

- **Coverage tracking.** Every scoring context carries a `Coverage { weather, waves, tide, swell }` object; when primary layers are absent the tier collapses to `unknown` rather than guessing.
- **Determinism.** The only non-deterministic inputs are the live forecast fetches; historical scoring is fully reproducible from the DB.
- **Config for CI.** `migrate:ci` / `seed:ci` scripts let CI apply schema and seed a minimal dataset without the paid enrichment or slow ingests.
