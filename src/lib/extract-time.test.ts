import { describe, it, expect } from "vitest";
import { extractReportedTime, verifyReportedTime } from "./extract-time";

describe("extractReportedTime", () => {
  it("parses 24h time", () => {
    expect(extractReportedTime("Incident occurred at 14:30")).toBe("14:30");
  });

  it("parses 12h time with pm suffix", () => {
    expect(extractReportedTime("shortly after 3pm")).toBe("15:00");
  });

  it("parses HH:MM with am/pm", () => {
    expect(extractReportedTime("launched at 10:45 am")).toBe("10:45");
    expect(extractReportedTime("launched at 10:45 pm")).toBe("22:45");
  });

  it("parses midday / noon", () => {
    expect(extractReportedTime("occurred around midday")).toBe("12:00");
    expect(extractReportedTime("It was noon")).toBe("12:00");
  });

  it("parses midnight", () => {
    expect(extractReportedTime("shortly after midnight")).toBe("00:00");
  });

  it("returns null for vague phrases", () => {
    expect(extractReportedTime("in the afternoon")).toBeNull();
    expect(extractReportedTime("during the morning")).toBeNull();
    expect(extractReportedTime("it was getting late")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractReportedTime("")).toBeNull();
  });

  it("handles HH.MM format", () => {
    expect(extractReportedTime("at 14.30 the lifeboat launched")).toBe("14:30");
  });
});

describe("verifyReportedTime", () => {
  it("accepts a time that matches what the regex also finds", () => {
    expect(verifyReportedTime("launched at 14:30 from Crosshaven", "14:30")).toBe("14:30");
  });

  it("rejects a time not present in the source", () => {
    expect(verifyReportedTime("it was in the afternoon", "15:00")).toBeNull();
  });

  it("accepts null extracted → returns null", () => {
    expect(verifyReportedTime("launched at 14:30", null)).toBeNull();
  });

  it("accepts literal verbatim match even without regex match", () => {
    // The description contains "15:30" literally
    expect(verifyReportedTime("call received at 15:30", "15:30")).toBe("15:30");
  });

  it("rejects a fabricated time with no textual anchor", () => {
    expect(verifyReportedTime("Capsized off the headland, all recovered safely.", "09:00")).toBeNull();
  });
});
