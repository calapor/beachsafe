# 7 — Scoring Architecture

A deep dive on the scoring core: `src/lib/risk.ts` and its collaborators (`hazard.ts`, `exposure.ts`, `calibration.ts`). Everything here is pure — no network, no DB — and unit-tested.

## The unified entry point: `scoreDay()`

```
combined = EXPOSURE_WEIGHT · exposure + (1 − EXPOSURE_WEIGHT) · hazard
         = 0.65 · exposure + 0.35 · hazard
```

`scoreDay(window, bearingDeg, clim, coverage, calendar, opts)` takes an 8-row observation window (7 prior days + the day of interest), the beach's seaward bearing, that beach+month's climatology tables, a coverage descriptor, and a calendar object. It:

1. Builds a `FeatureVector` via `fingerprint()`.
2. Computes `hazardComponents()` → `hazardIndex()` → hazard score.
3. Computes `computeExposure()` → exposure score.
4. Blends them into `combined`.

Crucially, the blend **degrades gracefully**: if only one of hazard/exposure is available, `combined` becomes that one score; if neither is available it is `null`. The returned `combined` is a raw number, *not* a tier — rank calibration happens in the caller.

## Hazard score — `hazard.ts`

`hazardComponents()` produces seven physically-motivated components, each carrying a `mechanism` string and an `evidence` label:

| Component | Signal | Mechanism (abbreviated) |
|---|---|---|
| `springTideRange` | tidal-range percentile | large range → stronger rip channels / faster ebb |
| `ripBand` | surf height in a 0.7–1.5 m band | Gaussian peak at 1.1 m — rips active but swimmers not deterred |
| `ebbNearLow` | ebbing tide near low water | peak rip-channel drainage velocity |
| `onshoreWind` | onshore component × wind percentile | onshore wind feeds longshore currents / rip feeders |
| `offshoreBlowoff` | offshore wind × warm-calm index | blows inflatables/weak swimmers offshore |
| `coldShock` | cold sea × hot air | cardiac cold-shock on immersion |
| `stormLegacy` | max swell/gust in days −14…−3, "first calm day after a blow" | reworked rip channels persist post-storm |

Design details that matter:

- **Percentiles, not raw values.** Where a climatology table exists (tide range, wind), a component's score is the *climatological percentile* of the raw value for that beach+month — so "high" is relative to local norms.
- **Mechanistic components** (rip band, cold shock, offshore blow-off) are bounded 0–1 functions of raw physics, used where no climatology calibration applies.
- **`hazardIndex()` averages the available components** and returns `null` if fewer than half have data. The single highest-scoring component is exposed as the `driver` for UI explainability ("why is today flagged").
- The `/methodology` page describes an eighth component (`longSwellCalm`); the current `hazard.ts` returns the seven above. The index renormalises over whatever components are present, so the set can evolve without breaking calibration.

## Exposure score — `exposure.ts`

A crowd proxy: how many people are likely in the water, averaged over up to six sub-signals:

- **Temperature percentile** — warm days draw swimmers (`percentileOf(tempMax, climTempMax)`).
- **Calm score** — `max(0, 1 − wind/25)`; low wind → more people.
- **Harmonic seasonality** — a smooth 2-harmonic curve peaking in late July (`t ≈ 6.5`), which supplies the cross-month variation the annual calibration relies on.
- **Weekend** — 0.8 vs 0.4 on weekdays.
- **Irish bank holiday** — 0.9 (computed, including movable May/June/August/October Mondays).
- **School holiday** — 0.85 in July/August.

Exposure is what makes the blend work at all: it encodes the confound (more incidents happen when more people are present) *explicitly*, so it can be weighted rather than leaking into the hazard signal.

## The weight decision: 0.65 / 0.35

`EXPOSURE_WEIGHT = 0.65` is not a guess. `backtest.ts` sweeps the weight across `{0.0, 0.25, 0.50, 0.65, 0.75, 1.0}` and reports out-of-fold lift@25% for each; 0.65 is the value chosen from that sweep, and the sweep line is printed with `← chosen` next to it. The backtest additionally runs a **hazard-only** (weight 0.0) comparison with a noise-floor check to confirm hazard "earns its weight" in the blend rather than just diluting exposure. The heavier exposure weight is consistent with the discrimination null: exposure/seasonality carries more of the ranking signal than any single physical hazard variable does.

## Rank calibration — `calibration.ts`

Raw `combined` scores are not comparable across beaches, so the tier comes from a **rank**, not a threshold on the raw number:

1. `build-climatology.ts` replays `scoreDay()` over all history and stores the annual distribution of combined scores as a 101-point ladder under `(beach_id, month=0, metric='combined_score')`.
2. At serving time, `percentileOf(combined, annualLadder)` maps today's score to its percentile against that beach's own history (binary search + linear interpolation between ladder points).
3. `tierFromPercentile()` applies the thresholds.

`buildLadder()` requires **≥100 samples** or returns `null` — a metric without enough history simply has no ladder, and scoring falls back or reports `unknown` rather than calibrating against noise.

## Tier thresholds

| Tier | Percentile | Meaning |
|---|---|---|
| **Severe** | ≥ 0.95 | worst ~5% of days for this beach |
| **Warning** | ≥ 0.80 | top ~20% |
| **Watch** | ≥ 0.70 | top ~30% |
| **Borderline** | ≥ 0.68 | just below Watch (68th–70th) |
| **Low** | < 0.68 | typical |
| **Unknown** | — | primary data unavailable |

Because the calibration is per-beach and rank-based, "Severe" means the same thing — roughly the worst 5% of days — at sheltered Fountainstown and wild Ballybunion, even though their absolute wave heights differ by metres. `tier-frequency.ts` verifies these realised frequencies hold across 2005–2026.

## Why one function for everything

Forecast (`forecast.ts`), retrospective scoring (`historical-hazard.ts`), the climatology builder, and the backtest all call the same `scoreDay()`. This is a deliberate anti-drift measure: the score a user sees, the score used to build the calibration ladder, and the score used to evaluate the model are guaranteed identical, because there is only one implementation.
