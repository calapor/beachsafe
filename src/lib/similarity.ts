import { getTimes } from "suncalc";

export interface FeatureVector {
  meanWind: number;
  maxGust: number;
  maxWave: number;
  totalRain: number;
  pressureDrop: number;
  moonIllum: number;
  tideRange: number;
  onshoreComponent: number;
  daylightHighTide: number;
  risingFraction: number;
}

export interface ScoredMatch {
  incidentId: number;
  date: string;
  title: string;
  type: string;
  severity: number;
  score: number;
  alertLevel: "none" | "watch" | "warning" | "severe";
  features: FeatureVector;
}

const WEIGHTS: Record<keyof FeatureVector, number> = {
  onshoreComponent: 2.5,
  maxWave: 2.0,
  tideRange: 1.5,
  pressureDrop: 1.5,
  risingFraction: 1.2,
  maxGust: 1.2,
  meanWind: 1.0,
  daylightHighTide: 1.0,
  totalRain: 0.6,
  moonIllum: 0.5,
};

const SIGMA = 0.5;

function gaussian(d: number): number {
  return Math.exp(-(d * d) / (2 * SIGMA * SIGMA));
}

export function normalizeFeatures(raw: Partial<FeatureVector>): FeatureVector {
  return {
    meanWind: raw.meanWind ?? 0,
    maxGust: raw.maxGust ?? 0,
    maxWave: raw.maxWave ?? 0,
    totalRain: raw.totalRain ?? 0,
    pressureDrop: raw.pressureDrop ?? 0,
    moonIllum: raw.moonIllum ?? 0,
    tideRange: raw.tideRange ?? 0,
    onshoreComponent: raw.onshoreComponent ?? 0,
    daylightHighTide: raw.daylightHighTide ?? 0.5,
    risingFraction: raw.risingFraction ?? 0.5,
  };
}

// Compute feature vector from a window of daily observations (7-day prior + day-of)
export interface ObsRow {
  date: string;
  mean_wind_knots?: number | null;
  max_gust_knots?: number | null;
  wave_height_m?: number | null;
  rain_mm?: number | null;
  mslp_hpa?: number | null;
  moon_illum?: number | null;
  tide_range_m?: number | null;
  wind_dir_deg?: number | null;
  high_tide_times?: string | null;
  low_tide_times?: string | null;
}

// Parse "HH:MM,HH:MM" into sorted array of minutes-since-midnight (UTC)
function parseTideTimes(timesStr: string | null | undefined): number[] {
  if (!timesStr) return [];
  return timesStr
    .split(",")
    .map((t) => {
      const parts = t.trim().split(":");
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1] ?? "0", 10);
      return h * 60 + m;
    })
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);
}

// Is the tide rising at the given minute-of-day, given sorted high/low tide times?
function isTideRising(minOfDay: number, highs: number[], lows: number[]): boolean {
  const extrema = [
    ...highs.map((m) => ({ m, isHigh: true })),
    ...lows.map((m) => ({ m, isHigh: false })),
  ].sort((a, b) => a.m - b.m);

  if (!extrema.length) return true;

  let lastBefore: { m: number; isHigh: boolean } | null = null;
  for (const e of extrema) {
    if (e.m <= minOfDay) lastBefore = e;
    else break;
  }

  // Before any extremum today: tide is heading toward the first one
  // (rising if first extremum is a high, falling if first is a low)
  if (lastBefore === null) return extrema[0].isHigh;

  // After a high: falling; after a low: rising
  return !lastBefore.isHigh;
}

function computeTideFeatures(
  dateStr: string,
  highTideTimes: string | null | undefined,
  lowTideTimes: string | null | undefined,
  lat: number,
  lon: number,
  incidentHour?: number | null
): { daylightHighTide: number; risingFraction: number } {
  const highs = parseTideTimes(highTideTimes);
  const lows = parseTideTimes(lowTideTimes);

  if (!highs.length && !lows.length) {
    return { daylightHighTide: 0.5, risingFraction: 0.5 };
  }

  // Get sunrise/sunset in UTC minutes; fall back to typical Irish summer hours
  let sunriseMins = 5 * 60 + 30;  // 05:30 UTC ≈ 06:30 BST
  let sunsetMins  = 20 * 60 + 30; // 20:30 UTC ≈ 21:30 BST
  try {
    const date = new Date(dateStr + "T12:00:00Z");
    const times = getTimes(date, lat, lon);
    if (times.sunrise && !isNaN(times.sunrise.getTime())) {
      sunriseMins = times.sunrise.getUTCHours() * 60 + times.sunrise.getUTCMinutes();
    }
    if (times.sunset && !isNaN(times.sunset.getTime())) {
      sunsetMins = times.sunset.getUTCHours() * 60 + times.sunset.getUTCMinutes();
    }
  } catch { /* use fallbacks */ }

  const daylightHighTide = highs.some((m) => m >= sunriseMins && m <= sunsetMins) ? 1 : 0;

  let risingFraction: number;

  if (incidentHour != null) {
    // Exact callout hour known (UTC): point-in-time direction
    risingFraction = isTideRising(incidentHour * 60, highs, lows) ? 1 : 0;
  } else {
    // Daylight window: sample every 30 min, compute rising fraction
    const STEP = 30;
    let risingCount = 0;
    let totalCount = 0;
    for (let m = sunriseMins; m <= sunsetMins; m += STEP) {
      if (isTideRising(m, highs, lows)) risingCount++;
      totalCount++;
    }
    risingFraction = totalCount > 0 ? risingCount / totalCount : 0.5;
  }

  return { daylightHighTide, risingFraction };
}

export function fingerprint(
  window: ObsRow[],
  beachBearingDeg: number,
  geo?: { lat: number; lon: number; incidentHour?: number | null }
): FeatureVector {
  if (!window.length) return normalizeFeatures({});

  const dayOf = window[window.length - 1];
  const prior = window.slice(0, -1);

  const meanWind =
    prior.reduce((s, r) => s + (r.mean_wind_knots ?? 0), 0) /
    Math.max(prior.length, 1);
  const maxGust = Math.max(...window.map((r) => r.max_gust_knots ?? 0));
  const maxWave = Math.max(...window.map((r) => r.wave_height_m ?? 0));
  const totalRain = window.reduce((s, r) => s + (r.rain_mm ?? 0), 0);

  const pressures = window.map((r) => r.mslp_hpa).filter((v): v is number => v != null);
  const pressureDrop =
    pressures.length >= 2 ? pressures[0] - pressures[pressures.length - 1] : 0;

  const moonIllum = dayOf.moon_illum ?? 0;
  const tideRange = dayOf.tide_range_m ?? 0;

  const windDir = dayOf.wind_dir_deg;
  let onshoreComponent = 0;
  if (windDir != null) {
    const angleDiff = (windDir - beachBearingDeg + 360) % 360;
    onshoreComponent = Math.cos((angleDiff * Math.PI) / 180);
  }

  const tideFeatures = geo
    ? computeTideFeatures(dayOf.date, dayOf.high_tide_times, dayOf.low_tide_times, geo.lat, geo.lon, geo.incidentHour)
    : { daylightHighTide: 0.5, risingFraction: 0.5 };

  return normalizeFeatures({
    meanWind: meanWind / 30,
    maxGust: maxGust / 50,
    maxWave: maxWave / 5,
    totalRain: totalRain / 50,
    pressureDrop: Math.max(pressureDrop, 0) / 30,
    moonIllum,
    tideRange: tideRange / 5,
    onshoreComponent: Math.max(onshoreComponent, 0),
    ...tideFeatures,
  });
}

export function score(candidate: FeatureVector, reference: FeatureVector): number {
  const keys = Object.keys(WEIGHTS) as Array<keyof FeatureVector>;
  let weightSum = 0;
  let scoreSum = 0;
  for (const k of keys) {
    const w = WEIGHTS[k];
    const diff = (candidate[k] ?? 0.5) - (reference[k] ?? 0.5);
    scoreSum += w * gaussian(diff);
    weightSum += w;
  }
  return weightSum > 0 ? scoreSum / weightSum : 0;
}

export function alertLevel(s: number): ScoredMatch["alertLevel"] {
  if (s >= 0.85) return "severe";
  if (s >= 0.7) return "warning";
  if (s >= 0.55) return "watch";
  return "none";
}

export function matchAll(
  candidate: FeatureVector,
  fingerprints: Array<{ incidentId: number; date: string; title: string; type: string; severity: number; features: FeatureVector }>
): ScoredMatch[] {
  return fingerprints
    .map((fp) => {
      const normalized = normalizeFeatures(fp.features);
      const s = score(candidate, normalized);
      return {
        incidentId: fp.incidentId,
        date: fp.date,
        title: fp.title,
        type: fp.type,
        severity: fp.severity,
        score: s,
        alertLevel: alertLevel(s),
        features: normalized,
      };
    })
    .sort((a, b) => b.score - a.score);
}
