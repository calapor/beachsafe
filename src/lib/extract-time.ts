// Pure utility — no network, no DB. Safely importable in tests.

// Parse a clock string from text and return "HH:MM" (24h) or null.
// Recognises: "14:30", "2:30pm", "3pm", "3 PM", "midday", "noon", "midnight",
// "shortly after 3pm", "at 14.30". Rejects vague phrases like "in the afternoon".
export function extractReportedTime(text: string): string | null {
  if (!text) return null;

  // Special words
  if (/\b(midday|noon)\b/i.test(text)) return "12:00";
  if (/\bmidnight\b/i.test(text)) return "00:00";

  // HH:MM or HH.MM optionally followed by am/pm
  const hmRe = /\b(2[0-3]|[01]?\d)[:.]([ 0-5]\d)\s*(am|pm)?\b/i;
  const hmMatch = text.match(hmRe);
  if (hmMatch) {
    let h = parseInt(hmMatch[1], 10);
    const m = parseInt(hmMatch[2], 10);
    if (isNaN(h) || isNaN(m)) return null;
    const ampm = (hmMatch[3] ?? "").toLowerCase();
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    if (h > 23 || m > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  // "3pm" or "3 PM" — hour only
  const hourRe = /\b(1[0-2]|[1-9])\s*(am|pm)\b/i;
  const hourMatch = text.match(hourRe);
  if (hourMatch) {
    let h = parseInt(hourMatch[1], 10);
    const ampm = hourMatch[2].toLowerCase();
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:00`;
  }

  return null;
}

// Guard: accept an LLM-extracted time only when the literal clock figure
// (or a natural-language equivalent) appears in the source text.
// Returns the extracted value if verified, null otherwise.
export function verifyReportedTime(description: string, extracted: string | null): string | null {
  if (!extracted) return null;

  // If the regex independently finds a time AND it matches what was extracted, it's verified.
  const regexFound = extractReportedTime(description);
  if (regexFound === extracted) return extracted;

  // Also accept if the literal "HH:MM" string appears verbatim in the text.
  if (description.includes(extracted)) return extracted;

  return null;
}
