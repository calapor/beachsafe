import Link from "next/link";

export const metadata = { title: "Methodology — BeachSafe Ireland" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-bold text-gray-900 border-b border-gray-200 pb-2">{title}</h2>
      <div className="text-gray-700 leading-relaxed space-y-3 text-sm">{children}</div>
    </section>
  );
}

export default function MethodologyPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gradient-to-r from-blue-900 to-blue-700 text-white py-8 px-6">
        <div className="max-w-3xl mx-auto">
          <Link href="/" className="text-blue-300 hover:text-white text-sm mb-3 inline-block">← Dashboard</Link>
          <h1 className="text-3xl font-bold">Methodology & Data Sources</h1>
          <p className="text-blue-200 mt-1">How BeachSafe works and where its data comes from</p>
        </div>
      </header>

      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-10 space-y-10">

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-900">
          <strong>Important disclaimer.</strong> BeachSafe is a research tool that identifies
          historical pattern similarity — it does <em>not</em> predict whether an incident will occur.
          A "Severe" alert means today's conditions resemble those of past dangerous days at this beach.
          Always follow lifeguard instructions and official coast guard advice.
        </div>

        <Section title="What the similarity engine does">
          <p>
            Each recorded incident has a <strong>feature fingerprint</strong>: a normalised vector
            derived from the day-of observations and the 7-day window preceding the incident.
            Features include:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Onshore wind component</strong> — cosine of angle between wind direction and beach facing direction (highest weight: 2.5×)</li>
            <li><strong>Maximum wave height</strong> over the 7-day window (2.0×)</li>
            <li><strong>Spring/neap tide proxy</strong> derived from moon phase (1.5×)</li>
            <li><strong>Pressure drop</strong> — MSL pressure fall over the window (1.5×)</li>
            <li><strong>Maximum wind gust</strong> (1.2×)</li>
            <li><strong>Mean wind speed</strong> (1.0×)</li>
            <li><strong>Total rainfall</strong> (0.6×)</li>
            <li><strong>Moon illumination</strong> — proxy for spring tide severity (0.5×)</li>
          </ul>
          <p>
            Forecast-day fingerprints are compared to all incident fingerprints using a{" "}
            <strong>weighted Gaussian distance</strong> (σ = 0.5). Scores range 0–1; alert levels
            are bucketed: Watch ≥ 0.55, Warning ≥ 0.70, Severe ≥ 0.85.
          </p>
          <p>
            Because incident counts are small (5–20 per beach), this is <em>not</em> a machine-learning
            model — it is an explicit, inspectable similarity function with configurable weights.
          </p>
        </Section>

        <Section title="Data sources & coverage">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-gray-50">
                  <th className="text-left p-2 border border-gray-200 font-semibold">Layer</th>
                  <th className="text-left p-2 border border-gray-200 font-semibold">Source</th>
                  <th className="text-left p-2 border border-gray-200 font-semibold">Coverage</th>
                  <th className="text-left p-2 border border-gray-200 font-semibold">Quality</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Daily weather", "Met Éireann CLI/Fusio daily CSV", "~1942–present", "✅ Complete"],
                  ["Moon phase & illumination", "SunCalc (computed)", "Any date", "✅ Exact"],
                  ["Tide range", "Moon-phase proxy (pre-2006); OPW gauge (2006+)", "Estimated", "⚠️ Approximate"],
                  ["Wave height & period", "Marine Institute ERDDAP (M2/M3/M5 buoys)", "~2005–present", "⚠️ Offshore only"],
                  ["Sea temperature", "ERDDAP buoys (where available)", "~2005–present", "⚠️ Sparse"],
                  ["RNLI launches", "RNLI Open Data Return of Service", "2008–2016", "⚠️ Partial"],
                  ["Drownings & rescues", "Hand-curated from news & inquest reports", "Variable", "⚠️ Incomplete"],
                ].map(([layer, source, coverage, quality]) => (
                  <tr key={layer} className="hover:bg-gray-50">
                    <td className="p-2 border border-gray-200 font-medium">{layer}</td>
                    <td className="p-2 border border-gray-200 text-gray-600">{source}</td>
                    <td className="p-2 border border-gray-200 text-gray-600">{coverage}</td>
                    <td className="p-2 border border-gray-200">{quality}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Beach-specific data assignments">
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Fountainstown (Cork)</strong>: Met station Cork Airport #3904; wave buoy M5 (Celtic Sea); tide reference Ringaskiddy; facing SE (bearing 135°)</li>
            <li><strong>Ballybunion (Kerry)</strong>: Met station Valentia Observatory #2275; wave buoy M3 (SW Atlantic); tide reference Kilrush; facing W (bearing 270°)</li>
            <li><strong>Skerries (Dublin)</strong>: Met station Dublin Airport #532; wave buoy M2 (East coast); tide reference Dublin Port; facing E (bearing 90°)</li>
          </ul>
        </Section>

        <Section title="Tide range estimation">
          <p>
            For dates before the OPW tide gauge network (pre-2006), tide range is estimated from
            moon phase. The range oscillates between spring and neap approximately every 14 days,
            driven by the lunar cycle. We use moon illumination fraction as a proxy: when phase is
            within 12% of new or full moon, spring-tide ranges are used; otherwise neap.
          </p>
          <p>
            This is a documented approximation. Actual tidal range varies with meteorological
            surge, barometric pressure, and local bathymetry — particularly at Ballybunion (range
            up to 5m springs) and Skerries (range ~3.2m springs). The <code>source_flags</code>{" "}
            column in each observation records which layers are estimated vs measured.
          </p>
        </Section>

        <Section title="Known limitations">
          <ul className="list-disc pl-6 space-y-1">
            <li>Wave data is from <em>offshore</em> buoys, not inshore. Refraction, shoaling, and local bottom effects are not modelled.</li>
            <li>Incident database is small (5–20 per beach). Similarity scores have high variance — a high score does not mean an incident is likely, only that conditions are reminiscent of past dangerous days.</li>
            <li>RNLI open data ends in 2016. More recent launches are not comprehensively included.</li>
            <li>Drowning records rely on media and inquest reporting, which is inevitably incomplete.</li>
            <li>The Met Éireann forecast XML is a point forecast for the beach coordinates; local orographic effects are not resolved.</li>
          </ul>
        </Section>

        <div className="text-sm pt-4">
          <Link href="/" className="text-blue-600 hover:underline">← Return to dashboard</Link>
        </div>
      </main>
    </div>
  );
}
