# BeachSafe Ireland 🌊

[![CI](https://github.com/calapor/beachsafe/actions/workflows/ci.yml/badge.svg)](https://github.com/calapor/beachsafe/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/github/checks-status/calapor/beachsafe/main?check=Vitest&label=tests&logo=vitest)](https://github.com/calapor/beachsafe/actions/workflows/ci.yml)

Coastal risk alerting for three Irish beaches — **Fountainstown** (Cork), **Ballybunion** (Kerry), and **Skerries** (Dublin).

BeachSafe ingests 75+ years of open environmental data (Met Éireann weather reanalysis, Marine Institute wave buoys, astronomical tide, moon phase) alongside a curated record of past dangerous events (RNLI launches, drownings, rescues). It scores each day against a rank-calibrated combined hazard + beach-exposure model, surfaces a tiered alert level, and lets you explore how any incident day compared to historical norms.

> **Pattern match, not a forecast.** Alert levels reflect how unusual a day's conditions are relative to the beach's own history. Always follow lifeguard and coast guard advice.

## Stack

- **Next.js** (App Router) + **Tailwind CSS v4**
- **Neon Postgres** (serverless) via `@neondatabase/serverless`
- **Recharts** for condition charts
- **SunCalc** for moon phase / illumination
- **fast-xml-parser** for Met Éireann forecast XML
- **Vitest** for pure-function unit tests

## Getting started

```bash
pnpm install

# Set up env
cp .env.local.example .env.local  # fill in DATABASE_URL

# Apply schema + seed beach rows
pnpm migrate

# Ingest all data (weather → waves → astro → incidents → fingerprints → climatology)
pnpm etl

# Run tests
pnpm test

# Start dev server
pnpm dev
```

## ETL scripts

| Script | Description |
|---|---|
| `scripts/migrate.ts` | Apply schema + seed beach rows |
| `scripts/etl/ingest-weather.ts` | Met Éireann daily CSV per station |
| `scripts/etl/ingest-waves.ts` | Marine Institute ERDDAP buoy data |
| `scripts/etl/compute-astro.ts` | SunCalc moon phase / tide range estimation |
| `scripts/etl/seed-incidents.ts` | Load curated `data/incidents.*.json` |
| `scripts/etl/enrich-incidents.ts` | Claude extraction: time of day, activity, condition_related |
| `scripts/etl/build-fingerprints.ts` | Compute feature vectors for all incidents |
| `scripts/etl/build-climatology.ts` | Per-month + annual percentile ladders for all score metrics |
| `scripts/etl/run-all.ts` | Orchestrates all of the above (`pnpm etl`) |

## Scoring model

`src/lib/risk.ts` — `scoreDay()` is the unified scoring entry point used by the forecast, backtest, and retrospective incident pages:

1. **Hazard score** — climatological percentile of 7 component signals (wave height, tide range, onshore wind, gust, swell, pressure trend, sea temp) per beach + month.
2. **Exposure score** — beach-crowd proxy: temp, wind, month, weekday/weekend, bank holiday.
3. **Combined score** — `0.65 × exposure + 0.35 × hazard` (weight chosen by out-of-fold lift sweep).
4. **Tier** — rank-calibrated against all days at the beach (annual ladder, `month=0`):
   - **Severe** ≥ 98th percentile
   - **Warning** ≥ 90th percentile
   - **Watch** ≥ 75th percentile
   - **Low** below that

Backtest (5-year blocks, out-of-fold): AUC 0.645–0.797 across three beaches; 39/51 scoped incidents rank at Watch or above. Run `npx tsx --env-file .env.local scripts/analysis/backtest.ts` to verify.

## Pages

| Route | Description |
|---|---|
| `/` | Dashboard: 3 beach cards with live alert levels |
| `/beach/[slug]` | Incident timeline with retrospective tiers, 5-day forecast strip, conditions chart |
| `/beach/[slug]/incident/[id]` | Day-of conditions, 7-day-prior panel, retrospective prediction, similar incidents |
| `/methodology` | Data provenance, coverage gaps, scoring algorithm |
| `/api/alerts?beach=<slug>` | JSON: scored forecast days (hazard, exposure, combined, tier, components) |

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
- `BEACHSAFE_REGISTRY` — your container registry host (e.g. `192.168.1.101:5000` or `ghcr.io/your-org`)

And add two credentials in **Manage Jenkins → Credentials**:
- `database-url` — Neon Postgres connection string
- `anthropic-api-key` — Anthropic API key (used by the ETL enrichment pass only)

## Data sources

- **Met Éireann** daily CSV: `cli.fusio.net/cli/climate_data/webdata/dly<STATION>.csv`
- **Marine Institute** ERDDAP: `erddap.marine.ie/erddap/tabledap/IWaveBNetwork`
- **RNLI Open Data**: `data-rnli.opendata.arcgis.com`
- **Moon phase / tide range**: SunCalc (computed, no external API)
- **Forecast**: Met Éireann XML feed + Open-Meteo marine

## Methodology

See `/methodology` in the running app, or `src/app/methodology/page.tsx`, for detailed notes on coverage gaps, feature validation (ROC AUC, lift), and the deliberate null result for the similarity-matching approach.
