// Unified scoring path shared by forecast, climatology builder, and backtest.
// No network, no DB — suitable for use in any context.

import { fingerprint, type FingerprintOpts, type FeatureVector } from "./similarity";
import { hazardComponents, hazardIndex, type Coverage, type HazardResult, type ObsRowExtended } from "./hazard";
import { computeExposure, isIrishBankHoliday, isIrishSchoolHoliday, type ExposureResult } from "./exposure";
import type { PercentileTable } from "./calibration";

export const EXPOSURE_WEIGHT = 0.65;

export interface DayScore {
  hazard: HazardResult;
  exposure: ExposureResult;
  combined: number | null;
  features: FeatureVector;
}

export interface DayCalendar {
  year: number;
  month: number;    // 1–12
  day: number;      // 1–31
  dayOfWeek: number; // 0=Sunday … 6=Saturday
}

/**
 * Compute the blended hazard + exposure score for a single day.
 * Returns raw combined number (not yet rank-calibrated to a percentile).
 * The caller converts to tier using percentileOf(combined, annualClim.combined_score).
 */
export function scoreDay(
  window: ObsRowExtended[],
  bearingDeg: number,
  clim: Record<string, PercentileTable | null>,
  coverage: Coverage,
  calendar: DayCalendar,
  opts?: FingerprintOpts,
): DayScore {
  const features = fingerprint(window, bearingDeg, opts);
  const components = hazardComponents(features, window, clim, coverage);
  const hazard = hazardIndex(components);

  const dayOf = window[window.length - 1];
  const exposure = computeExposure(
    {
      tempMaxC: dayOf?.temp_max_c ?? null,
      meanWindKnots: dayOf?.mean_wind_knots ?? null,
      month: calendar.month,
      dayOfWeek: calendar.dayOfWeek,
      isIrishBankHoliday: isIrishBankHoliday(calendar.year, calendar.month, calendar.day),
      isSchoolHoliday: isIrishSchoolHoliday(calendar.month),
    },
    clim["temp_max_c"] ?? null,
  );

  let combined: number | null = null;
  if (hazard.score != null && exposure.score != null) {
    combined = EXPOSURE_WEIGHT * exposure.score + (1 - EXPOSURE_WEIGHT) * hazard.score;
  } else if (exposure.score != null) {
    combined = exposure.score;
  } else if (hazard.score != null) {
    combined = hazard.score;
  }

  return { hazard, exposure, combined, features };
}
