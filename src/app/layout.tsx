import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { WelcomeWizard } from "@/components/welcome-wizard";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "BeachSafe Ireland",
  description: "Coastal incident condition-matching and alerting for Irish beaches",
};

const WIZARD_SLIDES = [
  {
    title: "Welcome to BeachSafe Ireland 🌊",
    content: (
      <div className="space-y-3">
        <p>
          BeachSafe tracks decades of environmental data — weather, wind, waves, tides, and moon
          phase — alongside a curated record of past coastal incidents at three Irish beaches.
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Fountainstown</strong>, Cork — sheltered SE-facing cove</li>
          <li><strong>Ballybunion</strong>, Kerry — exposed Atlantic beach</li>
          <li><strong>Skerries</strong>, Dublin — tidal E-coast exposure</li>
        </ul>
        <p>When today's forecast conditions resemble those of past dangerous days, we raise an alert.</p>
      </div>
    ),
  },
  {
    title: "How the similarity engine works",
    content: (
      <div className="space-y-3">
        <p>
          Each past incident generates a <strong>feature fingerprint</strong>: day-of and 7-day-prior
          aggregates of onshore wind, wave height, tide range, pressure drop, moon illumination, and rainfall.
        </p>
        <p>
          Forecast conditions are scored against every fingerprint using a{" "}
          <strong>weighted Gaussian similarity</strong> function — with extra weight on onshore wind
          component, wave height, spring tides, and rapid pressure drops.
        </p>
        <p className="text-orange-700 font-medium">
          This is a pattern match, not a prediction of certainty. High similarity means the
          conditions resemble a past dangerous day — not that an incident will occur.
        </p>
      </div>
    ),
  },
  {
    title: "Data sources & coverage",
    content: (
      <div className="space-y-3">
        <p>Data is ingested from free, open Irish and EU sources:</p>
        <ul className="list-disc pl-5 space-y-1 text-xs">
          <li><strong>Weather</strong>: Met Éireann daily CSV (50+ years)</li>
          <li><strong>Waves</strong>: Marine Institute ERDDAP buoy network (~20 years)</li>
          <li><strong>Tides</strong>: Harmonic estimation from moon phase (pre-2006); OPW gauge data after 2006</li>
          <li><strong>Moon</strong>: Computed via SunCalc for any date</li>
          <li><strong>Incidents</strong>: RNLI open data 2008–2016 + hand-curated news/inquest records</li>
        </ul>
        <p className="text-xs text-gray-500">
          Because incidents are few, the engine is similarity-based rather than a trained ML model.
          Coverage gaps (especially pre-2005 waves) are flagged per observation.
        </p>
      </div>
    ),
  },
  {
    title: "You're all set",
    content: (
      <div className="space-y-4">
        <div className="flex items-center justify-center">
          <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center text-3xl">✓</div>
        </div>
        <p>
          Browse the <strong>dashboard</strong> to see live alert levels for all three beaches,
          dive into a beach's incident history, or explore the{" "}
          <a href="/methodology" className="text-blue-600 underline">methodology page</a> for full data provenance.
        </p>
        <p className="italic text-xs text-gray-500">
          BeachSafe is a research tool. Always follow lifeguard and coast guard advice.
          Alert levels reflect historical pattern similarity only.
        </p>
      </div>
    ),
  },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-slate-50 text-gray-900">
        {children}
        <WelcomeWizard slides={WIZARD_SLIDES} sessionKey="beachsafe_welcome_seen" />
        {/* version badge — outside ThemeProvider, fixed bottom-right */}
        <div
          style={{
            position: "fixed",
            bottom: 8,
            right: 12,
            fontSize: 11,
            color: "#888",
            userSelect: "none",
            pointerEvents: "none",
            zIndex: 40,
          }}
        >
          {process.env.APP_VERSION ?? "dev"}
        </div>
      </body>
    </html>
  );
}
