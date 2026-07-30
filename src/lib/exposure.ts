// Pure exposure index module.
// No network, no DB, no external imports — suitable for unit tests.

import { percentileOf, tierFromPercentile, type PercentileTable, type Tier } from "./calibration";

export interface ExposureInput {
  tempMaxC: number | null;
  meanWindKnots: number | null;
  month: number;     // 1–12
  dayOfWeek: number; // 0 = Sunday … 6 = Saturday
  isIrishBankHoliday: boolean;
  isSchoolHoliday: boolean;
}

export interface ExposureResult {
  score: number | null;
  percentile: number | null;
  tier: Tier;
  drivers: string[];
}

// Irish bank holidays (month, day) — fixed-date ones only.
// Floating holidays (Easter, etc.) would require a more complex lookup.
const FIXED_BANK_HOLIDAYS: Array<[number, number]> = [
  [1, 1],   // New Year's Day
  [3, 17],  // St Patrick's Day
  [8, 4],   // August bank holiday (first Monday — approximated as first ~Aug)
  [10, 27], // October bank holiday (last Monday — approximated)
  [12, 25], // Christmas Day
  [12, 26], // St Stephen's Day
];

export function isFixedIrishBankHoliday(month: number, day: number): boolean {
  return FIXED_BANK_HOLIDAYS.some(([m, d]) => m === month && d === day);
}

// Irish school holidays: late June through early September.
export function isIrishSchoolHoliday(month: number): boolean {
  return month >= 7 && month <= 8; // July and August are solidly school holidays
}

/**
 * Compute a 0–1 exposure score from environmental and calendar signals.
 * Returns null score only when all inputs are missing.
 */
export function computeExposure(
  input: ExposureInput,
  climTempMax: PercentileTable | null,
): ExposureResult {
  const drivers: string[] = [];
  const components: number[] = [];

  // Temperature: hot days bring more swimmers
  if (input.tempMaxC != null) {
    const tempP = percentileOf(input.tempMaxC, climTempMax) ?? 0;
    components.push(tempP);
    if (tempP >= 0.75) drivers.push("warm air temperature");
  }

  // Wind: low wind = more people at beach
  if (input.meanWindKnots != null) {
    const calmScore = Math.max(0, 1 - input.meanWindKnots / 25);
    components.push(calmScore);
    if (calmScore >= 0.7) drivers.push("calm conditions attract swimmers");
  }

  // Month seasonality: peak in July/August
  const monthScore = [0, 0.05, 0.05, 0.1, 0.15, 0.3, 0.65, 0.9, 0.85, 0.35, 0.15, 0.05, 0.05][input.month] ?? 0.1;
  components.push(monthScore);
  if (input.month >= 6 && input.month <= 8) drivers.push("peak swimming season");

  // Weekend
  const isWeekend = input.dayOfWeek === 0 || input.dayOfWeek === 6;
  if (isWeekend) {
    components.push(0.8);
    drivers.push("weekend");
  } else {
    components.push(0.4);
  }

  // Bank holiday
  if (input.isIrishBankHoliday) {
    components.push(0.9);
    drivers.push("bank holiday");
  }

  // School holiday
  if (input.isSchoolHoliday) {
    components.push(0.85);
    drivers.push("school holidays");
  }

  if (!components.length) {
    return { score: null, percentile: null, tier: "unknown", drivers };
  }

  const score = components.reduce((a, b) => a + b, 0) / components.length;

  return {
    score,
    percentile: score,
    tier: tierFromPercentile(score),
    drivers,
  };
}
