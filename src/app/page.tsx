import Link from "next/link";
import { getBeaches } from "@/db/queries";
import { AlertBadge } from "@/components/alert-badge";
import { getForecastDays } from "@/lib/forecast";
import { getAllFingerprints } from "@/db/queries";

export const revalidate = 3600;

const BEACH_EMOJI: Record<string, string> = {
  fountainstown: "🏖️",
  ballybunion:   "🌊",
  skerries:      "⚓",
};

const BEACH_DESC: Record<string, string> = {
  fountainstown: "Sheltered SE-facing cove near Crosshaven, Cork. Popular family beach with RNLI Crosshaven nearby.",
  ballybunion:   "Wild Atlantic-facing beach in North Kerry. Powerful surf, rips, and significant tidal range.",
  skerries:      "Tidal East-coast beach north of Dublin. Sensitive to NE swell and exposed tidal eddies.",
};

async function getBeachAlertLevel(beach: { id: number; slug: string; lat: number; lon: number }): Promise<"none" | "watch" | "warning" | "severe"> {
  try {
    const fps = await getAllFingerprints(beach.id);
    const days = await getForecastDays(
      { slug: beach.slug, lat: beach.lat, lon: beach.lon },
      fps as never,
      1
    );
    return days[0]?.alertLevel ?? "none";
  } catch {
    return "none";
  }
}

export default async function Dashboard() {
  let beaches: Array<{ id: number; slug: string; name: string; county: string; lat: number; lon: number }> = [];
  try {
    beaches = (await getBeaches()) as never;
  } catch {
    // DB not yet populated — show placeholder
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-gradient-to-r from-blue-900 to-blue-700 text-white py-10 px-6 shadow-lg">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-4xl font-bold tracking-tight">🌊 BeachSafe Ireland</h1>
          <p className="mt-2 text-blue-200 text-lg">
            Coastal condition-matching & incident alerting for Irish beaches
          </p>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-10 space-y-6">
        {/* Disclaimer */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          <strong>Pattern match, not a prediction.</strong> Alert levels reflect similarity to past dangerous conditions —
          not a guarantee of risk. Always follow lifeguard and coast guard advice.
        </div>

        {beaches.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-gray-500">
            <p className="text-2xl mb-3">🔧</p>
            <p className="font-medium">Database not yet populated.</p>
            <p className="text-sm mt-1">Run <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">pnpm etl</code> to ingest data.</p>
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-1 md:grid-cols-3">
            {beaches.map(async (beach) => {
              const level = await getBeachAlertLevel(beach);
              return (
                <Link
                  key={beach.slug}
                  href={`/beach/${beach.slug}`}
                  className="group bg-white rounded-2xl border border-gray-200 p-6 flex flex-col gap-4 hover:border-blue-400 hover:shadow-md transition-all"
                >
                  <div className="text-3xl">{BEACH_EMOJI[beach.slug] ?? "🏖️"}</div>
                  <div>
                    <h2 className="text-lg font-bold text-gray-900 group-hover:text-blue-700 transition-colors">
                      {beach.name}
                    </h2>
                    <p className="text-sm text-gray-500">{beach.county}</p>
                  </div>
                  <p className="text-xs text-gray-600 leading-relaxed flex-1">
                    {BEACH_DESC[beach.slug]}
                  </p>
                  <div className="flex items-center justify-between">
                    <AlertBadge level={level} />
                    <span className="text-xs text-gray-400">Today →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        {/* Nav links */}
        <div className="flex gap-4 pt-4 text-sm">
          <Link href="/methodology" className="text-blue-600 hover:underline">
            Methodology & data sources
          </Link>
        </div>
      </main>
    </div>
  );
}
