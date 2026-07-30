import { NextRequest, NextResponse } from "next/server";
import { getBeachBySlug, getAllFingerprints } from "@/db/queries";
import { getForecastDays } from "@/lib/forecast";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("beach") ?? "fountainstown";

  try {
    const beach = await getBeachBySlug(slug) as { id: number; slug: string; lat: number; lon: number } | null;
    if (!beach) {
      return NextResponse.json({ error: "Beach not found" }, { status: 404 });
    }

    const fingerprints = await getAllFingerprints(beach.id);
    const days = await getForecastDays(
      { id: beach.id, slug: beach.slug, lat: beach.lat, lon: beach.lon },
      fingerprints as never
    );

    // Extended response including hazard, exposure, combined, coverage, driver (backward-compatible)
    const response = {
      beach: slug,
      days: days.map((d) => ({
        date:            d.date,
        tier:            d.tier,
        alertLevel:      d.alertLevel,       // legacy compat
        combined:        d.combinedScore,
        hazard:          d.hazardScore,
        exposure:        d.exposureScore,
        exposureDrivers: d.exposureDrivers,
        driver:          d.hazardDriver?.key ?? null,
        driverMechanism: d.hazardDriver?.mechanism ?? null,
        coverage:        d.coverage,
        components:      d.hazardComponents.map((c) => ({
          key:        c.key,
          score:      c.score,
          percentile: c.percentile,
          evidence:   c.evidence,
        })),
        wind_knots:    d.wind_knots,
        gust_knots:    d.gust_knots,
        wave_height_m: d.wave_height_m,
        wave_period_s: d.wave_period_s,
        sea_temp_c:    d.sea_temp_c,
        temp_max_c:    d.temp_max_c,
        moon_illum:    d.moon_illum,
        tide_range_m:  d.tide_range_m,
        topMatches:    d.topMatches,
      })),
    };

    return NextResponse.json(response);
  } catch (e) {
    console.error("/api/alerts error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
