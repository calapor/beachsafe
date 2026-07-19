import { getMoonIllumination } from "suncalc";
import { XMLParser } from "fast-xml-parser";
import { fingerprint, matchAll, alertLevel, type ObsRow, type ScoredMatch } from "./similarity";

export interface ForecastDay {
  date: string;
  wind_knots: number | null;
  gust_knots: number | null;
  wind_dir_deg: number | null;
  wave_height_m: number | null;
  wave_period_s: number | null;
  precip_mm: number | null;
  mslp_hpa: number | null;
  moon_illum: number;
  tide_range_m: number;
  score: number;
  alertLevel: "none" | "watch" | "warning" | "severe";
  topMatches: ScoredMatch[];
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

// ms/s → knots
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
    const windGust = location.windGust ? parseFloat(location.windGust["@_mps"] ?? "NaN") : null;
    const windDir = location.windDirection ? parseFloat(location.windDirection["@_deg"] ?? "NaN") : null;
    const precip = location.precipitation ? parseFloat(location.precipitation["@_value"] ?? "NaN") : null;
    const mslp = location.pressure ? parseFloat(location.pressure["@_value"] ?? "NaN") : null;

    timeSteps.push({
      time: from,
      wind_speed_ms: windSpeed && !isNaN(windSpeed) ? windSpeed : null,
      wind_gust_ms: windGust && !isNaN(windGust) ? windGust : null,
      wind_dir_deg: windDir && !isNaN(windDir) ? windDir : null,
      precip_mm: precip && !isNaN(precip) ? precip : null,
      mslp_hpa: mslp && !isNaN(mslp) ? mslp : null,
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
    if (p.wind_gust_ms != null) byDay[day].gusts.push(p.wind_gust_ms * MS_TO_KNOTS);
    if (p.wind_dir_deg != null) byDay[day].dirs.push(p.wind_dir_deg);
    if (p.precip_mm != null) byDay[day].precips.push(p.precip_mm);
    if (p.mslp_hpa != null) byDay[day].mslps.push(p.mslp_hpa);
  }

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const max = (arr: number[]) => arr.length ? Math.max(...arr) : null;

  const result: Record<string, ReturnType<typeof Object.values<typeof byDay>>[number] extends never ? never : {
    meanWind: number | null; maxGust: number | null; windDir: number | null; totalPrecip: number | null; mslp: number | null;
  }> = {};
  for (const [day, v] of Object.entries(byDay)) {
    result[day] = {
      meanWind: avg(v.winds),
      maxGust: max(v.gusts),
      windDir: avg(v.dirs),
      totalPrecip: v.precips.length ? v.precips.reduce((a, b) => a + b, 0) : null,
      mslp: avg(v.mslps),
    };
  }
  return result as never;
}

function moonDataForDay(date: Date): { illum: number; phase: number } {
  const m = getMoonIllumination(date);
  return { illum: m.fraction, phase: m.phase };
}

function tideRangeForSlug(slug: string, phase: number): number {
  const ranges = BASE_TIDE_RANGE[slug] ?? { spring: 3.5, neap: 2.0 };
  const dist = Math.min(phase, 1 - phase);
  return dist < 0.12 ? ranges.spring : ranges.neap;
}

export async function getForecastDays(
  beach: { slug: string; lat: number; lon: number },
  fingerprints: Array<{ incident_id: number; date: string; title: string; type: string; severity: number; features: unknown }>,
  days = 5
): Promise<ForecastDay[]> {
  const metPoints = await fetchMetForecast(beach.lat, beach.lon);
  const metByDay = aggregateByDay(metPoints);

  const fps = fingerprints.map((fp) => ({
    incidentId: fp.incident_id,
    date: typeof fp.date === "string" ? fp.date : String(fp.date),
    title: fp.title,
    type: fp.type,
    severity: fp.severity,
    features: fp.features as ReturnType<typeof import("./similarity").normalizeFeatures>,
  }));

  const bearing = BEACH_BEARING[beach.slug] ?? 270;
  const result: ForecastDay[] = [];

  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split("T")[0];
    const met = metByDay[dateStr] ?? {};
    const { illum, phase } = moonDataForDay(d);
    const tideRange = tideRangeForSlug(beach.slug, phase);

    // Build a synthetic observation window (just the one day — we don't have past observations in forecast)
    const obs: ObsRow = {
      date: dateStr,
      mean_wind_knots: met.meanWind ?? null,
      max_gust_knots: met.maxGust ?? null,
      wave_height_m: null,
      rain_mm: met.totalPrecip ?? null,
      mslp_hpa: met.mslp ?? null,
      moon_illum: illum,
      tide_range_m: tideRange,
      wind_dir_deg: met.windDir ?? null,
    };

    const fv = fingerprint([obs], bearing);
    const matches = matchAll(fv, fps);
    const topScore = matches[0]?.score ?? 0;

    result.push({
      date: dateStr,
      wind_knots: met.meanWind ?? null,
      gust_knots: met.maxGust ?? null,
      wind_dir_deg: met.windDir ?? null,
      wave_height_m: null,
      wave_period_s: null,
      precip_mm: met.totalPrecip ?? null,
      mslp_hpa: met.mslp ?? null,
      moon_illum: illum,
      tide_range_m: tideRange,
      score: topScore,
      alertLevel: alertLevel(topScore),
      topMatches: matches.slice(0, 3),
    });
  }

  return result;
}
