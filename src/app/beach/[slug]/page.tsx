import Link from "next/link";
import { notFound } from "next/navigation";
import { getBeachBySlug, getIncidentsByBeach, getRecentObservations, getAllFingerprints } from "@/db/queries";
import { AlertBadge } from "@/components/alert-badge";
import { ConditionsChart } from "@/components/conditions-chart";
import { RiskEvidencePanel } from "@/components/risk-evidence-panel";
import { getForecastDays } from "@/lib/forecast";
import type { ForecastDay } from "@/lib/forecast";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  rnli_launch: "RNLI Launch",
  drowning:    "Drowning",
  rescue:      "Rescue",
  near_miss:   "Near Miss",
};

const TYPE_COLOR: Record<string, string> = {
  rnli_launch: "bg-blue-100 text-blue-800",
  drowning:    "bg-red-100 text-red-800",
  rescue:      "bg-orange-100 text-orange-800",
  near_miss:   "bg-yellow-100 text-yellow-800",
};

function ForecastStrip({ days }: { days: ForecastDay[] }) {
  return (
    <div className="grid grid-cols-5 gap-2">
      {days.map((d) => (
        <div key={d.date} className="bg-white border border-gray-200 rounded-xl p-3 flex flex-col gap-2 items-center text-center">
          <p className="text-xs font-semibold text-gray-500">{d.date.slice(5)}</p>
          <AlertBadge level={d.tier === "unknown" ? "unknown" : d.alertLevel} size="sm" />
          {d.wind_knots != null && (
            <p className="text-xs text-gray-600">{d.wind_knots.toFixed(0)} kts</p>
          )}
          {d.wave_height_m != null && (
            <p className="text-xs text-gray-500">{d.wave_height_m.toFixed(1)} m</p>
          )}
          {d.tier === "unknown" && (
            <p className="text-[10px] text-gray-400">No forecast data</p>
          )}
          {d.hazardDriver && d.tier !== "unknown" && d.tier !== "low" && (
            <p className="text-[10px] text-gray-500 truncate w-full">{d.hazardDriver.key}</p>
          )}
        </div>
      ))}
    </div>
  );
}

export default async function BeachPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const beach = await getBeachBySlug(slug) as {
    id: number; slug: string; name: string; county: string;
    lat: number; lon: number; notes: string;
  } | null;
  if (!beach) notFound();

  const [incidents, recentObs, fingerprints] = await Promise.all([
    getIncidentsByBeach(beach.id),
    getRecentObservations(beach.id, 30),
    getAllFingerprints(beach.id),
  ]);

  let forecastDays: ForecastDay[] = [];
  try {
    forecastDays = await getForecastDays(
      { id: beach.id, slug: beach.slug, lat: beach.lat, lon: beach.lon },
      fingerprints as never,
      5
    );
  } catch {
    // forecast unavailable
  }

  const today = forecastDays[0];
  const todayLevel = today?.tier === "unknown" ? "unknown" : (today?.alertLevel ?? "none");

  const chartData = (recentObs as Array<{
    date: string; mean_wind_knots?: number | null; wave_height_m?: number | null; rain_mm?: number | null;
  }>)
    .slice()
    .reverse()
    .map((r) => ({
      date: (r.date instanceof Date ? r.date.toISOString() : String(r.date)).slice(0, 10),
      wind: r.mean_wind_knots ?? null,
      wave: r.wave_height_m ?? null,
      rain: r.rain_mm ?? null,
    }));

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gradient-to-r from-blue-900 to-blue-700 text-white py-8 px-6">
        <div className="max-w-4xl mx-auto">
          <Link href="/" className="text-blue-300 hover:text-white text-sm mb-3 inline-block">← All beaches</Link>
          <h1 className="text-3xl font-bold">{beach.name}</h1>
          <p className="text-blue-200">{beach.county}</p>
          {beach.notes && <p className="text-blue-300 text-sm mt-1">{beach.notes}</p>}
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-8 space-y-8">
        {/* Today's alert */}
        <section className="bg-white rounded-2xl border border-gray-200 p-6 flex items-center gap-4">
          <div className="flex-1">
            <h2 className="font-semibold text-gray-900 mb-1">Today&apos;s alert level</h2>
            <p className="text-sm text-gray-500">
              {todayLevel === "unknown"
                ? "Forecast data unavailable — cannot compute risk."
                : "Calibrated against historical conditions for this beach and month."}
            </p>
          </div>
          <AlertBadge level={todayLevel} size="lg" showFreq />
        </section>

        {/* Risk evidence panel */}
        {today && (
          <RiskEvidencePanel
            slug={slug}
            driver={today.hazardDriver}
            components={today.hazardComponents}
            coverage={today.coverage}
            topMatches={today.topMatches}
            isCalm={today.tier === "low" || today.tier === "unknown"}
          />
        )}

        {/* 5-day forecast */}
        {forecastDays.length > 0 && (
          <section>
            <h2 className="font-semibold text-gray-900 mb-3">5-day forecast</h2>
            <ForecastStrip days={forecastDays} />
          </section>
        )}

        {/* Recent conditions chart */}
        {chartData.length > 0 && (
          <section className="bg-white rounded-2xl border border-gray-200 p-6">
            <h2 className="font-semibold text-gray-900 mb-4">Recent conditions (30 days)</h2>
            <ConditionsChart data={chartData} />
          </section>
        )}

        {/* Incident timeline */}
        <section>
          <h2 className="font-semibold text-gray-900 mb-4">
            Incident history ({(incidents as unknown[]).length} swimmer/shore records)
          </h2>
          {(incidents as unknown[]).length === 0 ? (
            <p className="text-sm text-gray-500">
              No swimmer/shore incidents loaded yet — run <code className="bg-gray-100 px-1 rounded text-xs">pnpm etl</code>
            </p>
          ) : (
            <div className="space-y-3">
              {(incidents as Array<{
                id: number; date: string; type: string; title: string;
                description: string; severity: number; casualties: number;
                source_url: string; activity?: string; time_of_day?: string;
              }>).map((inc) => (
                <Link
                  key={inc.id}
                  href={`/beach/${slug}/incident/${inc.id}`}
                  className="flex gap-4 bg-white border border-gray-200 rounded-xl p-4 hover:border-blue-400 hover:shadow-sm transition-all"
                >
                  <div className="flex-shrink-0 w-16 text-center">
                    <p className="text-xs font-mono text-gray-400">
                      {(inc.date instanceof Date ? inc.date.toISOString() : String(inc.date)).slice(0, 10)}
                    </p>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${TYPE_COLOR[inc.type] ?? "bg-gray-100 text-gray-700"}`}>
                        {TYPE_LABEL[inc.type] ?? inc.type}
                      </span>
                      {inc.activity && inc.activity !== "unknown" && (
                        <span className="text-xs text-gray-500 px-2 py-0.5 rounded-full bg-gray-100">
                          {inc.activity}
                        </span>
                      )}
                      {inc.casualties > 0 && (
                        <span className="text-xs text-red-600 font-medium">
                          {inc.casualties} casualt{inc.casualties === 1 ? "y" : "ies"}
                        </span>
                      )}
                    </div>
                    <p className="font-medium text-gray-900 text-sm">{inc.title}</p>
                    {inc.description && (
                      <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{inc.description}</p>
                    )}
                  </div>
                  <div className="text-gray-400 flex-shrink-0 self-center">→</div>
                </Link>
              ))}
            </div>
          )}
        </section>

        <div className="text-sm">
          <Link href="/methodology" className="text-blue-600 hover:underline">Methodology & data sources →</Link>
        </div>
      </main>
    </div>
  );
}
