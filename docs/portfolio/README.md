# BeachSafe — Portfolio Documentation

> Engineering documentation for this project.

BeachSafe is a coastal risk-alerting application for three Irish beaches (Fountainstown, Ballybunion, Skerries). It ingests decades of open environmental data and a curated record of coastal incidents, scores each day against a rank-calibrated hazard + exposure model, and presents tiered alerts plus a retrospective incident explorer. These documents explain how it was designed, built, evaluated, and where its limits lie.

## Documents

| # | Document | Description |
|---|----------|-------------|
| 0 | [Product Design Brief](0-product-design-brief.md) | The problem, why these three beaches, what the system does and deliberately does not do |
| 1 | [Pre-Development Phase](1-pre-development-phase.md) | Decisions made before the first commit: data sources, scoring approach, alternatives rejected |
| 2 | [System Architecture](2-system-architecture.md) | ETL → DB → API → UI pipeline, component responsibilities, the shared scoring core |
| 3 | [Data Model Reference](3-data-model-reference.md) | Postgres schema, TypeScript types, key data structures |
| 4 | [Prompt Engineering Lifecycle](4-prompt-engineering-lifecycle.md) | How Claude enriches incidents: the prompt, the extraction contract, guards |
| 5 | [Evaluation Framework](5-evaluation-framework.md) | Backtest methodology, AUC numbers, the 39/51 result, calibration targets |
| 6 | [AI Safety & Considerations](6-ai-safety-and-considerations.md) | Output validation, enrichment failure handling, fail-open behaviour |
| 7 | [Scoring Architecture](7-scoring-architecture.md) | Deep dive on `risk.ts`: hazard vs exposure, the 0.65/0.35 weight, tier thresholds |
| 8 | [Observability & Data Coverage](8-observability-and-data-coverage.md) | Coverage gaps, per-metric windows, what "decades of data" means in practice |
| 9 | [Engineering Decision Log](9-engineering-decision-log.md) | Key decisions with alternatives considered and rationale |

## Reading paths

**Quick overview (5 min):** [0 — Product Design Brief](0-product-design-brief.md)

**Product and delivery focus (15 min):** [0 — Product Brief](0-product-design-brief.md) → [2 — System Architecture](2-system-architecture.md) → [9 — Decision Log](9-engineering-decision-log.md)

**Full technical depth (30 min):** [2 — Architecture](2-system-architecture.md) → [3 — Data Model](3-data-model-reference.md) → [7 — Scoring Architecture](7-scoring-architecture.md) → [5 — Evaluation Framework](5-evaluation-framework.md)

**AI engineering focus (30 min):** [4 — Prompt Engineering Lifecycle](4-prompt-engineering-lifecycle.md) → [6 — AI Safety & Considerations](6-ai-safety-and-considerations.md) → [5 — Evaluation Framework](5-evaluation-framework.md) → [8 — Observability & Data Coverage](8-observability-and-data-coverage.md)
