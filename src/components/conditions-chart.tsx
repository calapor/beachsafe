"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

interface DayPoint {
  date: string;
  wind?: number | null;
  wave?: number | null;
  rain?: number | null;
  pressure?: number | null;
}

export function ConditionsChart({ data }: { data: DayPoint[] }) {
  const formatted = data.map((d) => ({
    date: d.date.slice(5), // MM-DD
    Wind: d.wind ?? undefined,
    Wave: d.wave ?? undefined,
    Rain: d.rain ?? undefined,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={formatted} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line type="monotone" dataKey="Wind" stroke="#3b82f6" dot={false} strokeWidth={2} />
        <Line type="monotone" dataKey="Wave" stroke="#06b6d4" dot={false} strokeWidth={2} />
        <Line type="monotone" dataKey="Rain" stroke="#8b5cf6" dot={false} strokeWidth={1.5} strokeDasharray="4 2" />
      </LineChart>
    </ResponsiveContainer>
  );
}
