// Seaward bearing from each beach (degrees true).
// A wind FROM this direction is directly onshore.
export const BEACH_BEARING: Record<string, number> = {
  fountainstown: 135,
  ballybunion:   270,
  skerries:      90,
};

export interface FeatureVector {
  meanWind: number;
  maxGust: number;
  maxWave: number;
  totalRain: number;
  pressureDrop: number;
  moonIllum: number;
  tideRange: number;
  onshoreComponent: number;
  // Phase 1 additions
  tideState: number;       // -1 ebbing … +1 flooding, 0 = slack/unknown
  hoursFromHigh: number;   // 0-1, 0 = at HW, 1 = at LW
  tideConfidence: number;  // 0 = unknown, 0.5 = daylight-prior, 1 = measured
  seaTempCold: number;     // clamp((15−seaTemp)/15, 0, 1)
  wavePeriod: number;      // period_s / 20
  warmCalm: number;        // hot + calm day (inflatable risk)
}

export interface ScoredMatch {
  incidentId: number;
  date: string;
  title: string;
  type: string;
  severity: number;
  score: number;
  alertLevel: "none" | "watch" | "warning" | "severe";
}

// tideConfidence is NOT in WEIGHTS — it gates tideState/hoursFromHigh, not scored directly.
const WEIGHTS = {
  onshoreComponent: 2.5,
  maxWave:          2.0,
  tideRange:        1.5,
  pressureDrop:     1.5,
  tideState:        1.5,
  maxGust:          1.2,
  meanWind:         1.0,
  hoursFromHigh:    0.8,
  wavePeriod:       0.8,
  totalRain:        0.6,
  seaTempCold:      0.5,
  moonIllum:        0.5,
  warmCalm:         0.4,
} as const;

type ScoredKey = keyof typeof WEIGHTS;

const TIDE_KEYS: ScoredKey[] = ["tideState", "hoursFromHigh"];

const SIGMA = 0.5;

function gaussian(d: number): number {
  return Math.exp(-(d * d) / (2 * SIGMA * SIGMA));
}

export function normalizeFeatures(raw: Partial<FeatureVector>): FeatureVector {
  return {
    meanWind:        raw.meanWind        ?? 0,
    maxGust:         raw.maxGust         ?? 0,
    maxWave:         raw.maxWave         ?? 0,
    totalRain:       raw.totalRain       ?? 0,
    pressureDrop:    raw.pressureDrop    ?? 0,
    moonIllum:       raw.moonIllum       ?? 0,
    tideRange:       raw.tideRange       ?? 0,
    onshoreComponent: raw.onshoreComponent ?? 0,
    tideState:       raw.tideState       ?? 0,
    hoursFromHigh:   raw.hoursFromHigh   ?? 0,
    tideConfidence:  raw.tideConfidence  ?? 0,
    seaTempCold:     raw.seaTempCold     ?? 0,
    wavePeriod:      raw.wavePeriod      ?? 0,
    warmCalm:        raw.warmCalm        ?? 0,
  };
}

// ─── Tide state derivation ────────────────────────────────────────────────────

export interface DaylightWindow {
  sunrise: string; // "HH:MM"
  sunset: string;  // "HH:MM"
}

interface TideStateResult {
  tideState: number;
  hoursFromHigh: number;
  tideConfidence: number;
}

function timeToMins(t: string): number {
  const parts = t.trim().split(":");
  if (parts.length < 2) return NaN;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return NaN;
  return h * 60 + m;
}

interface TidePoint { t: number; isHigh: boolean; }

function parseTidePoints(highTimes: string | null, lowTimes: string | null): TidePoint[] {
  const pts: TidePoint[] = [];
  for (const s of (highTimes ?? "").split(",")) {
    const t = timeToMins(s);
    if (!isNaN(t)) pts.push({ t, isHigh: true });
  }
  for (const s of (lowTimes ?? "").split(",")) {
    const t = timeToMins(s);
    if (!isNaN(t)) pts.push({ t, isHigh: false });
  }
  return pts.sort((a, b) => a.t - b.t);
}

function stateAtMins(tMins: number, pts: TidePoint[]): { tideState: number; hoursFromHigh: number } {
  if (pts.length < 2) return { tideState: 0, hoursFromHigh: 0.5 };

  // Find the bracketing pair that surrounds tMins
  let before = pts[0];
  let after = pts[pts.length - 1];
  let found = false;
  for (let i = 0; i < pts.length - 1; i++) {
    if (pts[i].t <= tMins && pts[i + 1].t > tMins) {
      before = pts[i];
      after = pts[i + 1];
      found = true;
      break;
    }
  }

  // Outside all events → use nearest boundary pair
  if (!found) {
    if (tMins < pts[0].t) { before = pts[pts.length - 1]; after = pts[0]; }
    else { before = pts[pts.length - 2]; after = pts[pts.length - 1]; }
  }

  const span = after.t - before.t;
  if (span <= 0) return { tideState: 0, hoursFromHigh: 0.5 };

  const frac = Math.max(0, Math.min(1, (tMins - before.t) / span));

  if (before.isHigh && !after.isHigh) {
    // Ebbing HW→LW: state peaks at -1 at mid-ebb (sinusoidal approximation)
    return {
      tideState: -Math.sin(Math.PI * frac),
      hoursFromHigh: frac, // 0 at HW, 1 at LW
    };
  } else if (!before.isHigh && after.isHigh) {
    // Flooding LW→HW: state peaks at +1 at mid-flood
    return {
      tideState: Math.sin(Math.PI * frac),
      hoursFromHigh: 1 - frac, // 1 at LW, 0 at HW
    };
  }

  return { tideState: 0, hoursFromHigh: 0.5 };
}

// Pure: computes tide state at a known time, or estimates over a daylight window.
export function deriveTideState(
  timeOfDay: string | null,
  highTideTimes: string | null,
  lowTideTimes: string | null,
  daylight?: DaylightWindow
): TideStateResult {
  const pts = parseTidePoints(highTideTimes, lowTideTimes);
  if (pts.length < 2) return { tideState: 0, hoursFromHigh: 0, tideConfidence: 0 };

  if (timeOfDay) {
    const tMins = timeToMins(timeOfDay);
    if (!isNaN(tMins)) {
      const s = stateAtMins(tMins, pts);
      return { ...s, tideConfidence: 1 };
    }
  }

  if (daylight) {
    const sunriseM = timeToMins(daylight.sunrise);
    const sunsetM = timeToMins(daylight.sunset);
    if (isNaN(sunriseM) || isNaN(sunsetM) || sunsetM <= sunriseM) {
      return { tideState: 0, hoursFromHigh: 0, tideConfidence: 0 };
    }

    // Sample 24 points across the daylight window
    const N = 24;
    let sumState = 0;
    let maxHoursFromHigh = 0; // maximum = closest approach to LW (highest rip risk)
    for (let i = 0; i < N; i++) {
      const t = sunriseM + ((sunsetM - sunriseM) * i) / (N - 1);
      const s = stateAtMins(t, pts);
      sumState += s.tideState;
      maxHoursFromHigh = Math.max(maxHoursFromHigh, s.hoursFromHigh);
    }
    return {
      tideState: sumState / N,
      hoursFromHigh: maxHoursFromHigh,
      tideConfidence: 0.5,
    };
  }

  return { tideState: 0, hoursFromHigh: 0, tideConfidence: 0 };
}

// ─── Observation window ───────────────────────────────────────────────────────

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
  sea_temp_c?: number | null;
  wave_period_s?: number | null;
  temp_max_c?: number | null;
  high_tide_times?: string | null;
  low_tide_times?: string | null;
  swell_height_m?: number | null;
  swell_period_s?: number | null;
  wind_wave_height_m?: number | null;
}

export interface FingerprintOpts {
  timeOfDay?: string | null;
  highTideTimes?: string | null;
  lowTideTimes?: string | null;
  daylight?: DaylightWindow;
}

// Compute feature vector from a window of daily observations (7-day prior + day-of).
// opts is optional for backward compatibility.
export function fingerprint(window: ObsRow[], beachBearingDeg: number, opts?: FingerprintOpts): FeatureVector {
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

  // Tidal force is maximum at both new moon (illum≈0) and full moon (illum≈1),
  // minimum at quarter moons (illum≈0.5). Raw illumination only captures full moon.
  const rawIllum = dayOf.moon_illum ?? 0;
  const moonIllum = Math.abs(1 - 2 * rawIllum);
  const tideRange = dayOf.tide_range_m ?? 0;

  const windDir = dayOf.wind_dir_deg;
  let onshoreComponent = 0;
  if (windDir != null) {
    const angleDiff = ((windDir - beachBearingDeg + 360) % 360);
    onshoreComponent = Math.cos((angleDiff * Math.PI) / 180);
  }

  // New Phase 1 features
  const seaTemp = dayOf.sea_temp_c ?? null;
  const seaTempCold = seaTemp != null ? Math.max(0, Math.min(1, (15 - seaTemp) / 15)) : 0;

  const period = dayOf.wave_period_s ?? null;
  const wavePeriod = period != null ? Math.min(period / 20, 1) : 0;

  const tempMax = dayOf.temp_max_c ?? null;
  const windForCalm = meanWind; // 7-day mean
  const warmCalm = tempMax != null
    ? Math.min(1, Math.max(0, (tempMax - 18) / 15) * Math.max(0, 1 - windForCalm / 20))
    : 0;

  // Tide state: from opts (preferred) or from dayOf observation fields
  const highTimes = opts?.highTideTimes ?? dayOf.high_tide_times ?? null;
  const lowTimes = opts?.lowTideTimes ?? dayOf.low_tide_times ?? null;
  const tideResult = deriveTideState(
    opts?.timeOfDay ?? null,
    highTimes,
    lowTimes,
    opts?.daylight,
  );

  return normalizeFeatures({
    meanWind: meanWind / 30,
    maxGust: maxGust / 50,
    maxWave: maxWave / 5,
    totalRain: totalRain / 50,
    pressureDrop: Math.max(pressureDrop, 0) / 30,
    moonIllum,
    tideRange: tideRange / 5,
    onshoreComponent: Math.max(onshoreComponent, 0),
    seaTempCold,
    wavePeriod,
    warmCalm,
    tideState: tideResult.tideState,
    hoursFromHigh: tideResult.hoursFromHigh,
    tideConfidence: tideResult.tideConfidence,
  });
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

// When either vector has tideConfidence=0, tide state features are excluded and
// the remaining weights are renormalised automatically by the weighted average.
export function score(candidate: FeatureVector, reference: FeatureVector): number {
  const keys = Object.keys(WEIGHTS) as ScoredKey[];
  const noTide = !candidate.tideConfidence || !reference.tideConfidence;

  let weightSum = 0;
  let scoreSum = 0;
  for (const k of keys) {
    if (noTide && TIDE_KEYS.includes(k)) continue;
    const w = WEIGHTS[k];
    const diff = (candidate[k] ?? 0) - (reference[k] ?? 0);
    scoreSum += w * gaussian(diff);
    weightSum += w;
  }
  return weightSum > 0 ? scoreSum / weightSum : 0;
}

export function alertLevel(s: number): ScoredMatch["alertLevel"] {
  if (s >= 0.85) return "severe";
  if (s >= 0.7)  return "warning";
  if (s >= 0.55) return "watch";
  return "none";
}

export function matchAll(
  candidate: FeatureVector,
  fingerprints: Array<{ incidentId: number; date: string; title: string; type: string; severity: number; features: FeatureVector }>
): ScoredMatch[] {
  return fingerprints
    .map((fp) => {
      const s = score(candidate, fp.features);
      return {
        incidentId: fp.incidentId,
        date: fp.date,
        title: fp.title,
        type: fp.type,
        severity: fp.severity,
        score: s,
        alertLevel: alertLevel(s),
      };
    })
    .sort((a, b) => b.score - a.score);
}

// ─── Tide description & trajectory ───────────────────────────────────────────

function minsToHHMM(m: number): string {
  const normalised = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(normalised / 60);
  const min = normalised % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export interface TideDescription {
  direction: "flooding" | "ebbing" | "slack";
  sincePrev: { label: string; mins: number };
  toNext: { label: string; mins: number };
  tideState: number;
  hoursFromHigh: number;
}

export function describeTideAt(
  timeOfDay: string,
  highTimes: string | null,
  lowTimes: string | null
): TideDescription | null {
  const pts = parseTidePoints(highTimes, lowTimes);
  if (pts.length < 2) return null;
  const tMins = timeToMins(timeOfDay);
  if (isNaN(tMins)) return null;

  let before = pts[0];
  let after = pts[pts.length - 1];
  let found = false;
  for (let i = 0; i < pts.length - 1; i++) {
    if (pts[i].t <= tMins && pts[i + 1].t > tMins) {
      before = pts[i];
      after = pts[i + 1];
      found = true;
      break;
    }
  }
  if (!found) {
    if (tMins < pts[0].t) { before = pts[pts.length - 1]; after = pts[0]; }
    else { before = pts[pts.length - 2]; after = pts[pts.length - 1]; }
  }

  const sinceMins = tMins >= before.t ? tMins - before.t : tMins + 1440 - before.t;
  const toMins = after.t >= tMins ? after.t - tMins : after.t + 1440 - tMins;

  const direction: "flooding" | "ebbing" | "slack" =
    !before.isHigh && after.isHigh ? "flooding" :
    before.isHigh && !after.isHigh ? "ebbing" : "slack";

  const { tideState, hoursFromHigh } = stateAtMins(tMins, pts);

  return {
    direction,
    sincePrev: { label: `${minsToHHMM(before.t)} ${before.isHigh ? "HW" : "LW"}`, mins: sinceMins },
    toNext: { label: `${minsToHHMM(after.t)} ${after.isHigh ? "HW" : "LW"}`, mins: toMins },
    tideState,
    hoursFromHigh,
  };
}

export interface TideStep {
  minsOffset: number;
  tideState: number;
  hoursFromHigh: number;
}

export function tideTrajectory(
  timeOfDay: string,
  highTimes: string | null,
  lowTimes: string | null,
  minutesBefore = 60,
  steps = 4
): TideStep[] {
  const pts = parseTidePoints(highTimes, lowTimes);
  if (pts.length < 2) return [];
  const tMins = timeToMins(timeOfDay);
  if (isNaN(tMins)) return [];

  const result: TideStep[] = [];
  for (let i = 0; i <= steps; i++) {
    const minsOffset = -minutesBefore + (minutesBefore * i) / steps;
    const { tideState, hoursFromHigh } = stateAtMins(tMins + minsOffset, pts);
    result.push({ minsOffset: Math.round(minsOffset), tideState, hoursFromHigh });
  }
  return result;
}

// ─── Baseline ─────────────────────────────────────────────────────────────────

export function computeBaseline(fps: Array<{ features: FeatureVector }>): FeatureVector {
  if (!fps.length) return normalizeFeatures({});
  const keys = Object.keys(normalizeFeatures({})) as Array<keyof FeatureVector>;
  const result = {} as Record<keyof FeatureVector, number>;
  for (const k of keys) {
    const vals = fps.map((fp) => fp.features[k] ?? 0).sort((a, b) => a - b);
    result[k] = vals[Math.floor(vals.length / 2)] ?? 0;
  }
  return normalizeFeatures(result);
}

// ─── Explainability ───────────────────────────────────────────────────────────

export interface FeatureContribution {
  key: ScoredKey;
  weight: number;
  candidateVal: number;
  referenceVal: number;
  distance: number;
  contribution: number;
  contributionPct: number;
}

// Per-feature breakdown of how candidate matches reference, sorted by contribution desc.
export function explain(candidate: FeatureVector, reference: FeatureVector): FeatureContribution[] {
  const keys = Object.keys(WEIGHTS) as ScoredKey[];
  const noTide = !candidate.tideConfidence || !reference.tideConfidence;

  let total = 0;
  const items: Omit<FeatureContribution, "contributionPct">[] = [];

  for (const k of keys) {
    if (noTide && TIDE_KEYS.includes(k)) continue;
    const w = WEIGHTS[k];
    const cv = candidate[k] ?? 0;
    const rv = reference[k] ?? 0;
    const diff = cv - rv;
    const contribution = w * gaussian(diff);
    total += contribution;
    items.push({ key: k, weight: w, candidateVal: cv, referenceVal: rv, distance: Math.abs(diff), contribution });
  }

  return items
    .map((item) => ({
      ...item,
      contributionPct: total > 0 ? (item.contribution / total) * 100 : 0,
    }))
    .sort((a, b) => b.contribution - a.contribution);
}

export interface BaselineDeviation {
  key: ScoredKey;
  candidateVal: number;
  baselineVal: number;
  deviation: number;
  // True when today is unusual vs baseline AND close to the matched incident
  isDiscriminating: boolean;
}

// Per-feature deviation of today from beach-typical conditions.
// reference is the matched incident's feature vector (used to gate "discriminating").
export function baselineContrast(
  candidate: FeatureVector,
  baseline: FeatureVector,
  reference?: FeatureVector
): BaselineDeviation[] {
  const keys = Object.keys(WEIGHTS) as ScoredKey[];
  return keys
    .map((k) => {
      const cv = candidate[k] ?? 0;
      const bv = baseline[k] ?? 0;
      const rv = reference ? (reference[k] ?? 0) : null;
      const deviation = Math.abs(cv - bv);
      const closeToIncident = rv != null ? Math.abs(cv - rv) < 0.3 : true;
      return {
        key: k,
        candidateVal: cv,
        baselineVal: bv,
        deviation,
        isDiscriminating: deviation > 0.2 && closeToIncident,
      };
    })
    .sort((a, b) => b.deviation - a.deviation);
}
