// Pure exposure index module.
// No network, no DB, no external imports — suitable for unit tests.

import { percentileOf, type PercentileTable } from "./calibration";

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
  drivers: string[];
}

// Fixed-date Irish bank holidays only.
const FIXED_BANK_HOLIDAYS: Array<[number, number]> = [
  [1, 1],   // New Year's Day
  [3, 17],  // St Patrick's Day
  [12, 25], // Christmas Day
  [12, 26], // St Stephen's Day
];

// First Monday of a given month (returns day-of-month, 1-indexed).
function firstMonday(year: number, month: number): number {
  const d = new Date(year, month - 1, 1);
  const dow = d.getDay(); // 0=Sun
  return 1 + (dow === 1 ? 0 : (8 - dow) % 7);
}

// Last Monday of a given month (returns day-of-month, 1-indexed).
function lastMonday(year: number, month: number): number {
  const last = new Date(year, month, 0).getDate();
  const dow = new Date(year, month - 1, last).getDay();
  return last - (dow === 1 ? 0 : (dow === 0 ? 6 : dow - 1));
}

export function isFixedIrishBankHoliday(month: number, day: number): boolean {
  return FIXED_BANK_HOLIDAYS.some(([m, d]) => m === month && d === day);
}

export function isIrishBankHoliday(year: number, month: number, day: number): boolean {
  if (isFixedIrishBankHoliday(month, day)) return true;
  // May bank holiday — first Monday in May
  if (month === 5 && day === firstMonday(year, 5)) return true;
  // June bank holiday — first Monday in June
  if (month === 6 && day === firstMonday(year, 6)) return true;
  // August bank holiday — first Monday in August
  if (month === 8 && day === firstMonday(year, 8)) return true;
  // October bank holiday — last Monday in October
  if (month === 10 && day === lastMonday(year, 10)) return true;
  return false;
}

// Irish school holidays: late June through early September.
export function isIrishSchoolHoliday(month: number): boolean {
  return month >= 7 && month <= 8; // July and August are solidly school holidays
}

// Smooth 2-harmonic seasonal curve; peaks at late July (t=6.5 where t=month-1).
function harmonicMonthScore(month: number): number {
  const t = month - 1; // 0=Jan, 11=Dec
  const phi = (2 * Math.PI * 6.5) / 12; // peak phase
  return Math.max(0, Math.min(1,
    0.28
    + 0.52 * Math.cos(2 * Math.PI * t / 12 - phi)
    + 0.08 * Math.cos(4 * Math.PI * t / 12 - 2 * phi),
  ));
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

  // Smooth harmonic seasonality — cross-month variation drives the annual calibration
  const monthScore = harmonicMonthScore(input.month);
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
    return { score: null, percentile: null, drivers };
  }

  const score = components.reduce((a, b) => a + b, 0) / components.length;

  return {
    score,
    percentile: score,
    drivers,
  };
}
