export function MoonGlyph({ phase, illum }: { phase: number; illum: number }) {
  const label =
    phase < 0.04 ? "🌑 New" :
    phase < 0.22 ? "🌒 Waxing crescent" :
    phase < 0.28 ? "🌓 First quarter" :
    phase < 0.48 ? "🌔 Waxing gibbous" :
    phase < 0.54 ? "🌕 Full" :
    phase < 0.72 ? "🌖 Waning gibbous" :
    phase < 0.78 ? "🌗 Last quarter" :
    phase < 0.96 ? "🌘 Waning crescent" : "🌑 New";

  return (
    <span title={`Phase: ${(phase * 100).toFixed(0)}% — Illumination: ${(illum * 100).toFixed(0)}%`}>
      {label} ({(illum * 100).toFixed(0)}%)
    </span>
  );
}
