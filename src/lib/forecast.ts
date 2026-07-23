import { getMoonIllumination, getTimes } from "suncalc";
import { XMLParser } from "fast-xml-parser";
import {
  fingerprint,
  matchAll,
  alertLevel,
  explain,
  baselineContrast,
  computeBaseline,
  type ObsRow,
  type ScoredMatch,
  type FeatureVector,
  type FeatureContribution,
  type BaselineDeviation,
} from "./similarity";

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
  moon_illum: number;
  tide_range_m: number;
  score: number;
  alertLevel: "none" | "watch" | "warning" | "severe";
  topMatches: ScoredMatch[];
  features: FeatureVector;
  contributions: FeatureContribution[];
  baselineContrast: BaselineDeviation[];
}

const BASE_TIDE_RANGE: Record<string, { spring: number; neap: number }> = {
  fountainstown: { spring: 3.8, neap: 2.0 },
  ballybunion:   { spring: 5.0, neap: 2.6 },
  skerries:      { spring: 3.2, neap: 1.6 },
};

const BEACH_BEARING: Record<string, number> = {
  fountainstown: 135,
  ballybunion:   270,
  skerries:      90,
};

const MS_TO_KNOTS = 1.94384;

interface MetForecastPoint {
  time: string;
  wind_speed_ms: number | null;
  wind_gust_ms: number | null;
  wind_dir_deg: number | null;
  precip_mm: number | null;
  mslp_hpa: number | null;
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

    const windSpeed = location.windSpeed ? parseFloat(location.windSpeed["@_mps"] ?? "NaN") : null;
    const windGust  = location.windGust  ? parseFloat(location.windGust["@_mps"]  ?? "NaN") : null;
    const windDir   = location.windDirection ? parseFloat(location.windDirection["@_deg"] ?? "NaN") : null;
    const precip    = location.precipitation ? parseFloat(location.precipitation["@_value"] ?? "NaN") : null;
    const mslp      = location.pressure ? parseFloat(location.pressure["@_value"] ?? "NaN") : null;

    timeSteps.push({
      time: from,
      wind_speed_ms: windSpeed && !isNaN(windSpeed) ? windSpeed : null,
      wind_gust_ms:  windGust  && !isNaN(windGust)  ? windGust  : null,
      wind_dir_deg:  windDir   && !isNaN(windDir)   ? windDir   : null,
      precip_mm:     precip    && !isNaN(precip)    ? precip    : null,
      mslp_hpa:      mslp      && !isNaN(mslp)      ? mslp      : null,
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
}> {
  const byDay: Record<string, { winds: number[]; gusts: number[]; dirs: number[]; precips: number[]; mslps: number[] }> = {};
  for (const p of points) {
    const day = p.time.split("T")[0];
    if (!byDay[day]) byDay[day] = { winds: [], gusts: [], dirs: [], precips: [], mslps: [] };
    if (p.wind_speed_ms != null) byDay[day].winds.push(p.wind_speed_ms * MS_TO_KNOTS);
    if (p.wind_gust_ms  != null) byDay[day].gusts.push(p.wind_gust_ms  * MS_TO_KNOTS);
    if (p.wind_dir_deg  != null) byDay[day].dirs.push(p.wind_dir_deg);
    if (p.precip_mm     != null) byDay[day].precips.push(p.precip_mm);
    if (p.mslp_hpa      != null) byDay[day].mslps.push(p.mslp_hpa);
  }

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const max = (arr: number[]) => arr.length ? Math.max(...arr) : null;

  const result: Record<string, {
    meanWind: number | null; maxGust: number | null; windDir: number | null; totalPrecip: number | null; mslp: number | null;
  }> = {};
  for (const [day, v] of Object.entries(byDay)) {
    result[day] = {
      meanWind: avg(v.winds),
      maxGust:  max(v.gusts),
      windDir:  avg(v.dirs),
      totalPrecip: v.precips.length ? v.precips.reduce((a, b) => a + b, 0) : null,
      mslp: avg(v.mslps),
    };
  }
  return result as never;
}

async function fetchMarineForecast(lat: number, lon: number): Promise<Record<string, { maxWave: number | null; meanPeriod: number | null; seaTemp: number | null }>> {
  const url =
    `https://marine-api.open-meteo.com/v1/marine` +
    `?latitude=${lat}&longitude=${lon}` +
    `&hourly=wave_height,wave_period,sea_surface_temperature` +
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
      };
    };
    const byDay: Record<string, { heights: number[]; periods: number[]; temps: number[] }> = {};
    for (let i = 0; i < data.hourly.time.length; i++) {
      const day = data.hourly.time[i].split("T")[0];
      if (!byDay[day]) byDay[day] = { heights: [], periods: [], temps: [] };
      const h = data.hourly.wave_height[i];
      const p = data.hourly.wave_period[i];
      const t = data.hourly.sea_surface_temperature[i];
      if (h != null && !isNaN(h)) byDay[day].heights.push(h);
      if (p != null && !isNaN(p)) byDay[day].periods.push(p);
      if (t != null && !isNaN(t)) byDay[day].temps.push(t);
    }
    const result: Record<string, { maxWave: number | null; meanPeriod: number | null; seaTemp: number | null }> = {};
    for (const [day, v] of Object.entries(byDay)) {
      result[day] = {
        maxWave:    v.heights.length ? Math.max(...v.heights) : null,
        meanPeriod: v.periods.length ? v.periods.reduce((a, b) => a + b, 0) / v.periods.length : null,
        seaTemp:    v.temps.length   ? v.temps.reduce((a, b) => a + b, 0) / v.temps.length : null,
      };
    }
    return result;
  } catch { return {}; }
}

function moonDataForDay(date: Date): { illum: number; phase: number } {
  const m = getMoonIllumination(date);
  return { illum: m.fraction, phase: m.phase };
}

function tideRangeForSlug(slug: string, phase: number): number {
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


export async function getForecastDays(
  beach: { slug: string; lat: number; lon: number },
  fingerprints: Array<{ incident_id: number; date: string; title: string; type: string; severity: number; features: unknown }>,
  days = 5
): Promise<ForecastDay[]> {
  const [metPoints, waveByDay] = await Promise.all([
    fetchMetForecast(beach.lat, beach.lon),
    fetchMarineForecast(beach.lat, beach.lon),
  ]);
  const metByDay = aggregateByDay(metPoints);

  const fps = fingerprints.map((fp) => ({
    incidentId: fp.incident_id,
    date: fp.date instanceof Date ? fp.date.toISOString().slice(0, 10) : String(fp.date).slice(0, 10),
    title: fp.title,
    type: fp.type,
    severity: fp.severity,
    features: fp.features as FeatureVector,
  }));

  const baseline = computeBaseline(fps);
  const bearing  = BEACH_BEARING[beach.slug] ?? 270;
  const result: ForecastDay[] = [];

  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split("T")[0];
    const met   = metByDay[dateStr]  ?? {};
    const wave  = waveByDay[dateStr] ?? {};
    const { illum, phase } = moonDataForDay(d);
    const tideRange = tideRangeForSlug(beach.slug, phase);

    // Compute daylight window for tide-state prior estimation on forecast days
    const sunTimes = getTimes(d, beach.lat, beach.lon);
    const daylight =
      sunTimes.sunrise instanceof Date && sunTimes.sunset instanceof Date &&
      !isNaN(sunTimes.sunrise.getTime()) && !isNaN(sunTimes.sunset.getTime())
        ? { sunrise: toHHMM(sunTimes.sunrise), sunset: toHHMM(sunTimes.sunset) }
        : undefined;

    const obs: ObsRow = {
      date:            dateStr,
      mean_wind_knots: met.meanWind   ?? null,
      max_gust_knots:  met.maxGust    ?? null,
      wave_height_m:   wave.maxWave   ?? null,
      wave_period_s:   wave.meanPeriod ?? null,
      sea_temp_c:      wave.seaTemp   ?? null,
      rain_mm:         met.totalPrecip ?? null,
      mslp_hpa:        met.mslp       ?? null,
      moon_illum:      illum,
      tide_range_m:    tideRange,
      wind_dir_deg:    met.windDir    ?? null,
    };

    // Forecast doesn't have actual tide times; tideConfidence will be 0 unless
    // we have at least a daylight window (0.5).
    const fv = fingerprint([obs], bearing, { daylight });
    const matches = matchAll(fv, fps);
    const topScore = matches[0]?.score ?? 0;
    const topFp = fps.find((fp) => fp.incidentId === matches[0]?.incidentId);

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
      moon_illum:    illum,
      tide_range_m:  tideRange,
      score:         topScore,
      alertLevel:    alertLevel(topScore),
      topMatches:    matches.slice(0, 3),
      features:      fv,
      contributions:    topFp ? explain(fv, topFp.features) : [],
      baselineContrast: baselineContrast(fv, baseline, topFp?.features),
    });
  }

  return result;
}
