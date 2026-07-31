"use client";

export type Level = "none" | "low" | "borderline" | "watch" | "warning" | "severe" | "unknown";

const LOW_CFG = { label: "Low", bg: "bg-emerald-100", text: "text-emerald-800", dot: "bg-emerald-500" };

const CONFIG: Record<Level, { label: string; bg: string; text: string; dot: string }> = {
  unknown: { label: "Insufficient data",     bg: "bg-gray-100",    text: "text-gray-500",    dot: "bg-gray-400" },
  none:    LOW_CFG,
  low:     LOW_CFG,
  borderline: { label: "Borderline",          bg: "bg-lime-100",    text: "text-lime-800",    dot: "bg-lime-500" },
  watch:   { label: "Watch",                 bg: "bg-yellow-100",  text: "text-yellow-800",  dot: "bg-yellow-500" },
  warning: { label: "Warning",               bg: "bg-orange-100",  text: "text-orange-800",  dot: "bg-orange-500" },
  severe:  { label: "Severe",                bg: "bg-red-100",     text: "text-red-800",     dot: "bg-red-500" },
};

// Frequency descriptions calibrated to annual combined-score ladder.
// severe ≈ worst 2%, warning ≈ next 8%, watch ≈ next 15%.
const FREQ_LABEL: Partial<Record<Level, string>> = {
  low:        "typical conditions",
  borderline: "68–70th percentile",
  watch:      "top 30% of days here",
  warning: "top 20% of days here",
  severe:  "worst 5% of days here",
  unknown: "data unavailable",
};

export function AlertBadge({
  level,
  size = "md",
  showFreq = false,
}: {
  level: Level;
  size?: "sm" | "md" | "lg";
  showFreq?: boolean;
}) {
  const c = CONFIG[level] ?? CONFIG.unknown;
  const pad = size === "lg" ? "px-4 py-2 text-base" : size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm";
  const freq = FREQ_LABEL[level];

  return (
    <span className={`inline-flex flex-col items-center gap-0.5`}>
      <span className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${c.bg} ${c.text} ${pad}`}>
        <span className={`w-2 h-2 rounded-full ${c.dot} flex-shrink-0`} />
        {c.label}
      </span>
      {showFreq && freq && (
        <span className="text-[10px] text-gray-400">{freq}</span>
      )}
    </span>
  );
}
