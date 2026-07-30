"use client";

import Link from "next/link";
import type { Component, Coverage } from "@/lib/hazard";
import type { ScoredMatch } from "@/lib/similarity";

const EVIDENCE_LABEL: Record<string, { text: string; color: string }> = {
  validated:         { text: "validated",       color: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  suggestive:        { text: "suggestive",      color: "text-blue-700 bg-blue-50 border-blue-200" },
  unvalidated:       { text: "mechanism only",  color: "text-gray-500 bg-gray-50 border-gray-200" },
  "insufficient-data": { text: "no data",       color: "text-gray-400 bg-gray-50 border-gray-100" },
};

function EvidenceBadge({ e }: { e: string }) {
  const cfg = EVIDENCE_LABEL[e] ?? EVIDENCE_LABEL["unvalidated"];
  return (
    <span className={`inline-block text-[10px] font-medium border rounded px-1.5 py-0.5 ${cfg.color}`}>
      {cfg.text}
    </span>
  );
}

function pctLabel(p: number | null): string {
  if (p == null) return "—";
  return `${Math.round(p * 100)}th percentile`;
}

function DialBar({ label, score, drivers }: { label: string; score: number | null; drivers?: string[] }) {
  const pct = score != null ? Math.round(score * 100) : null;
  const color =
    pct == null    ? "bg-gray-200" :
    pct >= 75      ? "bg-orange-400" :
    pct >= 50      ? "bg-yellow-300" :
                     "bg-emerald-300";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-gray-700">{label}</span>
        <span className="text-gray-500">{pct != null ? `${pct}%` : "—"}</span>
      </div>
      <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct ?? 0}%` }} />
      </div>
      {drivers && drivers.length > 0 && (
        <p className="text-[10px] text-gray-400">{drivers.join(" · ")}</p>
      )}
    </div>
  );
}

interface Props {
  slug: string;
  driver: Component | null;
  components: Component[];
  coverage: Coverage;
  topMatches: ScoredMatch[];
  isCalm: boolean;
  exposureScore?: number | null;
  exposureDrivers?: string[];
  hazardScore?: number | null;
}

export function RiskEvidencePanel({
  slug, driver, components, coverage, topMatches, isCalm,
  exposureScore, exposureDrivers, hazardScore,
}: Props) {
  const elevated = components.filter((c) => c.score != null && c.score >= 0.90);
  const normal   = components.filter((c) => c.score != null && c.score <  0.90);
  const missing  = components.filter((c) => c.score == null);
  const uncoveredInputs = missing.flatMap((c) => c.inputs);

  return (
    <section className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
      <h2 className="font-semibold text-gray-900">Risk evidence</h2>

      {/* Two dials */}
      <div className="grid grid-cols-2 gap-4 p-4 bg-gray-50 rounded-xl border border-gray-100">
        <DialBar
          label="Sea conditions"
          score={hazardScore ?? null}
        />
        <DialBar
          label="How busy the beach is likely to be"
          score={exposureScore ?? null}
          drivers={exposureDrivers}
        />
      </div>

      {/* Primary driver mechanism */}
      {driver ? (
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-4">
          <p className="text-sm font-medium text-amber-900">{driver.mechanism}</p>
          <p className="text-xs text-amber-600 mt-1">Primary sea hazard: {driver.key}</p>
        </div>
      ) : isCalm ? (
        <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4">
          <p className="text-sm font-medium text-emerald-900">Sea conditions are typical for this time of year.</p>
        </div>
      ) : null}

      {/* Elevated sea hazard factors */}
      {elevated.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Elevated sea factors</p>
          <div className="space-y-2">
            {elevated.map((c) => (
              <div key={c.key} className="flex items-start justify-between gap-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800">{c.key}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{c.mechanism}</p>
                </div>
                <div className="text-right flex-shrink-0 space-y-1">
                  <p className="text-xs font-semibold text-orange-700">{pctLabel(c.percentile)}</p>
                  <EvidenceBadge e={c.evidence} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Normal factors on calm days */}
      {isCalm && normal.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
            Normal conditions ({normal.length} factor{normal.length !== 1 ? "s" : ""})
          </summary>
          <div className="mt-2 space-y-1 pl-3 border-l-2 border-gray-100">
            {normal.map((c) => (
              <div key={c.key} className="flex items-center justify-between gap-2 text-xs text-gray-500">
                <span>{c.key}</span>
                <span>{pctLabel(c.percentile)}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Precedent */}
      {topMatches.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Historical precedents</p>
          <div className="space-y-1">
            {topMatches.map((m) => (
              <Link
                key={m.incidentId}
                href={`/beach/${slug}/incident/${m.incidentId}`}
                className="block text-xs text-blue-600 hover:underline"
              >
                {m.title} ({m.date.slice(0, 10)})
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Coverage footer */}
      <div className="border-t border-gray-100 pt-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Data coverage today</p>
        <div className="flex flex-wrap gap-2">
          {(["weather", "waves", "tide", "swell"] as (keyof Coverage)[]).map((key) => (
            <span
              key={key}
              className={`text-[10px] px-2 py-0.5 rounded-full border ${
                coverage[key]
                  ? "text-emerald-700 bg-emerald-50 border-emerald-200"
                  : "text-gray-400 bg-gray-50 border-gray-200"
              }`}
            >
              {coverage[key] ? "✓" : "✗"} {key}
            </span>
          ))}
        </div>
        {missing.length > 0 && (
          <p className="text-[10px] text-gray-400 mt-1">
            {missing.length} component{missing.length !== 1 ? "s" : ""} unavailable due to missing data.
          </p>
        )}
        {uncoveredInputs.length > 0 && (
          <p className="text-[10px] text-gray-400">
            Missing inputs: {[...new Set(uncoveredInputs)].join(", ")}.
          </p>
        )}
      </div>
    </section>
  );
}
