import Link from "next/link";
import { getBeaches, getExcludedIncidentCounts, getFeatureDiscrimination } from "@/db/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Methodology — BeachSafe Ireland" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-bold text-gray-900 border-b border-gray-200 pb-2">{title}</h2>
      <div className="text-gray-700 leading-relaxed space-y-3 text-sm">{children}</div>
    </section>
  );
}

export default async function MethodologyPage() {
  // Load discrimination results and exclusion counts from DB
  let discrimination: Array<{
    feature: string; scope: string; n_case: number; n_control: number;
    auc: number | null; auc_lo: number | null; auc_hi: number | null;
  }> = [];
  let exclusionsByBeach: Array<{ slug: string; counts: Array<{ activity: string; exclusion_cause: string | null; n: number }> }> = [];

  try {
    discrimination = await getFeatureDiscrimination() as never;
  } catch { /* DB may not have table yet */ }

  try {
    const beaches = await getBeaches() as Array<{ id: number; slug: string; name: string }>;
    exclusionsByBeach = await Promise.all(
      beaches.map(async (b) => ({
        slug: b.slug,
        counts: await getExcludedIncidentCounts(b.id) as Array<{ activity: string; exclusion_cause: string | null; n: number }>,
      }))
    );
  } catch { /* DB may not have data yet */ }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gradient-to-r from-blue-900 to-blue-700 text-white py-8 px-6">
        <div className="max-w-3xl mx-auto">
          <Link href="/" className="text-blue-300 hover:text-white text-sm mb-3 inline-block">← Dashboard</Link>
          <h1 className="text-3xl font-bold">Methodology & Data Sources</h1>
          <p className="text-blue-200 mt-1">How BeachSafe works, what it cannot tell you, and why</p>
        </div>
      </header>

      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-10 space-y-10">

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-900">
          <strong>Important disclaimer.</strong> Alert levels express <em>climatological anomaly</em>{" "}
          — how unusual today&apos;s conditions are for this beach and month — not incident probability.
          No single condition has yet been shown to discriminate incident days from matched control days
          at this sample size (n≈51 cases). Treat all tiers as educational, not predictive.
          Always follow lifeguard and coast guard advice.
        </div>

        <Section title="Calibration targets">
          <p>
            Tiers are calibrated against the distribution of historical conditions for each beach and
            calendar month, so &ldquo;Severe&rdquo; always means approximately the worst 5% of days for this
            time of year — not a fixed absolute threshold:
          </p>
          <table className="w-full text-xs border-collapse mt-2">
            <thead>
              <tr className="bg-gray-50">
                <th className="p-2 border border-gray-200 text-left">Tier</th>
                <th className="p-2 border border-gray-200 text-left">Target frequency</th>
                <th className="p-2 border border-gray-200 text-left">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Severe",     "~5%",  "Worst 5% of days for this beach and month"],
                ["Warning",    "~15%", "Top 20% of days — elevated hazard or crowding"],
                ["Watch",      "~10%", "Top 30% — conditions worth noting"],
                ["Borderline", "~2%",  "68th–70th percentile — just below Watch"],
                ["Low",        "~68%", "Typical conditions for this time of year"],
                ["Unknown",    "—",    "Forecast data unavailable"],
              ].map(([tier, freq, meaning]) => (
                <tr key={tier}>
                  <td className="p-2 border border-gray-200 font-medium">{tier}</td>
                  <td className="p-2 border border-gray-200">{freq}</td>
                  <td className="p-2 border border-gray-200 text-gray-600">{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="Discrimination analysis — honest null result">
          <p>
            Before computing any hazard model, a case-control test was run: 51 condition-related
            swimmer/shore incidents vs 5,709+ seasonally-matched control days (same beach, same ±10-day
            calendar window, other years — removing the seasonality and exposure confound).
          </p>
          <p className="font-medium text-gray-900">
            Not one environmental feature was found to discriminate incident days from control days
            at this sample size. Every 95% confidence interval spans AUC = 0.5 (chance).
            At n≈51 cases, the minimum detectable AUC is approximately 0.64.
          </p>
          {discrimination.length > 0 ? (
            <table className="w-full text-xs border-collapse mt-2">
              <thead>
                <tr className="bg-gray-50">
                  <th className="p-2 border border-gray-200 text-left">Feature</th>
                  <th className="p-2 border border-gray-200">AUC</th>
                  <th className="p-2 border border-gray-200">95% CI</th>
                  <th className="p-2 border border-gray-200">n cases</th>
                  <th className="p-2 border border-gray-200">n controls</th>
                </tr>
              </thead>
              <tbody>
                {discrimination.filter((r) => r.scope === "pooled").map((r) => (
                  <tr key={r.feature}>
                    <td className="p-2 border border-gray-200 font-mono">{r.feature}</td>
                    <td className="p-2 border border-gray-200 text-center">
                      {r.auc != null ? r.auc.toFixed(3) : "—"}
                    </td>
                    <td className="p-2 border border-gray-200 text-center">
                      {r.auc_lo != null && r.auc_hi != null
                        ? `[${r.auc_lo.toFixed(2)}, ${r.auc_hi.toFixed(2)}]`
                        : "—"}
                    </td>
                    <td className="p-2 border border-gray-200 text-center">{r.n_case}</td>
                    <td className="p-2 border border-gray-200 text-center">{r.n_control}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-gray-400 italic">
              Run <code className="bg-gray-100 px-1 rounded">pnpm analysis:discrimination</code> to populate this table.
            </p>
          )}
          <p>
            Because no feature discriminates reliably, tiers express <em>climatological anomaly</em>,
            not modelled risk probability. Hazard components are labelled with their validation status:
            &ldquo;suggestive&rdquo; (AUC ≥ 0.58 but CI spans 0.5) or &ldquo;mechanism only&rdquo; (physically motivated
            but untested at this sample size).
          </p>
        </Section>

        <Section title="Hazard components">
          <p>The hazard index combines up to eight physically-motivated components, each
            calibrated against the climatology for this beach and month:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>springTideRange</strong> — day-of tidal range vs climatology. <em>Suggestive</em> (AUC ≈ 0.62).</li>
            <li><strong>ripBand</strong> — surf height in the 0.7–1.5 m window activating rip channels without deterring swimmers. <em>Mechanism only.</em></li>
            <li><strong>ebbNearLow</strong> — ebbing tide near LW: peak rip-channel drainage velocity. <em>Mechanism only.</em></li>
            <li><strong>onshoreWind</strong> — onshore wind component × wind speed percentile. <em>Mechanism only.</em></li>
            <li><strong>longSwellCalm</strong> — swell ≥ 10 s on a calm day (&lt;12 kts): deceptive shore-break. Only active where real swell period data exists. <em>Mechanism only.</em></li>
            <li><strong>offshoreBlowoff</strong> — offshore wind × warm-calm index (inflatable risk). <em>Mechanism only.</em></li>
            <li><strong>coldShock</strong> — cold sea + hot air temperature: cardiac cold-shock risk. <em>Mechanism only.</em></li>
            <li><strong>stormLegacy</strong> — post-storm rip-channel formation: first calm day after a blow. <em>Mechanism only.</em></li>
          </ul>
          <p>
            Missing inputs produce a <em>null</em> score (never defaulted to 0 — that was the prior
            bug that caused silent &ldquo;severe&rdquo; on data outages). The index renormalises over available
            components; if fewer than half are available it returns &ldquo;unknown&rdquo;.
          </p>
        </Section>

        <Section title="Incident scope — what is and is not included">
          <p>
            Only swimmer and shore incidents with <code>condition_related = true</code> and
            <code>activity IN (&#39;swimmer&#39;, &#39;shore&#39;)</code> are used in fingerprinting and calibration.
            Watercraft, medical, man-overboard, and false-alarm incidents are excluded because they
            reflect different risk pathways.
          </p>
          {exclusionsByBeach.length > 0 && (
            <div className="space-y-3">
              {exclusionsByBeach.map(({ slug, counts }) => counts.length > 0 && (
                <div key={slug}>
                  <p className="font-medium capitalize">{slug}:</p>
                  <ul className="pl-4 text-xs text-gray-600 space-y-0.5">
                    {counts.map((c, i) => (
                      <li key={i}>{c.n} excluded — activity: {c.activity}, cause: {c.exclusion_cause ?? "out-of-scope"}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Data sources & coverage">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-gray-50">
                  <th className="text-left p-2 border border-gray-200 font-semibold">Layer</th>
                  <th className="text-left p-2 border border-gray-200 font-semibold">Source</th>
                  <th className="text-left p-2 border border-gray-200 font-semibold">Coverage</th>
                  <th className="text-left p-2 border border-gray-200 font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Daily weather", "Met Éireann CLI/Fusio daily CSV (ERA5 reanalysis)", "1950–present", "100% coverage since 1950"],
                  ["Moon phase & illumination", "SunCalc (computed)", "Any date", "Exact"],
                  ["Tidal range (gauge)", "Irish National Tide Gauge Network via Marine ERDDAP", "2006–present", "Outlier-rejected; NULL when implausible"],
                  ["Tidal range (proxy)", "Moon-phase spring/neap proxy", "Pre-2006", "Approximate — calibrated separately"],
                  ["Wave height, swell", "Open-Meteo marine archive (beach-specific offshore point)", "2000–present", "Swell period (Tp) available; mean period (Tz) noted"],
                  ["Sea temperature", "Marine Institute ERDDAP (M2/M3 buoys) + Open-Meteo SST", "2000–present", "Sparse pre-2005"],
                  ["RNLI launches", "RNLI Open Data Return of Service (ArcGIS)", "2008–present", "Swimmer/shore scope enforced"],
                  ["Incident activity", "Claude Haiku classifier + human review", "All incidents", "Evidence field persisted for audit"],
                ].map(([layer, source, coverage, notes]) => (
                  <tr key={layer} className="hover:bg-gray-50">
                    <td className="p-2 border border-gray-200 font-medium">{layer}</td>
                    <td className="p-2 border border-gray-200 text-gray-600">{source}</td>
                    <td className="p-2 border border-gray-200 text-gray-600">{coverage}</td>
                    <td className="p-2 border border-gray-200 text-gray-500">{notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Beach-specific assignments">
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Fountainstown (Cork)</strong>: Met station Cork Airport; wave buoy offshore point at 135° bearing; tide gauge Ballycotton Harbour (spring range 3.8 m); beach facing SE (135°)</li>
            <li><strong>Ballybunion (Kerry)</strong>: Met station Valentia Observatory; wave buoy offshore at 270° (Atlantic); tide gauge Inishmore proxy (spring range ~4.5 m); facing W (270°)</li>
            <li><strong>Skerries (Dublin)</strong>: Met station Dublin Airport; wave buoy offshore at 90° (Irish Sea); tide gauge Skerries Harbour (spring range 3.2 m); facing E (90°)</li>
          </ul>
        </Section>

        <Section title="Known limitations">
          <ul className="list-disc pl-6 space-y-1">
            <li>The incident dataset (n≈51 swimmer/shore condition-related) is too small to train a predictive model or validate any feature at conventional significance.</li>
            <li>Incident times are unavailable (0 of 51 have time_of_day), preventing hourly tide-phase analysis — the natural timescale of rip-current drowning.</li>
            <li>Wave data before 2000 is absent; tide gauge data before 2006 uses a moon-phase proxy. Each metric&apos;s climatology covers only its own data window.</li>
            <li>Wave data is from offshore grid points. Nearshore refraction, shoaling, and rip-channel bathymetry are not modelled.</li>
            <li>The long-swell component is only active if the wave data shows swell period &gt;10 s; otherwise it is absent rather than fabricated.</li>
          </ul>
        </Section>

        <div className="text-sm pt-4">
          <Link href="/" className="text-blue-600 hover:underline">← Return to dashboard</Link>
        </div>
      </main>
    </div>
  );
}
