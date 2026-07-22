import Link from "next/link";
import { notFound } from "next/navigation";
import { getBeachBySlug, getIncidentsByBeach, getRecentObservations, getAllFingerprints } from "@/db/queries";
import { AlertBadge } from "@/components/alert-badge";
import { MoonGlyph } from "@/components/moon-glyph";
import { ConditionsChart } from "@/components/conditions-chart";
import { WhyFlaggedPanel } from "@/components/why-flagged-panel";
import { getForecastDays } from "@/lib/forecast";
import { FEATURE_LABELS } from "@/lib/feature-labels";
import type { ForecastDay } from "@/lib/forecast";
import type { FeatureVector } from "@/lib/similarity";

export const revalidate = 3600;

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

const ALERT_REASON: Record<string, string> = {
  none:    "No significant similarity to past incidents",
  watch:   "Some similarity to past dangerous conditions",
  warning: "Conditions closely resemble past incidents",
  severe:  "Very high match to past dangerous incidents",
};

function describeFeatures(fv: FeatureVector): string[] {
  const reasons: string[] = [];

  if (fv.onshoreComponent > 0.7)
    reasons.push(FEATURE_LABELS.onshoreComponent.label + ": direct");
  else if (fv.onshoreComponent > 0.35)
    reasons.push(FEATURE_LABELS.onshoreComponent.label + ": partial");

  if (fv.maxWave > 0.5)
    reasons.push(`Heavy swell (${FEATURE_LABELS.maxWave.format(fv.maxWave)})`);
  else if (fv.maxWave > 0.2)
    reasons.push(`Moderate swell (${FEATURE_LABELS.maxWave.format(fv.maxWave)})`);

  if (fv.tideState < -0.5)
    reasons.push("Ebbing tide (rip current risk)");
  else if (fv.tideState > 0.5)
    reasons.push("Flooding tide");

  if (fv.tideRange > 0.65)
    reasons.push(`Spring tides (${FEATURE_LABELS.tideRange.format(fv.tideRange)} range)`);
  else if (fv.tideRange > 0.35)
    reasons.push(`Moderate tidal range (${FEATURE_LABELS.tideRange.format(fv.tideRange)})`);

  if (fv.pressureDrop > 0.4)
    reasons.push(`Rapid pressure drop (${FEATURE_LABELS.pressureDrop.format(fv.pressureDrop)})`);
  else if (fv.pressureDrop > 0.17)
    reasons.push(`Falling pressure (${FEATURE_LABELS.pressureDrop.format(fv.pressureDrop)})`);

  if (fv.maxGust > 0.5)
    reasons.push(`Strong gusts (${FEATURE_LABELS.maxGust.format(fv.maxGust)})`);
  else if (fv.maxGust > 0.28)
    reasons.push(`Moderate gusts (${FEATURE_LABELS.maxGust.format(fv.maxGust)})`);

  if (fv.meanWind > 0.5)
    reasons.push(`Sustained high winds (${FEATURE_LABELS.meanWind.format(fv.meanWind)})`);
  else if (fv.meanWind > 0.3)
    reasons.push(`Elevated winds (${FEATURE_LABELS.meanWind.format(fv.meanWind)})`);

  if (fv.wavePeriod > 0.5)
    reasons.push(`Long-period swell (${FEATURE_LABELS.wavePeriod.format(fv.wavePeriod)})`);

  if (fv.seaTempCold > 0.4)
    reasons.push("Cold water shock risk");

  return reasons;
}

function ForecastStrip({ days }: { days: ForecastDay[] }) {
  return (
    <div className="grid grid-cols-5 gap-2 overflow-visible">
      {days.map((d) => {
        const driverList = describeFeatures(d.features);
        return (
          <div key={d.date} className="relative group bg-white border border-gray-200 rounded-xl p-3 flex flex-col gap-2 items-center text-center">
            <p className="text-xs font-semibold text-gray-500">{d.date.slice(5)}</p>
            <AlertBadge level={d.alertLevel} size="sm" />
            {d.wind_knots != null && (
              <p className="text-xs text-gray-600">{d.wind_knots.toFixed(0)} kts</p>
            )}
            {d.wave_height_m != null && (
              <p className="text-xs text-gray-500">{d.wave_height_m.toFixed(1)} m 🌊</p>
            )}
            <p className="text-xs text-gray-400">{(d.moon_illum * 100).toFixed(0)}% 🌕</p>

            {/* Hover tooltip */}
            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 bg-gray-900 text-white text-xs rounded-lg p-3 opacity-0 group-hover:opacity-100 transition-opacity z-20 text-left shadow-lg">
              <p className="font-semibold mb-1">{ALERT_REASON[d.alertLevel]}</p>
              <p className="text-gray-400 mb-2">{(d.score * 100).toFixed(0)}% similarity to historical incidents</p>

              {driverList.length > 0 && (
                <div className="mb-2">
                  <p className="text-gray-500 uppercase tracking-wide text-[10px] mb-1">Contributing factors</p>
                  <ul className="space-y-0.5">
                    {driverList.map((r) => (
                      <li key={r} className="flex items-start gap-1 text-gray-300">
                        <span className="text-orange-400 mt-px">›</span>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {d.topMatches.length > 0 && (
                <div className="border-t border-gray-700 pt-2">
                  <p className="text-gray-500 uppercase tracking-wide text-[10px] mb-1">Closest historical matches</p>
                  {d.topMatches.slice(0, 2).map((m) => (
                    <p key={m.incidentId} className="text-gray-300 truncate">
                      {(m.score * 100).toFixed(0)}% — {m.title}
                    </p>
                  ))}
                </div>
              )}

              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default async function BeachPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const beach = await getBeachBySlug(slug) as { id: number; slug: string; name: string; county: string; lat: number; lon: number; notes: string } | null;
  if (!beach) notFound();

  const [incidents, recentObs, fingerprints] = await Promise.all([
    getIncidentsByBeach(beach.id),
    getRecentObservations(beach.id, 30),
    getAllFingerprints(beach.id),
  ]);

  let forecastDays: ForecastDay[] = [];
  try {
    forecastDays = await getForecastDays(
      { slug: beach.slug, lat: beach.lat, lon: beach.lon },
      fingerprints as never,
      5
    );
  } catch {
    // forecast unavailable
  }

  const todayAlert = forecastDays[0]?.alertLevel ?? "none";
  const today = forecastDays[0];

  const chartData = (recentObs as Array<{ date: string; mean_wind_knots?: number | null; wave_height_m?: number | null; rain_mm?: number | null }>)
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
        {/* Current alert */}
        <section className="bg-white rounded-2xl border border-gray-200 p-6 flex items-center gap-4">
          <div className="flex-1">
            <h2 className="font-semibold text-gray-900 mb-1">Today's alert level</h2>
            <p className="text-sm text-gray-500">Based on current forecast vs historical incident fingerprints</p>
          </div>
          <AlertBadge level={todayAlert} size="lg" />
        </section>

        {/* Persistent "Why is this flagged?" panel */}
        {today && today.topMatches[0] && (
          <WhyFlaggedPanel
            slug={slug}
            contributions={today.contributions}
            contrast={today.baselineContrast}
            topMatch={today.topMatches[0]}
          />
        )}

        {/* 5-day forecast strip */}
        {forecastDays.length > 0 && (
          <section>
            <h2 className="font-semibold text-gray-900 mb-3">5-day forecast</h2>
            <ForecastStrip days={forecastDays} />
            {forecastDays[0]?.topMatches[0] && (
              <p className="text-xs text-gray-500 mt-2">
                Closest historical match:{" "}
                <Link
                  href={`/beach/${slug}/incident/${forecastDays[0].topMatches[0].incidentId}`}
                  className="text-blue-600 hover:underline"
                >
                  {forecastDays[0].topMatches[0].title}
                </Link>{" "}
                ({(forecastDays[0].topMatches[0].score * 100).toFixed(0)}% similarity)
              </p>
            )}
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
            Incident history ({(incidents as unknown[]).length} records)
          </h2>
          {(incidents as unknown[]).length === 0 ? (
            <p className="text-sm text-gray-500">No incidents loaded yet — run <code className="bg-gray-100 px-1 rounded text-xs">pnpm etl</code></p>
          ) : (
            <div className="space-y-3">
              {(incidents as Array<{ id: number; date: string; type: string; title: string; description: string; severity: number; casualties: number; source_url: string; activity?: string; time_of_day?: string }>)
                .map((inc) => (
                  <Link
                    key={inc.id}
                    href={`/beach/${slug}/incident/${inc.id}`}
                    className="flex gap-4 bg-white border border-gray-200 rounded-xl p-4 hover:border-blue-400 hover:shadow-sm transition-all"
                  >
                    <div className="flex-shrink-0 w-16 text-center">
                      <p className="text-xs font-mono text-gray-400">{(inc.date instanceof Date ? inc.date.toISOString() : String(inc.date)).slice(0, 10)}</p>
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
