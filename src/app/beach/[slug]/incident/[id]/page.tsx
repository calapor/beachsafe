import Link from "next/link";
import { notFound } from "next/navigation";
import { getIncidentById, getObservationWindow, getAllFingerprints, getBeachBySlug } from "@/db/queries";
import { AlertBadge } from "@/components/alert-badge";
import { MoonGlyph } from "@/components/moon-glyph";
import { ConditionsChart } from "@/components/conditions-chart";
import { fingerprint, matchAll, alertLevel } from "@/lib/similarity";

export const revalidate = 86400;

const BEACH_BEARING: Record<string, number> = {
  fountainstown: 135,
  ballybunion:   270,
  skerries:      90,
};

function windDirLabel(deg: number | null): string {
  if (deg == null) return "—";
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
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
  } | null;
  if (!incident) notFound();

  const isoDate = incident.date instanceof Date
    ? incident.date.toISOString().slice(0, 10)
    : String(incident.date).slice(0, 10);
  const bearing = BEACH_BEARING[incident.beach_slug] ?? 270;

  const [window7, allFps] = await Promise.all([
    getObservationWindow(incident.beach_id, isoDate, 8),
    getAllFingerprints(incident.beach_id),
  ]);

  const obs7 = window7 as Array<{
    date: string; mean_wind_knots?: number | null; max_gust_knots?: number | null;
    wave_height_m?: number | null; wave_period_s?: number | null; rain_mm?: number | null;
    mslp_hpa?: number | null; moon_illum?: number | null; tide_range_m?: number | null;
    wind_dir_deg?: number | null; sea_temp_c?: number | null;
  }>;

  const dayOf = obs7.find((r) => (r.date instanceof Date ? r.date.toISOString() : String(r.date)).slice(0, 10) === isoDate) ?? obs7[obs7.length - 1];

  // Feature vector for this incident
  const fv = fingerprint(obs7 as never, bearing);

  // Similar incidents
  const fps = (allFps as Array<{ incident_id: number; date: string; title: string; type: string; severity: number; features: unknown }>)
    .filter((fp) => fp.incident_id !== incidentId)
    .map((fp) => ({
      incidentId: fp.incident_id,
      date: (fp.date instanceof Date ? fp.date.toISOString() : String(fp.date)).slice(0, 10),
      title: fp.title,
      type: fp.type,
      severity: fp.severity,
      features: fp.features as ReturnType<typeof import("@/lib/similarity").normalizeFeatures>,
    }));

  const similar = matchAll(fv, fps).slice(0, 5);

  const chartData = obs7.map((r) => ({
    date: (r.date instanceof Date ? r.date.toISOString() : String(r.date)).slice(0, 10),
    wind: r.mean_wind_knots ?? null,
    wave: r.wave_height_m ?? null,
    rain: r.rain_mm ?? null,
  }));

  const TYPE_COLOR: Record<string, string> = {
    rnli_launch: "bg-blue-100 text-blue-800",
    drowning:    "bg-red-100 text-red-800",
    rescue:      "bg-orange-100 text-orange-800",
    near_miss:   "bg-yellow-100 text-yellow-800",
  };

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
          <p className="text-blue-300 text-sm mt-1">{isoDate}</p>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-8 space-y-8">
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

        {/* Conditions on the day */}
        <section className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Conditions on {isoDate}</h2>
          {dayOf ? (
            <div className="grid grid-cols-2 gap-x-8">
              <div>
                <ConditionRow label="Mean wind" value={dayOf.mean_wind_knots?.toFixed(1) ?? null} unit="kts" />
                <ConditionRow label="Max gust" value={dayOf.max_gust_knots?.toFixed(1) ?? null} unit="kts" />
                <ConditionRow label="Wind direction" value={windDirLabel(dayOf.wind_dir_deg ?? null)} />
                <ConditionRow label="Wave height (sig.)" value={dayOf.wave_height_m?.toFixed(2) ?? null} unit="m" />
                <ConditionRow label="Wave period" value={dayOf.wave_period_s?.toFixed(1) ?? null} unit="s" />
              </div>
              <div>
                <ConditionRow label="Rainfall" value={dayOf.rain_mm?.toFixed(1) ?? null} unit="mm" />
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

        {/* Feature fingerprint */}
        <section className="bg-slate-50 rounded-2xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-3">Incident fingerprint</h2>
          <p className="text-xs text-gray-500 mb-3">Normalised feature vector used for similarity matching (0–1 scale).</p>
          <div className="grid grid-cols-4 gap-3">
            {Object.entries(fv).map(([k, v]) => (
              <div key={k} className="bg-white rounded-lg p-3 border border-gray-100">
                <p className="text-xs text-gray-400 mb-1">{k}</p>
                <div className="w-full bg-gray-100 rounded-full h-1.5 mb-1">
                  <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${Math.min(v * 100, 100)}%` }} />
                </div>
                <p className="text-xs font-mono font-medium">{v.toFixed(3)}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Similar past incidents */}
        {similar.length > 0 && (
          <section>
            <h2 className="font-semibold text-gray-900 mb-4">Days with most similar conditions</h2>
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
                  <AlertBadge level={m.alertLevel} size="sm" />
                  <span className="text-xs text-gray-500 font-mono">{(m.score * 100).toFixed(0)}%</span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
