export interface FeatureVector {
  meanWind: number;
  maxGust: number;
  maxWave: number;
  totalRain: number;
  pressureDrop: number;
  moonIllum: number;
  tideRange: number;
  onshoreComponent: number;
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

const WEIGHTS: Record<keyof FeatureVector, number> = {
  onshoreComponent: 2.5,
  maxWave: 2.0,
  tideRange: 1.5,
  pressureDrop: 1.5,
  maxGust: 1.2,
  meanWind: 1.0,
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
}

export function fingerprint(window: ObsRow[], beachBearingDeg: number): FeatureVector {
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
    const angleDiff = ((windDir - beachBearingDeg + 360) % 360);
    onshoreComponent = Math.cos((angleDiff * Math.PI) / 180);
  }

  return normalizeFeatures({
    meanWind: meanWind / 30,
    maxGust: maxGust / 50,
    maxWave: maxWave / 5,
    totalRain: totalRain / 50,
    pressureDrop: Math.max(pressureDrop, 0) / 30,
    moonIllum,
    tideRange: tideRange / 5,
    onshoreComponent: Math.max(onshoreComponent, 0),
  });
}

export function score(candidate: FeatureVector, reference: FeatureVector): number {
  const keys = Object.keys(WEIGHTS) as Array<keyof FeatureVector>;
  let weightSum = 0;
  let scoreSum = 0;
  for (const k of keys) {
    const w = WEIGHTS[k];
    const diff = (candidate[k] ?? 0) - (reference[k] ?? 0);
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
