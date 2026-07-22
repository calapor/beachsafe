import Link from "next/link";
import type { FeatureContribution, BaselineDeviation } from "@/lib/similarity";
import { FEATURE_LABELS } from "@/lib/feature-labels";

interface Props {
  slug: string;
  contributions: FeatureContribution[];
  contrast: BaselineDeviation[];
  topMatch?: { incidentId: number; title: string; date: string; score: number };
}

export function WhyFlaggedPanel({ slug, contributions, contrast, topMatch }: Props) {
  if (!contributions.length) return null;

  const contrastMap = Object.fromEntries(contrast.map((d) => [d.key, d]));
  const items = contributions.slice(0, 8);

  return (
    <section className="bg-white rounded-2xl border border-gray-200 p-6">
      <h2 className="font-semibold text-gray-900 mb-1">Why is this flagged?</h2>
      {topMatch ? (
        <p className="text-xs text-gray-500 mb-4">
          Matching{" "}
          <Link
            href={`/beach/${slug}/incident/${topMatch.incidentId}`}
            className="text-blue-600 hover:underline"
          >
            {topMatch.title}
          </Link>{" "}
          ({(topMatch.score * 100).toFixed(0)}% similar)
        </p>
      ) : (
        <p className="text-xs text-gray-500 mb-4">Top factor contributions</p>
      )}

      {/* Header row */}
      <div className="grid grid-cols-[1fr_2fr_52px_72px] gap-x-3 mb-2 px-1">
        <p className="text-[10px] text-gray-400 uppercase tracking-wide">Factor</p>
        <p className="text-[10px] text-gray-400 uppercase tracking-wide">Contribution</p>
        <p className="text-[10px] text-gray-400 uppercase tracking-wide text-right">Score</p>
        <p className="text-[10px] text-gray-400 uppercase tracking-wide text-right">vs typical</p>
      </div>

      <div className="space-y-2">
        {items.map((item) => {
          const meta      = FEATURE_LABELS[item.key];
          const c         = contrastMap[item.key];
          const todayStr  = meta?.format(item.candidateVal) ?? item.candidateVal.toFixed(2);
          const incStr    = meta?.format(item.referenceVal) ?? item.referenceVal.toFixed(2);

          return (
            <div key={item.key} className="grid grid-cols-[1fr_2fr_52px_72px] gap-x-3 items-center">
              {/* Feature label + value pair */}
              <div>
                <p className="text-xs font-medium text-gray-700 truncate">{meta?.label ?? item.key}</p>
                <p className="text-[10px] text-gray-400 truncate">
                  Today: {todayStr} / Past: {incStr}
                </p>
              </div>

              {/* Contribution bar */}
              <div className="flex items-center gap-1.5">
                <div className="flex-1 bg-gray-100 rounded-full h-2">
                  <div
                    className="bg-blue-500 h-2 rounded-full"
                    style={{ width: `${Math.min(item.contributionPct, 100)}%` }}
                  />
                </div>
              </div>

              {/* Contribution pct */}
              <p className="text-xs text-gray-500 text-right tabular-nums">
                {item.contributionPct.toFixed(0)}%
              </p>

              {/* Baseline contrast badge */}
              <div className="text-right">
                {c ? (
                  c.isDiscriminating ? (
                    <span className="inline-block text-[10px] font-semibold text-orange-700 bg-orange-50 border border-orange-200 rounded px-1.5 py-0.5">
                      unusual
                    </span>
                  ) : (
                    <span className="inline-block text-[10px] text-gray-400 bg-gray-50 rounded px-1.5 py-0.5">
                      typical
                    </span>
                  )
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {contributions.length > 8 && (
        <p className="text-xs text-gray-400 mt-3">
          Showing top 8 of {contributions.length} factors
        </p>
      )}
    </section>
  );
}
