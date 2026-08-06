# 0 — Product Design Brief

## Problem statement

Ireland records coastal drownings and rescues every year, and the conditions behind them — rip currents, spring-tide ebbs, offshore winds carrying inflatables out, cold-water shock on hot days — are physically well understood but are not surfaced to the public in any beach-specific, day-by-day way. Official forecasts describe wind and waves in absolute terms; they do not tell a swimmer at *this* beach whether *today* is unusual for *this* time of year.

BeachSafe addresses a narrow slice of that gap: given a beach and a day, express **how anomalous the conditions are relative to that beach's own history**, and let a user explore how past incident days scored under the same lens.

## Why these three beaches

The system covers exactly three beaches, chosen to span the range of Irish coastal exposure while keeping the data-engineering surface tractable:

- **Fountainstown (Cork)** — a sheltered, SE-facing cove near Crosshaven. Seaward bearing 135°. Family beach, lower baseline exposure.
- **Ballybunion (Kerry)** — an exposed, W-facing Atlantic beach. Seaward bearing 270°. Heavy swell, strong rips, large tidal range (~4.5–5 m spring).
- **Skerries (Dublin)** — a tidal, E-facing Irish Sea beach north of Dublin. Seaward bearing 90°. Sensitive to NE swell and tidal eddies.

Three beaches on three different coasts means each has a distinct wind/swell geometry (encoded as a per-beach seaward bearing), a distinct tide gauge, and a distinct offshore wave grid point. That variety exercises the whole pipeline without requiring national-scale ingestion. The set is defined in `scripts/migrate.ts` (seed rows) and `src/lib/similarity.ts` (`BEACH_BEARING`).

## What the system does

- Ingests decades of daily environmental observations per beach (weather, waves, swell, sea temperature, tidal range, HW/LW times, moon phase).
- Curates a record of past coastal incidents (RNLI launches plus hand-curated news/inquest events) and classifies each one for activity type and condition-relatedness.
- Scores each day with a unified `scoreDay()` that blends a **hazard** index (climatological anomaly of physical signals) with an **exposure** proxy (how many people are likely in the water).
- Rank-calibrates the blended score against the beach's own annual distribution to produce a tier: Severe / Warning / Watch / Borderline / Low.
- Presents live 5-day forecasts, a per-beach incident timeline with retrospective tiers, and a per-incident detail page with day-of and 7-day-prior conditions.
- Publishes its own honest evaluation: a case-control discrimination analysis and an out-of-fold backtest, both surfaced on the `/methodology` page.

## What it deliberately does not do

- **It does not predict incidents.** The product framing, the dashboard disclaimer, and the methodology page all state that tiers express *climatological anomaly*, not incident probability. This is a factual constraint, not marketing caution: at n≈51 in-scope incidents, no single environmental feature has been shown to discriminate incident days from matched controls (see [5 — Evaluation Framework](5-evaluation-framework.md)).
- **It does not train a machine-learning model.** The incident set is far too small. The scoring is a transparent, hand-specified blend of percentile lookups, not a fitted classifier.
- **It does not model nearshore physics.** Wave data comes from offshore grid points; refraction, shoaling, and rip-channel bathymetry are out of scope.
- **It does not do hourly/tide-phase risk.** Incident times are almost entirely unavailable (0 of 51 in-scope incidents have a recorded clock time), so the natural timescale of rip-current drowning cannot be analysed.
- **It is not a replacement for lifeguards.** Every surface repeats: follow lifeguard and coast guard advice.

## Users and framing

The intended user is a beachgoer or a curious technically-literate visitor. The framing throughout is "pattern match, not a prediction." The welcome wizard, dashboard banner, and methodology page are all written to prevent the tool being read as an authoritative safety oracle — an explicit product-design choice given the honest null result at the core of the evaluation.
