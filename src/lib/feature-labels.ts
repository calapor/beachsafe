// Single source of truth for human-readable feature names, units, and value formatters.

export interface FeatureLabel {
  label: string;
  unit: string;
  format: (normalised: number) => string;
}

export const FEATURE_LABELS: Record<string, FeatureLabel> = {
  onshoreComponent: {
    label: "Onshore wind",
    unit: "",
    format: (v) => v >= 0.7 ? "Direct" : v >= 0.35 ? "Partial" : "Weak",
  },
  maxWave: {
    label: "Max wave height",
    unit: "m",
    format: (v) => `${(v * 5).toFixed(1)} m`,
  },
  tideRange: {
    label: "Tidal range",
    unit: "m",
    format: (v) => `${(v * 5).toFixed(1)} m`,
  },
  pressureDrop: {
    label: "Pressure drop",
    unit: "hPa",
    format: (v) => `${(v * 30).toFixed(0)} hPa`,
  },
  tideState: {
    label: "Tide state",
    unit: "",
    format: (v) => v < -0.3 ? "Ebbing" : v > 0.3 ? "Flooding" : "Slack",
  },
  maxGust: {
    label: "Max gust",
    unit: "kts",
    format: (v) => `${(v * 50).toFixed(0)} kts`,
  },
  meanWind: {
    label: "Mean wind",
    unit: "kts",
    format: (v) => `${(v * 30).toFixed(0)} kts`,
  },
  hoursFromHigh: {
    label: "Hours from HW",
    unit: "",
    format: (v) => v > 0.8 ? "Near LW" : v > 0.5 ? "Mid-ebb/flood" : "Near HW",
  },
  wavePeriod: {
    label: "Wave period",
    unit: "s",
    format: (v) => `${(v * 20).toFixed(0)} s`,
  },
  totalRain: {
    label: "Total rainfall",
    unit: "mm",
    format: (v) => `${(v * 50).toFixed(0)} mm`,
  },
  seaTempCold: {
    label: "Cold water risk",
    unit: "",
    format: (v) => v > 0.5 ? "Cold" : v > 0.2 ? "Cool" : "Mild",
  },
  moonIllum: {
    label: "Lunar tidal force",
    unit: "",
    format: (v) => v > 0.7 ? "Spring (full/new moon)" : v > 0.3 ? "Intermediate" : "Neap (quarter moon)",
  },
  warmCalm: {
    label: "Warm & calm",
    unit: "",
    format: (v) => v > 0.5 ? "High" : v > 0.2 ? "Moderate" : "Low",
  },
};
