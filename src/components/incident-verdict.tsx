import type { BaselineDeviation } from "@/lib/similarity";

interface AnnualObs {
  date: string;
  wave_height_m?: number | null;
  moon_illum?: number | null;
  tide_range_m?: number | null;
  max_gust_knots?: number | null;
}

interface Props {
  contrast: BaselineDeviation[];
  activity?: string | null;
  conditionRelated?: boolean | null;
  annualObs?: AnnualObs[];
}

// ─── Verdict builder ──────────────────────────────────────────────────────────

interface VerdictOutput {
  headline: string;
  bullets: { key: string; text: string }[];
}

function buildVerdict(contrast: BaselineDeviation[]): VerdictOutput {
  const get = (key: string) => contrast.find((d) => d.key === key);

  const summaryParts: string[] = [];
  const bullets: { key: string; text: string }[] = [];

  // Swell / wave
  const wave = get("maxWave");
  const period = get("wavePeriod");
  const bigWave = wave && wave.deviation > 0.2 && wave.candidateVal > 0.25;
  const longPeriod = period && period.deviation > 0.2 && period.candidateVal > 0.35;

  if (bigWave || longPeriod) {
    const type = bigWave && longPeriod ? "big long-period swell" : bigWave ? "large swell" : "long-period swell";
    let ratioStr = "";
    if (wave && wave.baselineVal > 0.05) {
      const ratio = Math.round(wave.candidateVal / wave.baselineVal);
      if (ratio >= 2) ratioStr = `, ~${ratio}× beach norm`;
    }
    const waveM = wave ? `${(wave.candidateVal * 5).toFixed(1)}m` : null;
    const periodS = period ? `${(period.candidateVal * 20).toFixed(0)}s` : null;
    const valStr = [waveM, periodS].filter(Boolean).join(" at ");
    summaryParts.push(`${type}${valStr ? ` (${valStr}${ratioStr})` : ratioStr ? ` (${ratioStr})` : ""}`);

    if (waveM && periodS) {
      bullets.push({ key: "wave", text: `${type.charAt(0).toUpperCase() + type.slice(1)} — ${waveM} at ${periodS}. Long-period swell from distant storms breaks with more force than local wind chop, carrying significantly more energy per wave.` });
    } else if (waveM) {
      bullets.push({ key: "wave", text: `${type.charAt(0).toUpperCase() + type.slice(1)} — ${waveM}. Swell energy scales with the square of wave height: twice the typical height means four times the energy in the water.` });
    } else if (periodS) {
      bullets.push({ key: "wave", text: `Long-period swell — ${periodS} wave period. Swell originating far away travels faster and breaks more powerfully than locally generated chop.` });
    }
  }

  // Tide direction + spring range
  const tideState = get("tideState");
  const tideRange = get("tideRange");
  const flooding = tideState && tideState.deviation > 0.2 && tideState.candidateVal > 0.3;
  const ebbing = tideState && tideState.deviation > 0.2 && tideState.candidateVal < -0.3;
  const spring = tideRange && tideRange.deviation > 0.15 && tideRange.candidateVal > 0.55;
  const moon = get("moonIllum");
  // candidateVal is now tidal force: high at both new and full moon, 0 at quarters
  const springMoon = moon && moon.deviation > 0.2 && moon.candidateVal > 0.65;

  if (flooding || ebbing || spring) {
    const dir = flooding ? "flooding" : ebbing ? "ebbing" : "";
    const tidal = spring ? "spring" : "";
    const rangeM = tideRange ? (tideRange.candidateVal * 5).toFixed(1) : null;
    const rangeDetail = rangeM ? ` (${rangeM}m range)` : "";
    summaryParts.push([dir, tidal, `tide${rangeDetail}`].filter(Boolean).join(" "));

    if (flooding) {
      bullets.push({ key: "tideState", text: "Flooding tide — water level and current strength were increasing. Mid-flood is typically the period of strongest tidal flow, pushing water onto the beach and into any rip channels." });
    } else if (ebbing) {
      bullets.push({ key: "tideState", text: "Ebbing tide — water draining off the beach, channelled through rip currents at their strongest. Ebbing tides accelerate rip-channel flow significantly." });
    }

    if (spring && tideRange) {
      const ratioStr = tideRange.baselineVal > 0.05
        ? ` — ${Math.round(tideRange.candidateVal / tideRange.baselineVal)}× the beach's neap range`
        : "";
      const rangeStr = rangeM ? `${rangeM}m${ratioStr}` : "";
      bullets.push({ key: "tideRange", text: `Spring tidal range${rangeStr ? ` — ${rangeStr}` : ""}. Near new or full moon, tidal forces are maximised. Spring tides produce significantly faster tidal currents than neap tides.` });
    }
  }

  // Spring moon bullet (covers both full and new moon)
  if (springMoon && moon) {
    const forceStr = (moon.candidateVal * 100).toFixed(0);
    if (!flooding && !ebbing && !spring) {
      summaryParts.push("near spring moon (full/new moon)");
    }
    bullets.push({ key: "moonIllum", text: `Spring moon conditions (tidal force ${forceStr}%) — near full or new moon, gravitational tidal forces peak and drive spring tidal conditions with the strongest currents of the month.` });
  }

  // Wind
  const gust = get("maxGust");
  const onshore = get("onshoreComponent");
  if (gust && gust.deviation > 0.2 && gust.candidateVal > 0.4) {
    const kts = (gust.candidateVal * 50).toFixed(0);
    summaryParts.push(`strong gusts (${kts} kts)`);
    bullets.push({ key: "maxGust", text: `Gusts to ${kts} kts — strong winds roughen the surface, make swimming harder against the water, and can push swimmers further offshore.` });
  } else if (onshore && onshore.deviation > 0.2 && onshore.candidateVal > 0.6) {
    summaryParts.push("direct onshore wind");
    bullets.push({ key: "onshoreComponent", text: "Wind blowing directly onto the beach — adds to surf height, pushes swimmers further from shore, and can make it significantly harder to return to the beach." });
  }

  // Pressure drop
  const pressureDrop = get("pressureDrop");
  if (pressureDrop && pressureDrop.deviation > 0.2 && pressureDrop.candidateVal > 0.2) {
    const hpa = (pressureDrop.candidateVal * 30).toFixed(0);
    bullets.push({ key: "pressureDrop", text: `Pressure fell ${hpa} hPa over the preceding days — indicates an approaching weather system, typically bringing strengthening winds and heavier seas.` });
  }

  return {
    headline: summaryParts.length > 0 ? `This day stood out: ${summaryParts.join(", ")}.` : "",
    bullets,
  };
}

// ─── Frequency chart ──────────────────────────────────────────────────────────

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

interface FreqEntry {
  label: string;
  thresholdLabel: string;
  count: number;
  totalDays: number;
  monthCounts: number[];
}

function computeFrequency(contrast: BaselineDeviation[], obs: AnnualObs[]): FreqEntry[] {
  const entries: FreqEntry[] = [];
  const get = (key: string) => contrast.find((d) => d.key === key);
  const totalDays = obs.length;

  function monthlyCount(predicate: (o: AnnualObs) => boolean): { count: number; monthCounts: number[] } {
    const monthCounts = Array(12).fill(0);
    let count = 0;
    for (const o of obs) {
      if (predicate(o)) {
        count++;
        const d = new Date(String(o.date));
        monthCounts[d.getUTCMonth()]++;
      }
    }
    return { count, monthCounts };
  }

  // Spring tide (tideRange)
  const tideRange = get("tideRange");
  if (tideRange && tideRange.deviation > 0.15 && tideRange.candidateVal > 0.4) {
    const threshold = tideRange.candidateVal * 5 * 0.7;
    const { count, monthCounts } = monthlyCount((o) => (o.tide_range_m ?? 0) >= threshold);
    if (count > 0) entries.push({
      label: "Spring tide days",
      thresholdLabel: `tide range ≥ ${threshold.toFixed(1)} m`,
      count, totalDays, monthCounts,
    });
  }

  // High swell (maxWave)
  const wave = get("maxWave");
  if (wave && wave.deviation > 0.2 && wave.candidateVal > 0.25) {
    const threshold = wave.candidateVal * 5 * 0.65;
    const { count, monthCounts } = monthlyCount((o) => (o.wave_height_m ?? 0) >= threshold);
    if (count > 0) entries.push({
      label: "High swell days",
      thresholdLabel: `wave height ≥ ${threshold.toFixed(1)} m`,
      count, totalDays, monthCounts,
    });
  }

  // Spring moon (moonIllum — tidal force high at both new and full moon)
  // Tidal force = |1 - 2*fraction|; threshold on raw illumination means illum ≤ 25% or ≥ 75%
  const moon = get("moonIllum");
  if (moon && moon.deviation > 0.2 && moon.candidateVal > 0.65) {
    const tidalForceThreshold = moon.candidateVal * 0.7;
    // Convert tidal force threshold back to illumination bounds:
    // force = |1 - 2*illum| ≥ t  →  illum ≤ (1-t)/2  OR  illum ≥ (1+t)/2
    const illumLow  = (1 - tidalForceThreshold) / 2;
    const illumHigh = (1 + tidalForceThreshold) / 2;
    const { count, monthCounts } = monthlyCount(
      (o) => (o.moon_illum ?? 0.5) <= illumLow || (o.moon_illum ?? 0.5) >= illumHigh
    );
    if (count > 0) entries.push({
      label: "Spring moon days (full or new)",
      thresholdLabel: `illumination ≤ ${(illumLow * 100).toFixed(0)}% or ≥ ${(illumHigh * 100).toFixed(0)}%`,
      count, totalDays, monthCounts,
    });
  }

  return entries;
}

function FrequencyChart({ entry }: { entry: FreqEntry }) {
  const maxMonth = Math.max(...entry.monthCounts, 1);
  return (
    <div className="mt-3">
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-sm font-medium text-gray-800">{entry.label}</span>
        <span className="text-xs text-gray-400">({entry.thresholdLabel})</span>
        <span className="ml-auto text-sm font-semibold text-blue-700">{entry.count} days</span>
        <span className="text-xs text-gray-400">of {entry.totalDays} observed</span>
      </div>
      <div className="flex gap-0.5 items-end h-10">
        {MONTHS.map((m, i) => {
          const count = entry.monthCounts[i];
          const barPct = maxMonth > 0 ? (count / maxMonth) * 100 : 0;
          return (
            <div key={m} className="flex-1 flex flex-col items-center gap-0.5">
              <div className="w-full flex items-end" style={{ height: 32 }}>
                <div
                  className="w-full rounded-t bg-blue-300"
                  style={{ height: `${barPct}%`, minHeight: count > 0 ? 3 : 0 }}
                  title={`${m}: ${count} days`}
                />
              </div>
              <span className="text-[8px] text-gray-400 leading-none">{m[0]}</span>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-gray-400 mt-0.5">
        <span>Jan</span><span>Jun</span><span>Dec</span>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function IncidentVerdict({ contrast, activity, conditionRelated, annualObs }: Props) {
  const { headline, bullets } = buildVerdict(contrast);
  const isNearTypical = !headline;

  if (isNearTypical) {
    const note =
      conditionRelated === false
        ? "This incident was flagged as not condition-related."
        : activity && activity !== "unknown"
          ? `Near-typical conditions for this beach; may reflect non-condition factors (supervision, swimming ability, ${activity}).`
          : "Near-typical conditions for this beach; may reflect non-condition factors (supervision, swimming ability).";

    return (
      <section className="bg-amber-50 border border-amber-200 rounded-2xl p-5">
        <p className="text-sm text-amber-800">{note}</p>
      </section>
    );
  }

  const freqEntries = annualObs && annualObs.length > 0 ? computeFrequency(contrast, annualObs) : [];

  return (
    <section className="bg-orange-50 border border-orange-200 rounded-2xl p-5 space-y-4">
      {/* Headline */}
      <p className="text-sm font-semibold text-orange-900 leading-relaxed">{headline}</p>

      {/* Per-factor explanations */}
      {bullets.length > 0 && (
        <ul className="space-y-2">
          {bullets.map((b) => (
            <li key={b.key} className="flex gap-2 text-sm text-orange-800">
              <span className="mt-0.5 shrink-0 text-orange-400">▸</span>
              <span className="leading-relaxed">{b.text}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Frequency section */}
      {freqEntries.length > 0 && (
        <div className="pt-3 border-t border-orange-200 space-y-4">
          <p className="text-xs font-semibold text-orange-700 uppercase tracking-wide">
            How often at this beach (past 12 months)
          </p>
          {freqEntries.map((entry) => (
            <FrequencyChart key={entry.label} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}
