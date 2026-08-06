# 1 — Pre-Development Phase

Decisions made before the scoring code existed, reconstructed from the shape of the codebase.

## Data-source selection

The pipeline standardises on **free, open, programmatically-accessible** sources so the whole thing can be rebuilt from scratch with only a `DATABASE_URL`:

| Layer | Source chosen | Why this one |
|---|---|---|
| Historical weather | Open-Meteo ERA5 archive (`archive-api.open-meteo.com`) | Uniform global reanalysis back to 1950; a single daily+hourly endpoint gives wind, gust, temperature, rain, and MSL pressure with consistent units. No API key, generous history. |
| Waves / swell / SST | Open-Meteo marine archive | Same provider, gridded wave height, swell height/period, wind-wave height, and SST from 2000. |
| Sea-temperature fallback | Marine Institute ERDDAP `IWBNetwork` buoys (M2/M3) | Fills SST gaps where the marine grid lacks it. |
| Tidal range + HW/LW times | Marine Institute ERDDAP `IrishNationalTideGaugeNetwork` | Real 6-minute gauge data (from 2006) rather than a pure model; lets us extract observed high/low times, not just a range. |
| Tide predictions (forecast) | Marine Institute ERDDAP `IMI_TidePrediction_HighLow` | Forward-looking HW/LW for the 5-day forecast. |
| Incidents | RNLI Return of Service (ArcGIS) + curated JSON | RNLI Open Data is the only structured, dated, geolocated coastal-incident feed; news/inquest cases fill in drownings RNLI does not capture. |
| Forecast wind | Met Éireann `locationforecast` XML | National forecast for the live 5-day view. |
| Moon phase / daylight | SunCalc (computed) | Deterministic, no network, works for any date — essential for the pre-gauge tide proxy and daylight windows. |

**A key selection consequence:** the Marine Institute marine grid returns all-nulls at coastal points, so `probe-wave-points.ts` walks *seaward* along each beach's bearing until it finds a grid cell with real wave data, then stores that offshore `wave_lat/wave_lon`. This was a pre-requisite discovered during source evaluation, not an afterthought.

## Scoring approach — what was considered

The repository contains evidence of at least three approaches being explored, in roughly this order:

1. **Similarity matching (built, then demoted).** `src/lib/similarity.ts` implements a 15-feature fingerprint per incident and a weighted-Gaussian similarity score. The original product idea (still visible in the welcome wizard copy) was "today looks like these past dangerous days." This was fully built — including per-feature explainability — but is **no longer the tier driver**. In `forecast.ts` the similarity match is explicitly demoted to informational (`// Precedent lookup — demoted to informational, no longer drives tier`).

2. **Discrimination test (the gate that changed the design).** Before trusting any hazard model, `scripts/analysis/discrimination.ts` ran a case-control study: in-scope incident days vs seasonally-matched control days at the same beach. The result was a **null**: no feature discriminated at n≈51. This is why the product does not claim prediction and why similarity was demoted — see [5 — Evaluation Framework](5-evaluation-framework.md).

3. **Rank-calibrated climatological anomaly (the shipped model).** Given that no feature predicts incidents, the design pivoted to something defensible and honestly-framed: express how unusual a day is versus the beach's own history. `scoreDay()` blends a hazard index and an exposure proxy, and the tier is a *rank* against the annual distribution rather than a probability.

## Alternatives rejected

- **A trained ML classifier** — rejected because 51 positive cases cannot support a validated model; the discrimination power analysis put the minimum detectable AUC at ≈0.64.
- **Fixed absolute thresholds** (e.g. "Severe if wave > 3 m") — rejected because the meaning would drift across beaches and seasons; rank calibration keeps "Severe ≈ worst 5% of days for this beach and month" stable year-round.
- **Similarity as the alert driver** — rejected after the discrimination null result; kept in the UI as precedent context only.
- **A bespoke tide model** — rejected in favour of real gauge extrema (post-2006) plus a transparent moon-phase spring/neap proxy for older dates.

## Design principles established up front

- **One scoring function, many callers.** Forecast, backtest, climatology builder, and retrospective pages all call the same `scoreDay()`. No parallel "backtest proxy" that could drift from production.
- **Missing data is `null`, never `0`.** A recurring, explicitly-commented rule: a data outage must never silently read as a benign or a severe day.
- **Pure core, impure edges.** Everything in `src/lib/` that scores is network-free and DB-free so it is unit-testable; I/O lives in scripts and `db/queries.ts`.
