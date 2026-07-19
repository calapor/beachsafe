# BeachSafe Ireland 🌊

[![CI](https://github.com/calapor/beachsafe/actions/workflows/ci.yml/badge.svg)](https://github.com/calapor/beachsafe/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/github/checks-status/calapor/beachsafe/main?check=Vitest&label=tests&logo=vitest)](https://github.com/calapor/beachsafe/actions/workflows/ci.yml)

Coastal incident condition-matching & alerting for three Irish beaches —
**Fountainstown** (Cork), **Ballybunion** (Kerry), and **Skerries** (Dublin).

BeachSafe ingests decades of open environmental data (Met Éireann weather, Marine Institute wave buoys, moon phase) plus a curated record of past dangerous events (RNLI launches, drownings, rescues). When today's forecast conditions resemble those of past incidents — by onshore wind, wave height, spring tide, and pressure trend — it raises a tiered alert.

> **Pattern match, not a prediction.** Alert levels reflect historical similarity only. Always follow lifeguard and coast guard advice.

## Stack

- **Next.js 16** (App Router) + **Tailwind CSS v4**
- **Neon Postgres** via `@neondatabase/serverless`
- **Recharts** for condition charts
- **SunCalc** for moon phase / illumination
- **fast-xml-parser** for Met Éireann forecast XML
- **Vitest** for pure-function unit tests

## Getting started

```bash
pnpm install

# Set up env
cp .env.local.example .env.local  # add DATABASE_URL

# Run migrations + seed beaches
pnpm migrate

# Ingest all data (weather → waves → astro → incidents → fingerprints)
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
| `scripts/etl/build-fingerprints.ts` | Compute feature vectors for all incidents |
| `scripts/etl/run-all.ts` | Orchestrates all of the above (`pnpm etl`) |

## Similarity engine

`src/lib/similarity.ts` — pure functions, fully unit-tested, no I/O:

- `fingerprint(observationWindow, beachBearing)` → normalised feature vector
- `score(candidate, reference)` → 0–1 via weighted Gaussian kernel
- `matchAll(candidate, fingerprints)` → ranked matches
- `alertLevel(score)` → `none | watch | warning | severe`

## Pages

| Route | Description |
|---|---|
| `/` | Dashboard: 3 beach cards with live alert levels |
| `/beach/[slug]` | Incident timeline, 5-day forecast strip, conditions chart |
| `/beach/[slug]/incident/[id]` | Day-of conditions + 7-day-prior panel + similar incidents |
| `/methodology` | Data provenance, coverage gaps, similarity algorithm |
| `/api/alerts?beach=<slug>` | JSON: scored forecast days + nearest incident matches |

## Deployment

Set `DATABASE_URL` in Vercel environment variables. `APP_VERSION` is injected at build time by the deploy script (`<short-sha> (#<build-number>)`).

## Data sources

- **Met Éireann** daily CSV: `cli.fusio.net/cli/climate_data/webdata/dly<STATION>.csv`
- **Marine Institute** ERDDAP: `erddap.marine.ie/erddap/tabledap/IWaveBNetwork`
- **RNLI Open Data**: `data-rnli.opendata.arcgis.com`
- **Moon phase**: SunCalc (computed, no external API)
