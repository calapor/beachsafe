import type { AtTimeConditions } from "@/lib/incident-conditions";
import type { TideDescription, TideStep } from "@/lib/similarity";

function windDirLabel(deg: number | null): string {
  if (deg == null) return "—";
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

function fmt(v: number | null, digits = 1, suffix = ""): string {
  return v == null ? "—" : `${v.toFixed(digits)}${suffix}`;
}

function formatMins(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function TideDirectionPill({ direction }: { direction: TideDescription["direction"] }) {
  const config = {
    flooding: "bg-blue-100 text-blue-800",
    ebbing:   "bg-teal-100 text-teal-800",
    slack:    "bg-gray-100 text-gray-600",
  };
  const label = {
    flooding: "Flooding ↑",
    ebbing:   "Ebbing ↓",
    slack:    "Slack",
  };
  return (
    <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full ${config[direction]}`}>
      {label[direction]}
    </span>
  );
}

interface Props {
  timeLabel: string;
  atTime: AtTimeConditions;
  window: AtTimeConditions[];
  tideDesc: TideDescription | null;
  tideWindow: TideStep[];
}

export function ConditionsAtTime({ timeLabel, atTime, window: win, tideDesc, tideWindow }: Props) {
  return (
    <section className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-gray-900">Conditions at {timeLabel}</h2>
        <span className="text-xs text-gray-400">Modelled nearshore hourly (Open-Meteo)</span>
      </div>

      {/* At-time snapshot */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-1">
        <div className="flex justify-between py-1.5 border-b border-gray-100">
          <span className="text-sm text-gray-500">Wind</span>
          <span className="text-sm font-medium text-gray-900">
            {atTime.wind_kn != null ? `${atTime.wind_kn.toFixed(0)} kts ${windDirLabel(atTime.wind_dir_deg)}` : "—"}
          </span>
        </div>
        <div className="flex justify-between py-1.5 border-b border-gray-100">
          <span className="text-sm text-gray-500">Gust</span>
          <span className="text-sm font-medium text-gray-900">{fmt(atTime.gust_kn, 0, " kts")}</span>
        </div>
        <div className="flex justify-between py-1.5 border-b border-gray-100">
          <span className="text-sm text-gray-500">Swell height</span>
          <span className="text-sm font-medium text-gray-900">{fmt(atTime.swell_m, 2, " m")}</span>
        </div>
        <div className="flex justify-between py-1.5 border-b border-gray-100">
          <span className="text-sm text-gray-500">Swell period</span>
          <span className="text-sm font-medium text-gray-900">{fmt(atTime.swell_period_s, 1, " s")}</span>
        </div>
        <div className="flex justify-between py-1.5 border-b border-gray-100">
          <span className="text-sm text-gray-500">Wave height</span>
          <span className="text-sm font-medium text-gray-900">{fmt(atTime.wave_m, 2, " m")}</span>
        </div>
        <div className="flex justify-between py-1.5 border-b border-gray-100">
          <span className="text-sm text-gray-500">Wind-wave height</span>
          <span className="text-sm font-medium text-gray-900">{fmt(atTime.wind_wave_m, 2, " m")}</span>
        </div>
        <div className="flex justify-between py-1.5">
          <span className="text-sm text-gray-500">Pressure</span>
          <span className="text-sm font-medium text-gray-900">{fmt(atTime.mslp_hpa, 1, " hPa")}</span>
        </div>
      </div>

      {/* Tide state */}
      {tideDesc && (
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-1">
            <TideDirectionPill direction={tideDesc.direction} />
            <span className="text-sm text-blue-900 font-medium">
              {formatMins(tideDesc.sincePrev.mins)} after {tideDesc.sincePrev.label}
              {", "}~{formatMins(tideDesc.toNext.mins)} to {tideDesc.toNext.label}
            </span>
          </div>
        </div>
      )}

      {/* 60-min trajectory strip */}
      {(win.length > 0 || tideWindow.length > 0) && (
        <div>
          <p className="text-xs text-gray-400 mb-2">60 min before incident</p>
          <div className="flex gap-1 overflow-x-auto pb-1">
            {tideWindow.map((step) => {
              const hourlyRow = win.find((r) => {
                const rowMins = parseInt(r.time.split(":")[0]) * 60 + parseInt(r.time.split(":")[1]);
                const incidentMins = parseInt(timeLabel.split(":")[0]) * 60 + parseInt(timeLabel.split(":")[1]);
                return Math.abs(rowMins - (incidentMins + step.minsOffset)) <= 30;
              });

              const tideBarH = Math.max(4, Math.round(((step.tideState + 1) / 2) * 40));
              const tideColor =
                step.tideState > 0.3 ? "bg-blue-400" :
                step.tideState < -0.3 ? "bg-teal-400" : "bg-gray-300";

              return (
                <div key={step.minsOffset} className="flex-1 min-w-[52px] flex flex-col items-center gap-1">
                  <span className="text-[10px] text-gray-400 tabular-nums">
                    {step.minsOffset === 0 ? "now" : `T${step.minsOffset}m`}
                  </span>
                  {hourlyRow?.wind_kn != null && (
                    <span className="text-xs font-medium text-gray-700">{hourlyRow.wind_kn.toFixed(0)} kt</span>
                  )}
                  <div className="w-full flex items-end justify-center h-10">
                    <div className={`w-4 rounded-t ${tideColor}`} style={{ height: `${tideBarH}px` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex gap-2 mt-1">
            <span className="inline-flex items-center gap-1 text-[10px] text-gray-400">
              <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" /> Flooding
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] text-gray-400">
              <span className="w-2 h-2 rounded-full bg-teal-400 inline-block" /> Ebbing
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
