import { NextRequest, NextResponse } from "next/server";
import { getBeachBySlug, getAllFingerprints } from "@/db/queries";
import { getForecastDays } from "@/lib/forecast";

export const revalidate = 3600;

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("beach") ?? "fountainstown";

  try {
    const beach = await getBeachBySlug(slug);
    if (!beach) {
      return NextResponse.json({ error: "Beach not found" }, { status: 404 });
    }

    const fingerprints = await getAllFingerprints(beach.id);
    const days = await getForecastDays(
      { slug: beach.slug, lat: beach.lat, lon: beach.lon },
      fingerprints as never
    );

    return NextResponse.json({ beach: slug, days });
  } catch (e) {
    console.error("/api/alerts error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
