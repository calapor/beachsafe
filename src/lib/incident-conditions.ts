import "server-only";

export interface HourlyConditions {
  time: string[];
  wind_kn: (number | null)[];
  gust_kn: (number | null)[];
  wind_dir_deg: (number | null)[];
  mslp_hpa: (number | null)[];
  wave_m: (number | null)[];
  wave_period_s: (number | null)[];
  swell_m: (number | null)[];
  swell_period_s: (number | null)[];
  wind_wave_m: (number | null)[];
}

export interface AtTimeConditions {
  time: string;
  wind_kn: number | null;
  gust_kn: number | null;
  wind_dir_deg: number | null;
  mslp_hpa: number | null;
  wave_m: number | null;
  wave_period_s: number | null;
  swell_m: number | null;
  swell_period_s: number | null;
  wind_wave_m: number | null;
}

async function fetchEra5(lat: number, lon: number, isoDate: string): Promise<{
  time: string[];
  wind_kn: (number | null)[];
  gust_kn: (number | null)[];
  wind_dir_deg: (number | null)[];
  mslp_hpa: (number | null)[];
} | null> {
  const url =
    `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${lat}&longitude=${lon}` +
    `&start_date=${isoDate}&end_date=${isoDate}` +
    `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,pressure_msl` +
    `&wind_speed_unit=kn&timezone=UTC`;
  try {
    const res = await fetch(url, { next: { revalidate: 86400 } });
    if (!res.ok) return null;
    const data = await res.json() as {
      hourly: {
        time: string[];
        wind_speed_10m: (number | null)[];
        wind_gusts_10m: (number | null)[];
        wind_direction_10m: (number | null)[];
        pressure_msl: (number | null)[];
      };
    };
    const h = data.hourly;
    return {
      time: h.time,
      wind_kn: h.wind_speed_10m,
      gust_kn: h.wind_gusts_10m,
      wind_dir_deg: h.wind_direction_10m,
      mslp_hpa: h.pressure_msl,
    };
  } catch { return null; }
}

async function fetchMarineHourly(lat: number, lon: number, isoDate: string): Promise<{
  wave_m: (number | null)[];
  wave_period_s: (number | null)[];
  swell_m: (number | null)[];
  swell_period_s: (number | null)[];
  wind_wave_m: (number | null)[];
} | null> {
  const url =
    `https://marine-api.open-meteo.com/v1/marine` +
    `?latitude=${lat}&longitude=${lon}` +
    `&start_date=${isoDate}&end_date=${isoDate}` +
    `&hourly=wave_height,wave_period,swell_wave_height,swell_wave_period,wind_wave_height` +
    `&timezone=UTC`;
  try {
    const res = await fetch(url, { next: { revalidate: 86400 } });
    if (!res.ok) return null;
    const data = await res.json() as {
      hourly: {
        wave_height: (number | null)[];
        wave_period: (number | null)[];
        swell_wave_height: (number | null)[];
        swell_wave_period: (number | null)[];
        wind_wave_height: (number | null)[];
      };
    };
    const h = data.hourly;
    return {
      wave_m: h.wave_height,
      wave_period_s: h.wave_period,
      swell_m: h.swell_wave_height,
      swell_period_s: h.swell_wave_period,
      wind_wave_m: h.wind_wave_height,
    };
  } catch { return null; }
}

export async function fetchHourlyConditions(
  lat: number,
  lon: number,
  isoDate: string
): Promise<HourlyConditions | null> {
  const [era5, marine] = await Promise.all([
    fetchEra5(lat, lon, isoDate),
    fetchMarineHourly(lat, lon, isoDate),
  ]);
  if (!era5) return null;
  const n = era5.time.length;
  return {
    time: era5.time,
    wind_kn: era5.wind_kn,
    gust_kn: era5.gust_kn,
    wind_dir_deg: era5.wind_dir_deg,
    mslp_hpa: era5.mslp_hpa,
    wave_m: marine?.wave_m ?? Array(n).fill(null),
    wave_period_s: marine?.wave_period_s ?? Array(n).fill(null),
    swell_m: marine?.swell_m ?? Array(n).fill(null),
    swell_period_s: marine?.swell_period_s ?? Array(n).fill(null),
    wind_wave_m: marine?.wind_wave_m ?? Array(n).fill(null),
  };
}

export function pickAtAndBefore(
  hourly: HourlyConditions,
  timeHHMM: string,
  minutesBefore = 60
): { atTime: AtTimeConditions; window: AtTimeConditions[] } | null {
  if (!hourly.time.length) return null;
  const parts = timeHHMM.split(":");
  const tMins = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  if (isNaN(tMins)) return null;

  const row = (idx: number): AtTimeConditions => ({
    time: hourly.time[idx].slice(11, 16),
    wind_kn: hourly.wind_kn[idx] ?? null,
    gust_kn: hourly.gust_kn[idx] ?? null,
    wind_dir_deg: hourly.wind_dir_deg[idx] ?? null,
    mslp_hpa: hourly.mslp_hpa[idx] ?? null,
    wave_m: hourly.wave_m[idx] ?? null,
    wave_period_s: hourly.wave_period_s[idx] ?? null,
    swell_m: hourly.swell_m[idx] ?? null,
    swell_period_s: hourly.swell_period_s[idx] ?? null,
    wind_wave_m: hourly.wind_wave_m[idx] ?? null,
  });

  const nearestIdx = Math.min(Math.round(tMins / 60), hourly.time.length - 1);
  const windowStartMins = tMins - minutesBefore;

  const windowRows: AtTimeConditions[] = [];
  for (let i = 0; i < hourly.time.length; i++) {
    const iMins = i * 60;
    if (iMins >= windowStartMins && iMins <= tMins) {
      windowRows.push(row(i));
    }
  }

  return { atTime: row(nearestIdx), window: windowRows };
}
