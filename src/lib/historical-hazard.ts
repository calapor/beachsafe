import { getObservationWindow, getClimatology, getAnnualClimatology } from "@/db/queries";
import { BEACH_BEARING, type ObsRow } from "./similarity";
import { buildClimMap, percentileOf, tierFromPercentile, type Tier, type PercentileTable } from "./calibration";
import { scoreDay, type DayCalendar } from "./risk";
import type { Coverage, Component, ObsRowExtended } from "./hazard";

export interface HistoricalHazardResult {
  tier: Tier;
  percentile: number | null;     // calibrated annual rank (0–1), drives the tier
  hazardScore: number | null;
  exposureScore: number | null;
  combinedScore: number | null;
  coverage: Coverage;
  components: Component[];
  waveDataAvailable: boolean;
  coverageStart: string | null;  // from annual ladder, for UI copy
}

// Neon's tagged template treats a "YYYY-MM-DD" string as timestamptz midnight UTC;
// the session timezone then shifts the effective date back by one day in non-UTC envs.
// Passing endDate+1 compensates so the incident date appears as the last row.
function nextDay(dateStr: string): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

const ds = (d: unknown): string =>
  d instanceof Date ? (d as Date).toISOString().slice(0, 10) : String(d).slice(0, 10);

type AnnualClim = Record<string, PercentileTable>;

export async function getHistoricalHazard(
  beach: { id: number; slug: string },
  incidentDate: string,
  climCache?: Map<number, Record<string, PercentileTable>>,
  annualClimArg?: AnnualClim | null,
): Promise<HistoricalHazardResult | null> {
  const window = await getObservationWindow(beach.id, nextDay(incidentDate), 8) as ObsRowExtended[];

  const targetRow = window.find((r) => ds(r.date) === incidentDate);
  if (!targetRow) return null;

  const coverage: Coverage = {
    weather: targetRow.mean_wind_knots != null,
    waves:   targetRow.wave_height_m   != null,
    tide:    targetRow.tide_range_m    != null,
    swell:   targetRow.swell_period_s  != null,
  };

  const month = parseInt(incidentDate.slice(5, 7), 10);
  let clim: Record<string, PercentileTable>;
  if (climCache?.has(month)) {
    clim = climCache.get(month)!;
  } else {
    const climRows = await getClimatology(beach.id, month) as Array<{
      metric: string; n: number; coverage_start: unknown; coverage_end: unknown; ladder: unknown;
    }>;
    clim = buildClimMap(climRows, month);
    climCache?.set(month, clim);
  }

  // Annual climatology (month=0 rows: combined_score, hazard_score, exposure_score).
  // Caller may supply it from a shared fetch; otherwise fetch here.
  let annualClim: AnnualClim;
  if (annualClimArg != null) {
    annualClim = annualClimArg;
  } else {
    const annualRows = await getAnnualClimatology(beach.id) as Array<{
      metric: string; n: number; coverage_start: unknown; coverage_end: unknown; ladder: unknown;
    }>;
    annualClim = buildClimMap(annualRows, 0);
  }

  const bearing = BEACH_BEARING[beach.slug] ?? 270;
  const year = parseInt(incidentDate.slice(0, 4), 10);
  const day  = parseInt(incidentDate.slice(8, 10), 10);
  const calendar: DayCalendar = {
    year,
    month,
    day,
    dayOfWeek: new Date(incidentDate).getUTCDay(),
  };

  const dayScore = scoreDay(window, bearing, clim, coverage, calendar);

  const annualTable = annualClim["combined_score"] ?? null;
  const percentile = percentileOf(dayScore.combined, annualTable);
  const coverageStart = annualTable?.coverageStart ?? null;

  const tier: Tier = (!coverage.weather && !coverage.waves)
    ? "unknown"
    : tierFromPercentile(percentile);

  return {
    tier,
    percentile,
    hazardScore:   dayScore.hazard.score,
    exposureScore: dayScore.exposure.score,
    combinedScore: dayScore.combined,
    coverage,
    components: dayScore.hazard.components,
    waveDataAvailable: coverage.waves,
    coverageStart,
  };
}
