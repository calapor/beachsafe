// Pure hazard index module.
// No network, no DB, no external imports — suitable for unit tests.

import { percentileOf, type PercentileTable } from "./calibration";
import type { FeatureVector, ObsRow } from "./similarity";

export type Evidence = "validated" | "suggestive" | "unvalidated" | "insufficient-data";

export interface Component {
  key: string;
  raw: number | null;
  percentile: number | null;
  score: number | null;
  evidence: Evidence;
  mechanism: string;
  inputs: string[];
}

export interface Coverage {
  weather: boolean;
  waves: boolean;
  tide: boolean;
  swell: boolean;
}

// Extended obs row including swell fields
export interface ObsRowExtended extends ObsRow {
  swell_height_m?: number | null;
  swell_period_s?: number | null;
  wind_wave_height_m?: number | null;
}

export interface HazardResult {
  score: number | null;
  percentile: number | null;
  driver: Component | null;
  missing: Component[];
  components: Component[];
}

function lookup(clim: Record<string, PercentileTable | null>, key: string): PercentileTable | null {
  return clim[key] ?? null;
}

/**
 * Compute all hazard components from the feature vector, observation window, and
 * climatology tables for this beach+month.
 *
 * Component scores are climatological percentiles, not raw normalized values.
 * Missing inputs produce score=null and evidence="insufficient-data".
 */
export function hazardComponents(
  fv: FeatureVector,
  window: ObsRowExtended[],
  clim: Record<string, PercentileTable | null>,
  coverage: Coverage,
): Component[] {
  const dayOf = window[window.length - 1] as ObsRowExtended | undefined;

  // ── springTideRange ──────────────────────────────────────────────────────
  const tideRangeRaw = dayOf?.tide_range_m ?? null;
  const tideRangeP = percentileOf(tideRangeRaw, lookup(clim, "tide_range_m"));
  const springTideRange: Component = {
    key: "springTideRange",
    raw: tideRangeRaw,
    percentile: coverage.tide ? tideRangeP : null,
    score: coverage.tide ? tideRangeP : null,
    evidence: "suggestive",
    mechanism: "Large tidal range drives stronger rip channels and faster ebb flows.",
    inputs: ["tide_range_m"],
  };

  // ── ripBand ──────────────────────────────────────────────────────────────
  // Surf height 0.7–1.5 m activates rip channels; flat surf makes no rips,
  // big surf keeps people out. Peak at 1.1 m using exp(-((hs-1.1)/0.55)²).
  const hsRaw = dayOf?.wave_height_m ?? null;
  let ripBandScore: number | null = null;
  if (hsRaw != null && coverage.waves) {
    ripBandScore = Math.exp(-Math.pow((hsRaw - 1.1) / 0.55, 2));
  }
  const ripBand: Component = {
    key: "ripBand",
    raw: hsRaw,
    percentile: ripBandScore,
    score: ripBandScore,
    evidence: "unvalidated",
    mechanism: "Surf height in the 0.7–1.5 m band activates rip channels without visually deterring swimmers.",
    inputs: ["wave_height_m"],
  };

  // ── ebbNearLow ───────────────────────────────────────────────────────────
  // tideState < 0 (ebbing) weighted by hoursFromHigh (fraction toward LW)
  let ebbNearLowRaw: number | null = null;
  if (fv.tideConfidence > 0) {
    ebbNearLowRaw = fv.tideState < 0
      ? Math.abs(fv.tideState) * fv.hoursFromHigh
      : 0;
  }
  const ebbNearLow: Component = {
    key: "ebbNearLow",
    raw: ebbNearLowRaw,
    percentile: ebbNearLowRaw,
    score: ebbNearLowRaw,
    evidence: "unvalidated",
    mechanism: "Ebbing tide near low water maximises rip-channel drainage velocity.",
    inputs: ["high_tide_times", "low_tide_times"],
  };

  // ── onshoreWind ──────────────────────────────────────────────────────────
  const windKnots = dayOf?.mean_wind_knots ?? null;
  const windP = percentileOf(windKnots, lookup(clim, "mean_wind_knots"));
  let onshoreWindScore: number | null = null;
  if (coverage.weather && windKnots != null) {
    // Offshore wind → score=0 (known absence, not missing data)
    onshoreWindScore = fv.onshoreComponent > 0
      ? fv.onshoreComponent * (windP ?? 0)
      : 0;
  }
  const onshoreWind: Component = {
    key: "onshoreWind",
    raw: windKnots != null ? fv.onshoreComponent * (windKnots ?? 0) : null,
    percentile: onshoreWindScore,
    score: onshoreWindScore,
    evidence: "unvalidated",
    mechanism: "Onshore wind piles up water at the shoreline, feeding longshore currents and rip feeders.",
    inputs: ["wind_dir_deg", "mean_wind_knots"],
  };

  // ── offshoreBlowoff ──────────────────────────────────────────────────────
  let offshoreBlowoffScore: number | null = null;
  if (coverage.weather) {
    // onshoreSigned < 0 means wind is blowing offshore; onshoreComponent (clamped) can never be < 0
    const offshoreStrength = fv.onshoreSigned < 0 ? Math.abs(fv.onshoreSigned) : 0;
    offshoreBlowoffScore = fv.warmCalm > 0 ? offshoreStrength * fv.warmCalm : 0;
  }
  const offshoreBlowoff: Component = {
    key: "offshoreBlowoff",
    raw: offshoreBlowoffScore,
    percentile: offshoreBlowoffScore,
    score: offshoreBlowoffScore,
    evidence: "unvalidated",
    mechanism: "Offshore wind on a warm calm day blows inflatables and weak swimmers away from shore.",
    inputs: ["wind_dir_deg", "temp_max_c", "mean_wind_knots"],
  };

  // ── coldShock ────────────────────────────────────────────────────────────
  const seaTempRaw = dayOf?.sea_temp_c ?? null;
  const airTempRaw = dayOf?.temp_max_c ?? null;
  let coldShockScore: number | null = null;
  if (coverage.weather && seaTempRaw != null && airTempRaw != null) {
    const seaCold = Math.max(0, Math.min(1, (15 - seaTempRaw) / 15));
    const airHot  = Math.max(0, Math.min(1, (airTempRaw - 18) / 15));
    coldShockScore = seaCold * airHot;
  }
  const coldShock: Component = {
    key: "coldShock",
    raw: seaTempRaw,
    percentile: coldShockScore,
    score: coldShockScore,
    evidence: "unvalidated",
    mechanism: "Cold water under a hot air temperature causes cardiac cold-shock on immersion.",
    inputs: ["sea_temp_c", "temp_max_c"],
  };

  // ── stormLegacy ──────────────────────────────────────────────────────────
  // Maximum swell/gust in days −14…−3, plus "first calm day after a blow"
  // (prior gust > p90 AND today's gust < p40).
  const gustP90 = lookup(clim, "max_gust_knots")?.ladder[90] ?? null;
  const gustP40 = lookup(clim, "max_gust_knots")?.ladder[40] ?? null;
  const priorWindow = window.slice(0, -1);
  const priorGusts = priorWindow.map((r) => r.max_gust_knots ?? null).filter((v): v is number => v != null);
  const maxPriorGust = priorGusts.length ? Math.max(...priorGusts) : null;
  const todayGust = dayOf?.max_gust_knots ?? null;

  let stormLegacyScore: number | null = null;
  if (maxPriorGust != null && todayGust != null && gustP90 != null && gustP40 != null) {
    const firstCalmDay = maxPriorGust > gustP90 && todayGust < gustP40;
    const priorWaveP = percentileOf(
      Math.max(...priorWindow.map((r) => r.wave_height_m ?? 0)),
      lookup(clim, "wave_height_m")
    );
    stormLegacyScore = firstCalmDay ? Math.max(priorWaveP ?? 0, 0.7) : (priorWaveP ?? 0) * 0.5;
  }
  const stormLegacy: Component = {
    key: "stormLegacy",
    raw: maxPriorGust,
    percentile: stormLegacyScore,
    score: stormLegacyScore,
    evidence: "unvalidated",
    mechanism: "Post-storm conditions — rip channels reworked by swell persist on the first calm day after a blow.",
    inputs: ["max_gust_knots", "wave_height_m"],
  };

  return [
    springTideRange,
    ripBand,
    ebbNearLow,
    onshoreWind,
    offshoreBlowoff,
    coldShock,
    stormLegacy,
  ];
}

/**
 * Aggregate components into a single hazard score.
 * Ignores null-score components; returns score=null if fewer than half available.
 */
export function hazardIndex(cs: Component[]): HazardResult {
  const available = cs.filter((c) => c.score != null);
  const missing   = cs.filter((c) => c.score == null);

  if (available.length === 0 || available.length < cs.length / 2) {
    return { score: null, percentile: null, driver: null, missing, components: cs };
  }

  const mean = available.reduce((s, c) => s + c.score!, 0) / available.length;
  const driver = [...available].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;

  return { score: mean, percentile: mean, driver, missing, components: cs };
}

/**
 * Read evidence labels from the feature_discrimination table results.
 * Call this after discrimination.ts has populated the table and pass results
 * into hazardComponents via the clim map or a separate evidence map.
 */
export function evidenceFromDiscrimination(
  aucLo: number | null,
  auc: number | null,
): Evidence {
  if (aucLo != null && aucLo > 0.5) return "validated";
  if (auc != null && auc >= 0.58)   return "suggestive";
  if (auc != null)                   return "unvalidated";
  return "unvalidated";
}
