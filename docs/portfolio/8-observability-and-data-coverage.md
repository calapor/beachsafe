# 8 — Observability & Data Coverage

Honest coverage accounting is a first-class concern in BeachSafe: the model's credibility depends on knowing exactly what data backs each score, and on refusing to score where it cannot.

## Per-layer coverage

Every observation carries a `source_flags` JSONB annotation (e.g. `{"weather":"era5_openmeteo","tide":"gauge","moon":"computed"}`), merged per ingest so provenance is traceable at the row level. Coverage windows differ by layer:

| Layer | Source | Coverage window | Notes |
|---|---|---|---|
| Daily weather | Open-Meteo ERA5 archive | 1950–present | The deepest layer; near-complete since 1950 |
| Moon phase / illumination | SunCalc (computed) | any date | Exact, no gaps |
| Tidal range + HW/LW times | Marine Institute gauge network | 2006–present | Real 6-minute gauge extrema |
| Tidal range (proxy) | Moon-phase spring/neap | before 2006 | Approximate; `tide_range_m` only, no HW/LW times |
| Waves / swell | Open-Meteo marine archive | 2000–present | Offshore grid point, not nearshore |
| Sea temperature | Marine marine grid + buoy (M2/M3) fallback | 2000–present | Sparse pre-2005 |
| RNLI launches | RNLI Return of Service (ArcGIS) | ~2008–present | Swimmer/shore scope enforced downstream |
| Incident classification | Claude Haiku + regex + human review | all incidents | Evidence field persisted for audit |

The consequence: **each metric's climatology covers only its own data window.** Wave-height percentiles are built from 2000-onward data; weather percentiles from 1950-onward. A score for a 1995 day has weather and a moon-proxy tide but no wave component — and the hazard index renormalises over what exists rather than inventing the rest.

## What "decades of data" means in practice

The banner-level claim of many decades of environmental data is true for the *weather backbone* (ERA5 from 1950) and *astronomy* (any date), but it is important to state precisely what is and isn't covered:

- **Deep:** weather (1950+) and moon/tide-proxy (any date) give a long climatological baseline for wind, gust, temperature, pressure, rain, and spring/neap tidal range.
- **Shallow-ish:** waves and SST only exist from 2000; real tide-gauge extrema and HW/LW timing only from 2006.
- **Sparse:** the incident record. This is the binding constraint on everything (see below).

So "decades of data" describes the environmental *observation* history, not the incident history. The observation history is deep enough to calibrate robust percentile ladders (≥100 samples per beach/month/metric is enforced by `buildLadder`); the incident history is not deep enough to validate a predictive model.

## The incident-coverage gap (the binding constraint)

Documented on the `/methodology` page and reflected throughout the analysis code:

- **n ≈ 51 in-scope incidents** (condition-related swimmer/shore), pooled across three beaches. Too few to train a model or validate any single feature at conventional significance — the discrimination power analysis puts the minimum detectable AUC at ≈0.64.
- **0 of 51 have a recorded `time_of_day`.** RNLI midnight timestamps are suppressed as "not recorded," and curated events rarely state a clock time. This removes the ability to do hourly tide-phase analysis — the natural timescale of rip-current drowning — and is why the `ebbNearLow`/`tideState` features fall back to a daylight-window estimate (`tideConfidence = 0.5`) rather than a measured phase (`tideConfidence = 1`).
- **Scope exclusions are counted and surfaced.** `getExcludedIncidentCounts()` tallies why incidents were excluded (watercraft, medical, man-overboard, false alarm), and the methodology page renders these per beach — so the reader can see how many events were dropped and why, not just the survivors.

## How the system observes its own coverage

- **`Coverage { weather, waves, tide, swell }`** is threaded through every scoring call. When neither weather nor waves are present, the tier is forced to `unknown`; the UI shows "data unavailable" rather than a misleading Low/green.
- **Evidence labels** — each hazard component reports `validated` / `suggestive` / `unvalidated` / `insufficient-data`, so a low-data component is visibly flagged rather than silently averaged in.
- **`coverage_start` / `coverage_end`** are stored on every climatology ladder and surfaced in UI copy, so a user can see the exact window a percentile is calibrated against.
- **In-app methodology page** renders the live `feature_discrimination` table and per-beach exclusion counts directly from the DB — the system's evaluation state is observable in production, not just in a README.

## Operational observability

- `/api/health` provides a liveness probe.
- ETL scripts are verbose and incremental: `ingest-weather.ts` logs its fetch window and re-fetches the last 7 days each run; ingest scripts log per-chunk progress and honour rate-limit `Retry-After`.
- The backtest and tier-frequency scripts are **gated**: they exit non-zero when the model regresses below acceptance bars (lift@25% ≥ 1.5×; tier frequencies within target bands), making model quality a checkable signal rather than a subjective judgement.

## Uptime Monitoring

Beyond the in-app coverage and health signals above, production uptime is watched by **Uptime Kuma**, which runs in the shared `platform` namespace on the same k3s cluster. It polls the deployed BeachSafe service endpoint and alerts the operator when thresholds are breached (endpoint down or response time exceeded), complementing the app's own `/api/health` liveness probe. The Uptime Kuma dashboard is at `http://192.168.1.101:30001`; monitor configuration lives in Uptime Kuma's own database and is managed via its web UI rather than in this repo.
