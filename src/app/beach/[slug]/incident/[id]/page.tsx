import Link from "next/link";
import { notFound } from "next/navigation";
import { getIncidentById, getObservationWindow, getAllFingerprints, getAnnualObservations } from "@/db/queries";
import { MoonGlyph } from "@/components/moon-glyph";
import { ConditionsChart } from "@/components/conditions-chart";
import { IncidentVerdict } from "@/components/incident-verdict";
import { ConditionsAtTime } from "@/components/conditions-at-time";
import {
  fingerprint,
  matchAll,
  baselineContrast,
  computeBaseline,
  describeTideAt,
  tideTrajectory,
  type FeatureVector,
} from "@/lib/similarity";
import { fetchHourlyConditions, pickAtAndBefore } from "@/lib/incident-conditions";
import { FEATURE_LABELS } from "@/lib/feature-labels";
import { getHistoricalHazard, type HistoricalHazardResult } from "@/lib/historical-hazard";
import { AlertBadge } from "@/components/alert-badge";
import type { Level } from "@/components/alert-badge";

export const dynamic = "force-dynamic";

const BEACH_BEARING: Record<string, number> = {
  fountainstown: 135,
  ballybunion:   270,
  skerries:      90,
};

const TYPE_COLOR: Record<string, string> = {
  rnli_launch: "bg-blue-100 text-blue-800",
  drowning:    "bg-red-100 text-red-800",
  rescue:      "bg-orange-100 text-orange-800",
  near_miss:   "bg-yellow-100 text-yellow-800",
};

function RetroHazardCard({ result, beachName, date }: {
  result: HistoricalHazardResult;
  beachName: string;
  date: string;
}) {
  const tierAsLevel = result.tier as Level;
  const isScored = result.tier !== "unknown";

  return (
    <section className="bg-white rounded-2xl border border-gray-200 p-6">
      <h2 className="font-semibold text-gray-900 mb-1">What would BeachSafe have predicted?</h2>
      <p className="text-xs text-gray-500 mb-4">
        Retrospective score using observed conditions for {beachName} on {date}, calibrated against historical norms.
      </p>
      {isScored ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <AlertBadge level={tierAsLevel} size="lg" showFreq />
            {!result.waveDataAvailable && (
              <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                Weather signals only — wave buoy data not available for this era
              </span>
            )}
          </div>
          {result.percentile != null && (
            <p className="text-xs text-gray-400">
              Hazard percentile: {(result.percentile * 100).toFixed(0)}th — worse than {(result.percentile * 100).toFixed(0)}% of days at this beach in this month.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-gray-500 italic">
          Insufficient data — BeachSafe could not have scored this day.
        </p>
      )}
    </section>
  );
}

function ConditionRow({ label, value, unit }: { label: string; value: string | number | null; unit?: string }) {
  return (
    <div className="flex justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className="text-sm font-medium text-gray-900">
        {value == null ? "—" : `${value}${unit ? ` ${unit}` : ""}`}
      </span>
    </div>
  );
}

export default async function IncidentPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const incidentId = parseInt(id, 10);
  if (isNaN(incidentId)) notFound();

  const incident = await getIncidentById(incidentId) as {
    id: number; beach_id: number; date: string; type: string; severity: number; casualties: number;
    title: string; description: string; source_url: string; source_type: string;
    features: unknown; beach_slug: string; beach_name: string; lat: number; lon: number;
    time_of_day?: string | null; time_source?: string | null;
    activity?: string | null; condition_related?: boolean | null;
  } | null;
  if (!incident) notFound();

  const isoDate = incident.date instanceof Date
    ? incident.date.toISOString().slice(0, 10)
    : String(incident.date).slice(0, 10);
  const bearing = BEACH_BEARING[incident.beach_slug] ?? 270;
  const timeLabel = incident.time_of_day ? String(incident.time_of_day).slice(0, 5) : null;

  const [window7, allFps, annualObsRaw] = await Promise.all([
    getObservationWindow(incident.beach_id, isoDate, 8),
    getAllFingerprints(incident.beach_id),
    getAnnualObservations(incident.beach_id),
  ]);

  let retroHazard: HistoricalHazardResult | null = null;
  try {
    retroHazard = await getHistoricalHazard(
      { id: incident.beach_id, slug: incident.beach_slug },
      isoDate,
    );
  } catch (e) { console.error("[RetroHazard]", e); }

  const annualObs = (annualObsRaw as Array<{
    date: string;
    wave_height_m?: number | null;
    moon_illum?: number | null;
    tide_range_m?: number | null;
    max_gust_knots?: number | null;
  }>);

  const obs7 = window7 as Array<{
    date: string; mean_wind_knots?: number | null; max_gust_knots?: number | null;
    wave_height_m?: number | null; wave_period_s?: number | null; rain_mm?: number | null;
    mslp_hpa?: number | null; moon_illum?: number | null; tide_range_m?: number | null;
    wind_dir_deg?: number | null; sea_temp_c?: number | null;
    high_tide_times?: string | null; low_tide_times?: string | null;
  }>;

  const dayOf = obs7.find((r) => (r.date instanceof Date ? r.date.toISOString() : String(r.date)).slice(0, 10) === isoDate) ?? obs7[obs7.length - 1];

  // Use stored fingerprint if available; recompute with time opts if not.
  const storedFeatures = incident.features as FeatureVector | null;
  const fv: FeatureVector = storedFeatures ?? fingerprint(obs7 as never, bearing, {
    timeOfDay: incident.time_of_day ?? null,
    highTideTimes: dayOf?.high_tide_times ?? null,
    lowTideTimes: dayOf?.low_tide_times ?? null,
  });

  // Baseline from all beach fingerprints
  const allFpsMapped = (allFps as Array<{ incident_id: number; date: string; title: string; type: string; severity: number; features: unknown }>)
    .map((fp) => ({ features: fp.features as FeatureVector }));
  const baseline = computeBaseline(allFpsMapped);
  const contrast = baselineContrast(fv, baseline);

  // Similar incidents
  const fps = (allFps as Array<{ incident_id: number; date: string; title: string; type: string; severity: number; features: unknown }>)
    .filter((fp) => fp.incident_id !== incidentId)
    .map((fp) => ({
      incidentId: fp.incident_id,
      date: (fp.date instanceof Date ? fp.date.toISOString() : String(fp.date)).slice(0, 10),
      title: fp.title,
      type: fp.type,
      severity: fp.severity,
      features: fp.features as FeatureVector,
    }));
  const similar = matchAll(fv, fps).slice(0, 5);

  const chartData = obs7.map((r) => ({
    date: (r.date instanceof Date ? r.date.toISOString() : String(r.date)).slice(0, 10),
    wind: r.mean_wind_knots ?? null,
    wave: r.wave_height_m ?? null,
    rain: r.rain_mm ?? null,
  }));

  // Hourly at-time data (only if time_of_day is known)
  const hourly = timeLabel
    ? await fetchHourlyConditions(incident.lat, incident.lon, isoDate)
    : null;
  const atTimePicked = hourly && timeLabel ? pickAtAndBefore(hourly, timeLabel) : null;
  const tideDesc = timeLabel && dayOf
    ? describeTideAt(timeLabel, dayOf.high_tide_times ?? null, dayOf.low_tide_times ?? null)
    : null;
  const tideWindow = timeLabel && dayOf
    ? tideTrajectory(timeLabel, dayOf.high_tide_times ?? null, dayOf.low_tide_times ?? null)
    : [];

  // Contrast map for the day-vs-normal table
  const contrastMap = Object.fromEntries(contrast.map((d) => [d.key, d]));

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gradient-to-r from-blue-900 to-blue-700 text-white py-8 px-6">
        <div className="max-w-4xl mx-auto">
          <Link href={`/beach/${slug}`} className="text-blue-300 hover:text-white text-sm mb-3 inline-block">
            ← {incident.beach_name}
          </Link>
          <div className="flex items-start gap-3 flex-wrap">
            <span className={`text-xs font-medium px-2 py-1 rounded-full ${TYPE_COLOR[incident.type] ?? "bg-gray-200 text-gray-700"}`}>
              {incident.type.replace("_", " ").toUpperCase()}
            </span>
            {incident.casualties > 0 && (
              <span className="text-xs bg-red-200 text-red-900 font-bold px-2 py-1 rounded-full">
                {incident.casualties} casualt{incident.casualties === 1 ? "y" : "ies"}
              </span>
            )}
          </div>
          <h1 className="text-2xl font-bold mt-2">{incident.title}</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <p className="text-blue-300 text-sm">{isoDate}</p>
            {timeLabel && (
              <span className="text-xs bg-blue-700 text-blue-100 px-2 py-0.5 rounded-full">
                {timeLabel}
                {incident.time_source && incident.time_source !== "unknown" && (
                  <span className="opacity-70 ml-1">({incident.time_source})</span>
                )}
              </span>
            )}
            {incident.activity && incident.activity !== "unknown" && (
              <span className="text-xs bg-blue-700 text-blue-100 px-2 py-0.5 rounded-full capitalize">
                {incident.activity}
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-8 space-y-8">

        {/* Retrospective prediction card */}
        {retroHazard && (
          <RetroHazardCard
            result={retroHazard}
            beachName={incident.beach_name}
            date={isoDate}
          />
        )}

        {/* Verdict */}
        <IncidentVerdict
          contrast={contrast}
          activity={incident.activity}
          conditionRelated={incident.condition_related}
          annualObs={annualObs}
        />

        {/* Description */}
        {incident.description && (
          <section className="bg-white rounded-2xl border border-gray-200 p-6">
            <p className="text-gray-700 leading-relaxed">{incident.description}</p>
            {incident.source_url && (
              <p className="text-xs text-gray-400 mt-3">
                Source:{" "}
                <a href={incident.source_url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
                  {incident.source_type}
                </a>
              </p>
            )}
          </section>
        )}

        {/* Conditions at time (only when time_of_day is known and hourly data available) */}
        {timeLabel && atTimePicked && (
          <ConditionsAtTime
            timeLabel={timeLabel}
            atTime={atTimePicked.atTime}
            window={atTimePicked.window}
            tideDesc={tideDesc}
            tideWindow={tideWindow}
          />
        )}

        {/* Conditions on the day — reconciled: drop wind/wave when hourly is available */}
        <section className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Conditions on {isoDate}</h2>
          {dayOf ? (
            <div className="grid grid-cols-2 gap-x-8">
              {atTimePicked ? (
                // Hourly available → show only source-neutral fields
                <>
                  <div>
                    <ConditionRow label="Rainfall" value={dayOf.rain_mm?.toFixed(1) ?? null} unit="mm" />
                    <ConditionRow label="Tide range (est.)" value={dayOf.tide_range_m?.toFixed(1) ?? null} unit="m" />
                  </div>
                  <div>
                    <ConditionRow label="Sea temp" value={dayOf.sea_temp_c?.toFixed(1) ?? null} unit="°C" />
                    {dayOf.moon_illum != null && (
                      <div className="flex justify-between py-2 border-b border-gray-100">
                        <span className="text-sm text-gray-500">Moon</span>
                        <span className="text-sm font-medium text-gray-900">
                          <MoonGlyph phase={0} illum={dayOf.moon_illum} />
                        </span>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                // No hourly → full daily grid fallback
                <>
                  <div>
                    <ConditionRow label="Mean wind" value={dayOf.mean_wind_knots?.toFixed(1) ?? null} unit="kts" />
                    <ConditionRow label="Max gust" value={dayOf.max_gust_knots?.toFixed(1) ?? null} unit="kts" />
                    <ConditionRow label="Wave height (sig.)" value={dayOf.wave_height_m?.toFixed(2) ?? null} unit="m" />
                    <ConditionRow label="Wave period" value={dayOf.wave_period_s?.toFixed(1) ?? null} unit="s" />
                    <ConditionRow label="Rainfall" value={dayOf.rain_mm?.toFixed(1) ?? null} unit="mm" />
                  </div>
                  <div>
                    <ConditionRow label="Pressure" value={dayOf.mslp_hpa?.toFixed(1) ?? null} unit="hPa" />
                    <ConditionRow label="Sea temp" value={dayOf.sea_temp_c?.toFixed(1) ?? null} unit="°C" />
                    {dayOf.moon_illum != null && (
                      <div className="flex justify-between py-2 border-b border-gray-100">
                        <span className="text-sm text-gray-500">Moon</span>
                        <span className="text-sm font-medium text-gray-900">
                          <MoonGlyph phase={0} illum={dayOf.moon_illum} />
                        </span>
                      </div>
                    )}
                    <ConditionRow label="Tide range (est.)" value={dayOf.tide_range_m?.toFixed(1) ?? null} unit="m" />
                  </div>
                </>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-400">No observation data available for this date.</p>
          )}
        </section>

        {/* 7-day prior chart */}
        {chartData.length > 0 && (
          <section className="bg-white rounded-2xl border border-gray-200 p-6">
            <h2 className="font-semibold text-gray-900 mb-4">7-day prior conditions</h2>
            <ConditionsChart data={chartData} />
            <p className="text-xs text-gray-400 mt-2">
              Wind (knots), wave height (m), rainfall (mm) for the 7 days leading up to the incident.
            </p>
          </section>
        )}

        {/* How this day compared to normal */}
        <section className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-1">How this day compared to normal at {incident.beach_name}</h2>
          <p className="text-xs text-gray-500 mb-4">
            Each factor shows this day&apos;s value vs the beach&apos;s historical median, sorted by how much it deviated.
          </p>
          <div className="grid grid-cols-[1fr_auto_auto_60px] gap-x-4 mb-2 px-1">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Factor</p>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide text-right">This day</p>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide text-right">Typical</p>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide text-right">Verdict</p>
          </div>
          <div className="space-y-2">
            {contrast.map((d) => {
              const meta = FEATURE_LABELS[d.key];
              if (!meta) return null;
              const thisVal = meta.format(d.candidateVal);
              const typicalVal = meta.format(d.baselineVal);
              const unusual = d.deviation > 0.2;
              return (
                <div key={d.key} className="grid grid-cols-[1fr_auto_auto_60px] gap-x-4 items-center py-1.5 border-b border-gray-50 last:border-0">
                  <span className="text-sm text-gray-700">{meta.label}</span>
                  <span className={`text-sm tabular-nums text-right ${unusual ? "font-semibold text-gray-900" : "text-gray-600"}`}>
                    {thisVal}
                  </span>
                  <span className="text-sm tabular-nums text-right text-gray-400">{typicalVal}</span>
                  <div className="text-right">
                    {unusual ? (
                      <span className="inline-block text-[10px] font-semibold text-orange-700 bg-orange-50 border border-orange-200 rounded px-1.5 py-0.5">
                        unusual
                      </span>
                    ) : (
                      <span className="inline-block text-[10px] text-gray-400 bg-gray-50 rounded px-1.5 py-0.5">
                        typical
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <details className="mt-4">
            <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">
              Raw normalised feature vector (0–1 scale)
            </summary>
            <div className="grid grid-cols-4 gap-2 mt-3">
              {Object.entries(fv).map(([k, v]) => (
                <div key={k} className="bg-gray-50 rounded-lg p-2 border border-gray-100">
                  <p className="text-[10px] text-gray-400 mb-0.5">{k}</p>
                  <div className="w-full bg-gray-100 rounded-full h-1 mb-0.5">
                    <div className="bg-blue-400 h-1 rounded-full" style={{ width: `${Math.min(Math.abs(v) * 100, 100)}%` }} />
                  </div>
                  <p className="text-[10px] font-mono text-gray-600">{v.toFixed(3)}</p>
                </div>
              ))}
            </div>
          </details>
        </section>

        {/* Similar past incidents — reframed as conditions-similarity list */}
        {similar.length > 0 && (
          <section>
            <h2 className="font-semibold text-gray-900 mb-1">Days with most similar sea/weather conditions</h2>
            <p className="text-xs text-gray-500 mb-3">
              % reflects similarity of observed conditions only — not severity or outcome.
            </p>
            <div className="space-y-3">
              {similar.map((m) => (
                <Link
                  key={m.incidentId}
                  href={`/beach/${slug}/incident/${m.incidentId}`}
                  className="flex items-center gap-4 bg-white border border-gray-200 rounded-xl p-4 hover:border-blue-400 transition-all"
                >
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-900">{m.title}</p>
                    <p className="text-xs text-gray-400">{m.date}</p>
                  </div>
                  <span className="text-sm font-semibold text-gray-700 font-mono">
                    {(m.score * 100).toFixed(0)}%
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
