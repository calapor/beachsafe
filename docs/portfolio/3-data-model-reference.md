# 3 — Data Model Reference

Source of truth: `src/db/schema.sql` plus idempotent migrations in `scripts/migrate.ts`. Types: `src/lib/*.ts`.

## Postgres schema

### `beaches`

One row per beach. Seeded by `migrate.ts`.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `slug` | TEXT UNIQUE | `fountainstown` \| `ballybunion` \| `skerries` |
| `name`, `county` | TEXT | Display |
| `lat`, `lon` | DOUBLE PRECISION | Beach location |
| `met_station_no`, `wave_buoy_id`, `tide_station_id` | TEXT | Source station references |
| `wave_lat`, `wave_lon` | DOUBLE PRECISION | Offshore wave grid point (set by `probe-wave-points.ts`) |
| `notes` | TEXT | |

### `observations`

One row per beach per day — the environmental backbone. `UNIQUE(beach_id, date)`, indexed on `(beach_id, date)`.

- **Weather (Met/ERA5):** `rain_mm`, `temp_max_c`, `temp_min_c`, `mean_wind_knots`, `max_gust_knots`, `wind_dir_deg`, `mslp_hpa`
- **Waves (marine, nullable pre-2000):** `wave_height_m`, `wave_period_s`, `sea_temp_c`, `swell_height_m`, `swell_period_s`, `wind_wave_height_m`
- **Astronomical / tidal (computed or gauge):** `moon_phase`, `moon_illum`, `tide_range_m`, `high_tide_times`, `low_tide_times` (comma-joined `HH:MM` strings)
- **`source_flags` JSONB** — provenance per layer, e.g. `{"weather":"era5_openmeteo","tide":"gauge","moon":"computed"}`. Merged with `||` on upsert so each ingest annotates only its own layer.

### `incidents`

Curated + RNLI coastal events. `UNIQUE(beach_id, date, title)`, plus a unique index on `external_id`.

| Column | Type | Notes |
|---|---|---|
| `type` | TEXT CHECK | `rnli_launch` \| `drowning` \| `rescue` \| `near_miss` |
| `severity`, `casualties` | INTEGER | |
| `title`, `description`, `source_url`, `source_type`, `external_id` | TEXT | RNLI `ROSNumber` is the external id |
| `time_of_day` | TIME | Almost always NULL (see coverage doc) |
| `time_source` | TEXT CHECK | `rnli` \| `reported` \| `unknown` |
| `activity` | TEXT CHECK | `swimmer` \| `watercraft` \| `shore` \| `other` \| `unknown` |
| `activity_source`, `activity_evidence` | TEXT | Evidence quote persisted for audit |
| `condition_related` | BOOLEAN | NULL = not yet classified; drives scope |
| `exclusion_cause` | TEXT | `man_overboard` \| `medical` \| `mechanical` \| `false_alarm` \| NULL |

**Scope rule** (enforced in `db/queries.ts` and analysis SQL): the in-scope set is `condition_related IS NOT FALSE AND activity IN ('swimmer','shore')`. `IS NOT FALSE` deliberately keeps `NULL` (unclassified) rows in scope conservatively.

### `incident_fingerprints`

`incident_id` PK → `incidents`. `features JSONB` holds a serialised `FeatureVector`; `computed_at` timestamp.

### `climatology`

Percentile ladders, keyed `(beach_id, month, metric)`.

| Column | Notes |
|---|---|
| `month` | 1–12 for per-month raw-metric ladders; **`0` for annual score ladders** |
| `metric` | raw metric name (e.g. `wave_height_m`) or `combined_score` / `hazard_score` / `exposure_score` |
| `n` | sample count (ladders require ≥100 samples) |
| `coverage_start`, `coverage_end` | DATE window the ladder covers |
| `ladder` | JSONB — 101 ascending values, index *i* = *i*-th percentile |

### `feature_discrimination`

Case-control AUC results written by `discrimination.ts`, keyed `(feature, scope)`: `n_case`, `n_control`, `auc`, `auc_lo`, `auc_hi`, `lift`, `lift_lo`, `lift_hi`.

## Key TypeScript structures

### `FeatureVector` (`similarity.ts`)

15 normalised (roughly 0–1) features used for fingerprints and similarity:

`meanWind`, `maxGust`, `maxWave`, `totalRain`, `pressureDrop`, `moonIllum` (folded so both new and full moon → high tidal force), `tideRange`, `onshoreComponent` (clamped ≥0), `onshoreSigned` (raw cosine, negative = offshore), `tideState` (−1 ebb … +1 flood), `hoursFromHigh`, `tideConfidence` (0 / 0.5 / 1), `seaTempCold`, `wavePeriod`, `warmCalm`.

### `PercentileTable` (`calibration.ts`)

`{ metric, month, n, coverageStart, coverageEnd, ladder: number[101] }`. `percentileOf(value, table)` binary-searches the ladder and interpolates, returning `null` (never 0) for missing value or table.

### `Component` / `HazardResult` (`hazard.ts`)

Each hazard component: `{ key, raw, percentile, score, evidence, mechanism, inputs }` where `evidence ∈ validated | suggestive | unvalidated | insufficient-data`. `HazardResult` aggregates `{ score, percentile, driver, missing, components }`.

### `DayScore` (`risk.ts`)

`{ hazard: HazardResult, exposure: ExposureResult, combined: number|null, features: FeatureVector }`.

### `Tier` (`calibration.ts`)

`low | borderline | watch | warning | severe | unknown`.

### `ForecastDay` (`forecast.ts`)

The rich per-day serving object: raw conditions, `tier`, legacy `alertLevel`, hazard/exposure/combined scores, `hazardComponents`, `coverage`, `tideEvents`, `ebbWindows`, `daylightLocal`, `topMatches` (informational similarity), and `features`.
