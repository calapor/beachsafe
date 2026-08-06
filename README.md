<p align="center">
  <img src="public/banner.svg" alt="BeachSafe Ireland — Coastal condition-matching &amp; incident alerting for Irish beaches" width="100%" />
</p>

[![CI](https://github.com/calapor/beachsafe/actions/workflows/ci.yml/badge.svg)](https://github.com/calapor/beachsafe/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/github/checks-status/calapor/beachsafe/main?check=Vitest&label=tests&logo=vitest)](https://github.com/calapor/beachsafe/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

# BeachSafe Ireland

Coastal risk alerting for three Irish beaches — **Fountainstown** (Cork), **Ballybunion** (Kerry), and **Skerries** (Dublin). BeachSafe scores each day against a rank-calibrated hazard + beach-exposure model and surfaces a tiered alert level, then lets you inspect how any historical incident day compared to the beach's own climatological norms.

> **Pattern match, not a forecast.** Alert levels reflect how unusual a day's conditions are relative to the beach's own history — not incident probability. Always follow lifeguard and coast guard advice.

> ### 📚 [Portfolio Documentation →](docs/portfolio/README.md)
> Engineering documentation written for technical interviews and portfolio review: product brief, system architecture, data model, prompt-engineering lifecycle, evaluation framework, and a decision log.

## Features

- **Rank-calibrated tiered alerts** — daily Severe / Warning / Watch / Borderline / Low levels, calibrated against each beach's own per-month climatology so a tier means the same thing year-round.
- **Unified scoring path** — `scoreDay()` blends a climatological hazard index with a beach-crowding exposure proxy; the same function drives live forecasts, the historical backtest, and retrospective incident pages.
- **5-day live forecast** — Met Éireann forecast wind, Open-Meteo marine waves, Marine Institute tide predictions, and SunCalc moon/daylight combined into scored forecast days with daylight ebb-window flags.
- **Retrospective incident explorer** — every curated/RNLI incident is scored against the conditions on its own day, with a 7-day-prior conditions panel and hour-of-day condition detail where a time is known.
- **Claude-based incident enrichment** — Claude Haiku classifies incident descriptions into activity, condition-relatedness, and an exclusion cause, with a hallucination guard on extracted times.
- **Honest evaluation** — a case-control discrimination analysis and an out-of-fold cross-validation harness (with a lift gate) ship in-repo; the app's methodology page reports the null result transparently.
- **Explainable hazard components** — each hazard signal carries a physical mechanism string and a validation label (validated / suggestive / mechanism-only).

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router), React 19 |
| Styling | Tailwind CSS v4 |
| Database | Neon Postgres (serverless) via `@neondatabase/serverless` |
| LLM | Anthropic Claude (`claude-haiku-4-5`) via `@anthropic-ai/sdk` — ETL enrichment only |
| Charts | Recharts |
| Astronomy | SunCalc (moon phase, illumination, daylight) |
| Parsing | fast-xml-parser (Met Éireann forecast XML), Zod |
| ETL / scripts | tsx (TypeScript execution) |
| Tests | Vitest (pure-function unit tests) |
| Deploy | Vercel / Docker (standalone) / Helm + Jenkins |

## Environment Variables

| Variable | Required | Used by | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | app + all ETL/analysis scripts | Neon Postgres connection string |
| `ANTHROPIC_API_KEY` | ETL enrichment only | `scripts/etl/enrich-incidents.ts` | Anthropic API key for the incident classifier |
| `APP_VERSION` | No | root layout badge | Injected at build time as `<short-sha> (#<build-number>)`; shows `dev` when unset |

## Getting Started

```bash
pnpm install

# Set up env
cp .env.local.example .env.local  # fill in DATABASE_URL (and ANTHROPIC_API_KEY for enrichment)

# Apply schema + seed beach rows
pnpm migrate

# Ingest all data (weather → waves → tides → RNLI → astro → incidents → enrich → fingerprints → climatology)
pnpm etl

# Run tests
pnpm test

# Start dev server
pnpm dev
```

The wave ingest depends on offshore probe points. On a fresh database, run `pnpm etl:probe-waves` once before the first `pnpm etl` so `beaches.wave_lat/wave_lon` are populated.

## Architecture

BeachSafe is split into an **offline ETL/analysis pipeline** (TypeScript scripts run with `tsx`) and a **request-time serving path** (the Next.js app). Both share the pure scoring code in `src/lib/`, so the tier a user sees in the forecast is produced by the exact `scoreDay()` function that the backtest and climatology builder use.

See [`docs/diagrams/architecture.puml`](docs/diagrams/architecture.puml) for the full component diagram.

**Data pipeline flow:**

1. **Ingest** — historical daily weather (Open-Meteo ERA5 archive), waves/swell/SST (Open-Meteo marine archive at beach-specific offshore points, with Marine Institute buoy SST fallback), tidal range and HW/LW times (Marine Institute ERDDAP gauge network), and RNLI launches (ArcGIS Return of Service). SunCalc computes moon phase and a spring/neap tide-range proxy for the pre-gauge era.
2. **Enrich** — curated incident JSON is seeded; RNLI records are keyword-classified for obvious exclusions; anything ambiguous is sent to Claude Haiku for structured classification (activity, `condition_related`, `exclusion_cause`, evidence).
3. **Fingerprint** — each in-scope incident gets a feature vector over its 7-day-prior + day-of observation window.
4. **Calibrate** — `build-climatology.ts` computes per-beach, per-month percentile ladders for every raw metric, then a second pass builds annual (`month=0`) ladders for the combined / hazard / exposure scores by replaying `scoreDay()` over all history.
5. **Serve** — the dashboard, beach, incident, and `/api/alerts` routes read observations and climatology from Neon, fetch live forecast inputs, call `scoreDay()`, and rank-calibrate the combined score against the annual ladder to produce a tier.

## ETL Scripts

| Script | Description |
|---|---|
| `scripts/migrate.ts` | Apply schema + seed beach rows |
| `scripts/etl/probe-wave-points.ts` | Walk seaward to find the nearest Open-Meteo marine grid point with wave data; store `wave_lat/wave_lon` |
| `scripts/etl/ingest-weather.ts` | Open-Meteo ERA5 daily weather per beach (incremental) |
| `scripts/etl/ingest-waves.ts` | Open-Meteo marine archive waves/swell/SST (+ Marine Institute buoy SST fallback) |
| `scripts/etl/ingest-tides.ts` | Marine Institute ERDDAP gauge network — tidal range + HW/LW extrema |
| `scripts/etl/compute-astro.ts` | SunCalc moon phase / illumination + spring-neap tide-range proxy |
| `scripts/etl/ingest-rnli.ts` | RNLI Return of Service (ArcGIS) within 15 km of each beach |
| `scripts/etl/seed-incidents.ts` | Load curated `data/incidents.*.json` |
| `scripts/etl/enrich-incidents.ts` | Claude extraction: time of day, activity, condition_related, exclusion cause |
| `scripts/etl/build-fingerprints.ts` | Compute feature vectors for all in-scope incidents |
| `scripts/etl/build-climatology.ts` | Per-month + annual percentile ladders for all score metrics |
| `scripts/etl/run-all.ts` | Orchestrates all of the above (`pnpm etl`) |
| `scripts/analysis/backtest.ts` | Out-of-fold cross-validation, weight sweep, lift gate |
| `scripts/analysis/discrimination.ts` | Case-control per-feature AUC with confidence intervals |
| `scripts/analysis/tier-frequency.ts` | Replay tier frequencies vs calibration targets |

## Scoring Model

`src/lib/risk.ts` — `scoreDay()` is the unified scoring entry point used by the forecast, backtest, and retrospective incident pages:

1. **Hazard score** — mean of the available climatological/mechanistic component scores (spring tide range, rip band, ebb-near-low, onshore wind, offshore blow-off, cold shock, storm legacy) per beach + month. Returns `null` (never 0) when fewer than half the components have data.
2. **Exposure score** — beach-crowd proxy from temperature percentile, calm-wind score, harmonic seasonality (peaking late July), weekend, Irish bank holiday, and school holiday.
3. **Combined score** — `0.65 × exposure + 0.35 × hazard` (weight chosen by out-of-fold lift sweep in `backtest.ts`).
4. **Tier** — rank-calibrated against all days at the beach (annual ladder, `month=0`):
   - **Severe** ≥ 95th percentile (top 5%)
   - **Warning** ≥ 80th percentile (top 20%)
   - **Watch** ≥ 70th percentile (top 30%)
   - **Borderline** 68th–70th percentile
   - **Low** below 68th percentile

Backtest (5-year blocks, out-of-fold): AUC 0.645–0.797 across three beaches; 39/51 scoped incidents rank at Watch or above. Run `npx tsx --env-file .env.local scripts/analysis/backtest.ts` to verify.

## Pages / Routes

| Route | Description |
|---|---|
| `/` | Dashboard: 3 beach cards with live alert levels |
| `/beach/[slug]` | Incident timeline with retrospective tiers, 5-day forecast strip, conditions chart |
| `/beach/[slug]/incident/[id]` | Day-of conditions, 7-day-prior panel, retrospective prediction, similar incidents |
| `/methodology` | Data provenance, coverage gaps, discrimination result, scoring algorithm |
| `/api/alerts?beach=<slug>` | JSON: scored forecast days (hazard, exposure, combined, tier, components) |
| `/api/health` | Health check |

## Project Structure

```
beachsafe/
├── data/                       # Curated incident JSON per beach (seed input)
│   └── incidents.{fountainstown,ballybunion,skerries}.json
├── docs/
│   ├── diagrams/architecture.puml   # PlantUML system diagram
│   └── portfolio/              # Engineering portfolio documentation (0–9)
├── scripts/
│   ├── migrate.ts              # Schema + beach seed
│   ├── etl/                    # Ingest → enrich → fingerprint → climatology
│   └── analysis/               # Backtest, discrimination, tier-frequency
├── src/
│   ├── app/                    # Next.js App Router (pages + API routes)
│   ├── components/             # UI: alert badge, conditions charts, evidence panels, wizard
│   ├── db/
│   │   ├── schema.sql          # Postgres DDL
│   │   └── queries.ts          # Typed query helpers
│   └── lib/                    # Pure scoring core (+ *.test.ts)
│       ├── risk.ts             # scoreDay() — hazard + exposure blend
│       ├── hazard.ts           # climatological hazard components
│       ├── exposure.ts         # crowd/exposure proxy
│       ├── calibration.ts      # percentile ladders + tier thresholds
│       ├── similarity.ts       # feature fingerprints + Gaussian match
│       ├── forecast.ts         # live 5-day forecast assembly
│       ├── historical-hazard.ts# retrospective incident scoring
│       ├── incident-conditions.ts # hourly day-of conditions
│       └── extract-time.ts     # time parsing + hallucination guard
├── deploy/helm/beachsafe/      # Helm chart
├── Dockerfile                  # Standalone Next.js image
└── Jenkinsfile                 # CI/CD for Kubernetes
```

## Deployment

### Vercel (recommended)

Set `DATABASE_URL` in Vercel environment variables. `APP_VERSION` is injected at build time by the deploy script as `<short-sha> (#<build-number>)`.

### Docker / self-hosted

```bash
docker build -t beachsafe .
docker run -e DATABASE_URL=... -e ANTHROPIC_API_KEY=... -p 3000:3000 beachsafe
```

### Kubernetes / Helm

A Helm chart is provided under `deploy/helm/beachsafe/`. Customise `values.yaml` (image registry, nodePort) before deploying:

```bash
helm upgrade --install beachsafe deploy/helm/beachsafe \
  --namespace beachsafe --create-namespace \
  --set image.registry=your.registry.example.com:5000 \
  --set secrets.databaseUrl="$DATABASE_URL" \
  --set secrets.anthropicApiKey="$ANTHROPIC_API_KEY"
```

A `Jenkinsfile` is included for teams running Jenkins on Kubernetes. Before using it, configure the following in **Manage Jenkins → Configure System → Global properties → Environment variables**:
- `REGISTRY` — your container registry host (e.g. `192.168.1.101:5000` or `ghcr.io/your-org`)

And add two credentials in **Manage Jenkins → Credentials**:
- `flags-database-url` — Neon Postgres connection string
- `anthropic-api-key` — Anthropic API key (used by the ETL enrichment pass only)

## Data Sources

- **Historical weather** — Open-Meteo ERA5 reanalysis archive (`archive-api.open-meteo.com`), daily from 1950
- **Waves, swell, sea temperature** — Open-Meteo marine archive (beach-specific offshore point) + Marine Institute ERDDAP `IWBNetwork` buoys (M2/M3) for SST fallback
- **Tidal range & HW/LW times** — Marine Institute ERDDAP `IrishNationalTideGaugeNetwork` (2006–present); moon-phase spring/neap proxy before 2006
- **Tide predictions (forecast)** — Marine Institute ERDDAP `IMI_TidePrediction_HighLow`
- **Incidents** — RNLI Open Data Return of Service (ArcGIS) + curated news/inquest records
- **Forecast wind** — Met Éireann `locationforecast` XML feed
- **Moon phase / illumination / daylight** — SunCalc (computed, no external API)

## Methodology

See `/methodology` in the running app, or `src/app/methodology/page.tsx`, for detailed notes on coverage gaps, feature validation (ROC AUC, lift), and the deliberate null result for the discrimination analysis.

## License

MIT © 2025 Richard O'Connor
