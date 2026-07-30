import { getMoonIllumination, getTimes } from "suncalc";
import { XMLParser } from "fast-xml-parser";
import {
  fingerprint,
  matchAll,
  computeBaseline,
  BEACH_BEARING,
  type ObsRow,
  type ScoredMatch,
  type FeatureVector,
} from "./similarity";
import { tierFromPercentile, type Tier, type PercentileTable } from "./calibration";
import { hazardComponents, hazardIndex, type Component, type Coverage } from "./hazard";
import { getObservationWindow, getClimatology } from "@/db/queries";

export interface ForecastDay {
  date: string;
  wind_knots: number | null;
  gust_knots: number | null;
  wind_dir_deg: number | null;
  wave_height_m: number | null;
  wave_period_s: number | null;
  sea_temp_c: number | null;
  precip_mm: number | null;
  mslp_hpa: number | null;
  temp_max_c: number | null;
  moon_illum: number;
  tide_range_m: number;
  // Calibrated tier (replaces old alertLevel-from-score)
  tier: Tier;
  // Keep for backward compat — same as tier
  alertLevel: "none" | "watch" | "warning" | "severe";
  // Hazard breakdown
  hazardScore: number | null;
  hazardComponents: Component[];
  hazardDriver: Component | null;
  // Coverage tracking — unknown tier when weather or waves false
  coverage: Coverage;
  // Precedent matches (similarity lookup, no longer drives tier)
  topMatches: ScoredMatch[];
  features: FeatureVector;
}

const BASE_TIDE_RANGE: Record<string, { spring: number; neap: number }> = {
  fountainstown: { spring: 3.8, neap: 2.0 },
  ballybunion:   { spring: 5.0, neap: 2.6 },
  skerries:      { spring: 3.2, neap: 1.6 },
};

const MS_TO_KNOTS = 1.94384;

interface MetForecastPoint {
  time: string;
  wind_speed_ms: number | null;
  wind_gust_ms: number | null;
  wind_dir_deg: number | null;
  precip_mm: number | null;
  mslp_hpa: number | null;
  temp_c: number | null;
}

async function fetchMetForecast(lat: number, lon: number): Promise<MetForecastPoint[]> {
  const url = `http://openaccess.pf.api.met.ie/metno-wdb2ts/locationforecast?lat=${lat};long=${lon}`;
  let text: string;
  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return [];
    text = await res.text();
  } catch { return []; }

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const doc = parser.parse(text);

  const timeSteps: MetForecastPoint[] = [];
  const product = doc?.weatherdata?.product?.time;
  const times = Array.isArray(product) ? product : product ? [product] : [];

  for (const t of times) {
    const from: string = t["@_from"] ?? "";
    const location = t?.location;
    if (!location) continue;

    const windSpeed = location.windSpeed  ? parseFloat(location.windSpeed["@_mps"]      ?? "NaN") : null;
    const windGust  = location.windGust   ? parseFloat(location.windGust["@_mps"]       ?? "NaN") : null;
    const windDir   = location.windDirection ? parseFloat(location.windDirection["@_deg"] ?? "NaN") : null;
    const precip    = location.precipitation ? parseFloat(location.precipitation["@_value"] ?? "NaN") : null;
    const mslp      = location.pressure   ? parseFloat(location.pressure["@_value"]     ?? "NaN") : null;
    const temp      = location.temperature ? parseFloat(location.temperature["@_value"] ?? "NaN") : null;

    timeSteps.push({
      time: from,
      wind_speed_ms: windSpeed && !isNaN(windSpeed) ? windSpeed : null,
      wind_gust_ms:  windGust  && !isNaN(windGust)  ? windGust  : null,
      wind_dir_deg:  windDir   && !isNaN(windDir)   ? windDir   : null,
      precip_mm:     precip    && !isNaN(precip)    ? precip    : null,
      mslp_hpa:      mslp      && !isNaN(mslp)      ? mslp      : null,
      temp_c:        temp      && !isNaN(temp)       ? temp      : null,
    });
  }
  return timeSteps;
}

function aggregateByDay(points: MetForecastPoint[]): Record<string, {
  meanWind: number | null;
  maxGust: number | null;
  windDir: number | null;
  totalPrecip: number | null;
  mslp: number | null;
  tempMax: number | null;
}> {
  const byDay: Record<string, { winds: number[]; gusts: number[]; dirs: number[]; precips: number[]; mslps: number[]; temps: number[] }> = {};
  for (const p of points) {
    const day = p.time.split("T")[0];
    if (!byDay[day]) byDay[day] = { winds: [], gusts: [], dirs: [], precips: [], mslps: [], temps: [] };
    if (p.wind_speed_ms != null) byDay[day].winds.push(p.wind_speed_ms * MS_TO_KNOTS);
    if (p.wind_gust_ms  != null) byDay[day].gusts.push(p.wind_gust_ms  * MS_TO_KNOTS);
    if (p.wind_dir_deg  != null) byDay[day].dirs.push(p.wind_dir_deg);
    if (p.precip_mm     != null) byDay[day].precips.push(p.precip_mm);
    if (p.mslp_hpa      != null) byDay[day].mslps.push(p.mslp_hpa);
    if (p.temp_c        != null) byDay[day].temps.push(p.temp_c);
  }

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const max = (arr: number[]) => arr.length ? Math.max(...arr) : null;

  const result: Record<string, { meanWind: number | null; maxGust: number | null; windDir: number | null; totalPrecip: number | null; mslp: number | null; tempMax: number | null }> = {};
  for (const [day, v] of Object.entries(byDay)) {
    result[day] = {
      meanWind: avg(v.winds),
      maxGust:  max(v.gusts),
      windDir:  avg(v.dirs),
      totalPrecip: v.precips.length ? v.precips.reduce((a, b) => a + b, 0) : null,
      mslp: avg(v.mslps),
      tempMax: max(v.temps),
    };
  }
  return result as never;
}

async function fetchMarineForecast(lat: number, lon: number): Promise<Record<string, {
  maxWave: number | null; meanPeriod: number | null; seaTemp: number | null;
  swellHeight: number | null; swellPeriod: number | null;
}>> {
  const url =
    `https://marine-api.open-meteo.com/v1/marine` +
    `?latitude=${lat}&longitude=${lon}` +
    `&hourly=wave_height,wave_period,sea_surface_temperature,swell_wave_height,swell_wave_period` +
    `&forecast_days=7`;
  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return {};
    const data = await res.json() as {
      hourly: {
        time: string[];
        wave_height: (number | null)[];
        wave_period: (number | null)[];
        sea_surface_temperature: (number | null)[];
        swell_wave_height: (number | null)[];
        swell_wave_period: (number | null)[];
      };
    };
    const byDay: Record<string, { heights: number[]; periods: number[]; temps: number[]; swellH: number[]; swellP: number[] }> = {};
    for (let i = 0; i < data.hourly.time.length; i++) {
      const day = data.hourly.time[i].split("T")[0];
      if (!byDay[day]) byDay[day] = { heights: [], periods: [], temps: [], swellH: [], swellP: [] };
      const h = data.hourly.wave_height[i];
      const p = data.hourly.wave_period[i];
      const t = data.hourly.sea_surface_temperature[i];
      const sh = data.hourly.swell_wave_height?.[i];
      const sp = data.hourly.swell_wave_period?.[i];
      if (h  != null && !isNaN(h))  byDay[day].heights.push(h);
      if (p  != null && !isNaN(p))  byDay[day].periods.push(p);
      if (t  != null && !isNaN(t))  byDay[day].temps.push(t);
      if (sh != null && !isNaN(sh)) byDay[day].swellH.push(sh);
      if (sp != null && !isNaN(sp)) byDay[day].swellP.push(sp);
    }
    const result: Record<string, { maxWave: number | null; meanPeriod: number | null; seaTemp: number | null; swellHeight: number | null; swellPeriod: number | null }> = {};
    for (const [day, v] of Object.entries(byDay)) {
      result[day] = {
        maxWave:     v.heights.length ? Math.max(...v.heights) : null,
        meanPeriod:  v.periods.length ? v.periods.reduce((a, b) => a + b, 0) / v.periods.length : null,
        seaTemp:     v.temps.length   ? v.temps.reduce((a, b) => a + b, 0) / v.temps.length : null,
        swellHeight: v.swellH.length  ? Math.max(...v.swellH)  : null,
        swellPeriod: v.swellP.length  ? Math.max(...v.swellP)  : null,
      };
    }
    return result;
  } catch { return {}; }
}

function moonDataForDay(date: Date): { illum: number; phase: number } {
  const m = getMoonIllumination(date);
  return { illum: m.fraction, phase: m.phase };
}

export function tideRangeForSlug(slug: string, phase: number): number {
  const ranges = BASE_TIDE_RANGE[slug] ?? { spring: 3.5, neap: 2.0 };
  const distFromNew  = Math.min(phase, 1 - phase);
  const distFromFull = Math.abs(phase - 0.5);
  return Math.min(distFromNew, distFromFull) < 0.12 ? ranges.spring : ranges.neap;
}

function toHHMM(date: Date): string {
  const h = String(date.getUTCHours()).padStart(2, "0");
  const m = String(date.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function buildClimMap(rows: Array<{ metric: string; n: number; coverage_start: unknown; coverage_end: unknown; ladder: unknown }>, month: number): Record<string, PercentileTable> {
  const result: Record<string, PercentileTable> = {};
  for (const row of rows) {
    const ladder = typeof row.ladder === "string" ? JSON.parse(row.ladder) : row.ladder;
    if (!Array.isArray(ladder) || ladder.length !== 101) continue;
    result[row.metric] = {
      metric: row.metric,
      month,
      n: row.n,
      coverageStart: String(row.coverage_start ?? ""),
      coverageEnd:   String(row.coverage_end ?? ""),
      ladder,
    };
  }
  return result;
}

// Neon returns DATE columns as Date objects; normalise to YYYY-MM-DD string for comparisons.
const ds = (d: string | Date | unknown): string =>
  d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

export async function getForecastDays(
  beach: { id: number; slug: string; lat: number; lon: number },
  fingerprints: Array<{ incident_id: number; date: string; title: string; type: string; severity: number; features: unknown }>,
  days = 5
): Promise<ForecastDay[]> {
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  const month = today.getMonth() + 1;

  // Fetch prior observations for the 8-row window (+ 14 for storm-legacy lookback)
  const [metPoints, waveByDay, priorObs, climRows] = await Promise.all([
    fetchMetForecast(beach.lat, beach.lon),
    fetchMarineForecast(beach.lat, beach.lon),
    getObservationWindow(beach.id, todayStr, 14) as Promise<ObsRow[]>,
    getClimatology(beach.id, month) as Promise<Array<{ metric: string; n: number; coverage_start: unknown; coverage_end: unknown; ladder: unknown }>>,
  ]);

  const metByDay = aggregateByDay(metPoints);
  const clim = buildClimMap(climRows, month);
  const hasLongSwell = Boolean(clim["swell_period_s"]);

  const fps = fingerprints.map((fp) => ({
    incidentId: fp.incident_id,
    date: ds(fp.date),
    title: fp.title,
    type: fp.type,
    severity: fp.severity,
    features: fp.features as FeatureVector,
  }));

  const baseline  = computeBaseline(fps);
  const bearing   = BEACH_BEARING[beach.slug] ?? 270;
  const result: ForecastDay[] = [];

  // Most recent tide times from DB — used as approximation when no forecast tide data
  const recentWithTides = (priorObs as Array<ObsRow & { high_tide_times?: string | null; low_tide_times?: string | null }>)
    .filter((r) => r.high_tide_times || r.low_tide_times)
    .sort((a, b) => ds(b.date).localeCompare(ds(a.date)));
  const fallbackHighTides = recentWithTides[0]?.high_tide_times ?? null;
  const fallbackLowTides  = recentWithTides[0]?.low_tide_times  ?? null;

  // Most recent sea temp from DB — sea temp changes slowly, safe proxy when marine forecast unavailable
  const fallbackSeaTemp = (priorObs as Array<ObsRow & { sea_temp_c?: number | null }>)
    .filter((r) => (r as { sea_temp_c?: number | null }).sea_temp_c != null)
    .sort((a, b) => ds(b.date).localeCompare(ds(a.date)))[0] as (ObsRow & { sea_temp_c?: number | null }) | undefined;
  const fallbackSeaTempC = fallbackSeaTemp?.sea_temp_c ?? null;

  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split("T")[0];
    const met   = metByDay[dateStr]  ?? {};
    const wave  = waveByDay[dateStr] ?? {};
    const { illum, phase } = moonDataForDay(d);
    const tideRange = tideRangeForSlug(beach.slug, phase);

    const weatherOk = met.meanWind != null || met.maxGust != null;
    const wavesOk   = wave.maxWave != null;
    const tideTimes = fallbackHighTides || fallbackLowTides;
    const swellOk   = wave.swellPeriod != null;

    const coverage: Coverage = {
      weather: weatherOk,
      waves:   wavesOk,
      tide:    Boolean(tideTimes),
      swell:   swellOk,
    };

    const sunTimes = getTimes(d, beach.lat, beach.lon);
    const daylight =
      sunTimes.sunrise instanceof Date && sunTimes.sunset instanceof Date &&
      !isNaN(sunTimes.sunrise.getTime()) && !isNaN(sunTimes.sunset.getTime())
        ? { sunrise: toHHMM(sunTimes.sunrise), sunset: toHHMM(sunTimes.sunset) }
        : undefined;

    // Build today's observation row from forecast data
    const forecastObs: ObsRow = {
      date:            dateStr,
      mean_wind_knots: met.meanWind    ?? null,
      max_gust_knots:  met.maxGust     ?? null,
      wave_height_m:   wave.maxWave    ?? null,
      wave_period_s:   wave.meanPeriod ?? null,
      sea_temp_c:      wave.seaTemp    ?? fallbackSeaTempC,
      rain_mm:         met.totalPrecip ?? null,
      mslp_hpa:        met.mslp        ?? null,
      moon_illum:      illum,
      tide_range_m:    tideRange,
      wind_dir_deg:    met.windDir     ?? null,
      temp_max_c:      met.tempMax     ?? null,
      swell_height_m:  wave.swellHeight ?? null,
      swell_period_s:  wave.swellPeriod ?? null,
      high_tide_times: fallbackHighTides,
      low_tide_times:  fallbackLowTides,
    };

    // 8-row window: up to 7 prior obs from DB + today's forecast obs
    const priorWindow: ObsRow[] = (priorObs as ObsRow[])
      .filter((r) => ds(r.date) < dateStr)
      .sort((a, b) => ds(a.date).localeCompare(ds(b.date)))
      .slice(-7);
    const fullWindow: ObsRow[] = [...priorWindow, forecastObs];

    const fv = fingerprint(fullWindow, bearing, {
      highTideTimes: fallbackHighTides,
      lowTideTimes:  fallbackLowTides,
      daylight,
    });

    // Hazard index (Stage 3)
    const components = hazardComponents(fv, fullWindow, clim, coverage, hasLongSwell);
    const hazResult  = hazardIndex(components);

    // Tier from hazard percentile; "unknown" when primary data unavailable
    let tier: Tier = "unknown";
    if (!weatherOk && !wavesOk) {
      tier = "unknown";
    } else {
      tier = tierFromPercentile(hazResult.percentile);
    }

    // Map to legacy alert level for backward compat
    const alertLevel = tier === "unknown" ? "none"
      : tier === "low" ? "none"
      : tier as "watch" | "warning" | "severe";

    // Precedent lookup — demoted to informational, no longer drives tier
    const matches = fps.length ? matchAll(fv, fps) : [];
    void baseline; // still computed to keep imports used

    result.push({
      date:          dateStr,
      wind_knots:    met.meanWind    ?? null,
      gust_knots:    met.maxGust     ?? null,
      wind_dir_deg:  met.windDir     ?? null,
      wave_height_m: wave.maxWave    ?? null,
      wave_period_s: wave.meanPeriod ?? null,
      sea_temp_c:    wave.seaTemp    ?? null,
      precip_mm:     met.totalPrecip ?? null,
      mslp_hpa:      met.mslp        ?? null,
      temp_max_c:    met.tempMax     ?? null,
      moon_illum:    illum,
      tide_range_m:  tideRange,
      tier,
      alertLevel,
      hazardScore:      hazResult.score,
      hazardComponents: components,
      hazardDriver:     hazResult.driver,
      coverage,
      topMatches:    matches.slice(0, 3),
      features:      fv,
    });
  }

  return result;
}
