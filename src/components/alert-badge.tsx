"use client";

type Level = "none" | "watch" | "warning" | "severe";

const CONFIG: Record<Level, { label: string; bg: string; text: string; dot: string }> = {
  none:    { label: "All clear",  bg: "bg-emerald-100", text: "text-emerald-800", dot: "bg-emerald-500" },
  watch:   { label: "Watch",      bg: "bg-yellow-100",  text: "text-yellow-800",  dot: "bg-yellow-500" },
  warning: { label: "Warning",    bg: "bg-orange-100",  text: "text-orange-800",  dot: "bg-orange-500" },
  severe:  { label: "Severe",     bg: "bg-red-100",     text: "text-red-800",     dot: "bg-red-500" },
};

export function AlertBadge({ level, size = "md" }: { level: Level; size?: "sm" | "md" | "lg" }) {
  const c = CONFIG[level];
  const pad = size === "lg" ? "px-4 py-2 text-base" : size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${c.bg} ${c.text} ${pad}`}>
      <span className={`w-2 h-2 rounded-full ${c.dot} flex-shrink-0`} />
      {c.label}
    </span>
  );
}
