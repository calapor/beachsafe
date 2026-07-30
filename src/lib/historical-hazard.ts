import { getObservationWindow, getClimatology } from "@/db/queries";
import { fingerprint, BEACH_BEARING, type ObsRow } from "./similarity";
import { buildClimMap, tierFromPercentile, type Tier, type PercentileTable } from "./calibration";
import { hazardComponents, hazardIndex, type Coverage, type Component, type ObsRowExtended } from "./hazard";

export interface HistoricalHazardResult {
  tier: Tier;
  score: number | null;
  percentile: number | null;
  coverage: Coverage;
  components: Component[];
  waveDataAvailable: boolean;
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

export async function getHistoricalHazard(
  beach: { id: number; slug: string },
  incidentDate: string,
  climCache?: Map<number, Record<string, PercentileTable>>,
): Promise<HistoricalHazardResult | null> {
  const window = await getObservationWindow(beach.id, nextDay(incidentDate), 8) as ObsRow[];

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

  const hasLongSwell = Boolean(clim["swell_period_s"]);
  const bearing = BEACH_BEARING[beach.slug] ?? 270;
  const fv = fingerprint(window, bearing);

  const components = hazardComponents(fv, window as ObsRowExtended[], clim, coverage, hasLongSwell);
  const hazResult = hazardIndex(components);

  const tier: Tier = (!coverage.weather && !coverage.waves)
    ? "unknown"
    : tierFromPercentile(hazResult.percentile);

  return {
    tier,
    score: hazResult.score,
    percentile: hazResult.percentile,
    coverage,
    components,
    waveDataAvailable: coverage.waves,
  };
}
