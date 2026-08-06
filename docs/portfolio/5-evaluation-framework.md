# 5 — Evaluation Framework

BeachSafe ships two independent, offline evaluations. Both read the database and reuse the production `scoreDay()`; neither is mocked. The headline finding — an honest null — shaped the entire product framing.

## Evaluation 1 — Case-control discrimination (`scripts/analysis/discrimination.ts`)

**Question:** does any single environmental feature separate incident days from otherwise-comparable non-incident days?

**Design:**
- **Cases:** incident days with `condition_related = true AND activity IN ('swimmer','shore')` — n ≈ 51, pooled across all three beaches because per-beach counts are too small.
- **Controls:** for each case, the *same beach* on the *same ±10-day calendar window* in *every other year 1990–2026*, excluding any date that is itself an incident. This design removes the seasonality and exposure confound: cases and controls share time-of-year, so any difference must be conditions, not "more people swim in August." This yields 5,700+ control days.
- **Metric:** Wilcoxon–Mann–Whitney **AUC** per feature (fraction of case/control pairs where the case ranks higher), with a Wilson 95% confidence interval, and lift expressed relative to the 0.5 base rate.

**What AUC means here:** AUC = 0.5 is chance (the feature is no better than a coin at ordering an incident day above a control day); AUC = 1.0 would be perfect separation. A confidence interval that *spans* 0.5 means we cannot rule out chance.

**Result — a null:** not one feature's 95% CI excludes AUC = 0.5. A power note in the script makes the limit explicit: **at n ≈ 51 cases the minimum detectable AUC is ≈ 0.64** — anything weaker than that is undetectable at this sample size regardless of whether it is real. The `/methodology` page renders this table live from `feature_discrimination` and states the null plainly.

**Why this matters:** it is the reason the product does not claim prediction, the reason a trained classifier was rejected, and the reason similarity matching was demoted to informational. Hazard components are consequently labelled by validation status — `suggestive` (AUC ≥ 0.58 but CI spans 0.5) or `mechanism-only` — rather than presented as calibrated probabilities.

## Evaluation 2 — Out-of-fold backtest (`scripts/analysis/backtest.ts`)

**Question:** given that no single feature discriminates, does the *blended, rank-calibrated* score still rank real incident days above random days better than chance — enough to be a useful triage signal — without overfitting?

**Design:**
- **Year-block cross-validation:** five folds spanning 2005–2026 (`[2005–08], [2009–12], [2013–16], [2017–20], [2021–26]`). Incident capture is measured **out-of-fold** — an incident only counts in the fold whose years it belongs to, scored against that fold's days. Because scoring uses climatology built from all history, the folds guard against reading a metric that was calibrated on the same block being evaluated.
- **Metrics reported per beach:**
  - **AUC** (Mann–Whitney) of incident days vs non-incident days.
  - **Lift at an alert budget** — if you flag the top 10% (or 25%) of days by score, how many more incidents do you catch than flagging 10% (25%) at random? Lift = `(incidents captured / total incidents) / budget fraction`. Lift = 1.0 is random; lift = 2.0 means twice as many incidents caught as chance for the same alert volume.
  - **Weight sweep** — lift@25% for `EXPOSURE_WEIGHT ∈ {0.0, 0.25, 0.50, 0.65, 0.75, 1.0}`, which is how the 0.65 blend weight was chosen (see [7](7-scoring-architecture.md)).
  - **Hazard-only comparison** — lift@25% at weight 0.0 (pure hazard) vs the blend, with a noise-floor check on whether hazard "earns its weight."
  - **Calibration check** — realised tier frequencies vs targets on the full data.

**Results:**
- **AUC 0.645–0.797** across the three beaches. Read carefully: these AUCs are for the *blended combined score* ranking incident vs non-incident days out-of-fold — meaningfully above chance — even though *no individual feature* cleared the discrimination bar. The blend plus exposure/seasonality structure carries the signal, not any one physical variable.
- **39 of 51 scoped incidents rank at Watch or above.** Watch is the top ~30% of days. So roughly three-quarters of real incidents fall in the worst third of days by score — the practical statement of the model's triage value.

**Gate:** the script exits non-zero if out-of-fold lift@25% < 1.5×. This is a hard, machine-checkable acceptance bar, not a narrative claim.

## Evaluation 3 — Tier-frequency replay (`scripts/analysis/tier-frequency.ts`)

Replays every day 2005–2026 through the calibrated tier path and checks realised frequencies against targets (severe [0.5–4%], warning [4–14%], watch [8–24%], low ≥60%), with a pass/fail gate per beach. This validates that "Severe ≈ worst 5%" actually holds after rank calibration, and documents the contrast with a prior buggy fingerprint path that produced ~92% severe.

## Reading the numbers together

The two headline results are not in tension:
- **Discrimination null** → *no single variable predicts incidents*, so don't claim prediction.
- **Backtest AUC 0.645–0.797 / 39-of-51 at Watch+** → *the blended anomaly score is still a real, better-than-chance triage signal*, so a tiered "how unusual is today" product is defensible.

That honest gap between "cannot predict" and "can usefully triage" is stated to the user on the methodology page rather than hidden.
