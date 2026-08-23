import { describe, it, expect } from "vitest";
import { isNeonUrl } from "./db-url-guard";

describe("isNeonUrl", () => {
  it("detects Neon pooler URLs", () => {
    expect(
      isNeonUrl("postgresql://neondb_owner:pw@ep-jolly-dust-aq608i6v-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require")
    ).toBe(true);
  });

  it("detects bare neon.tech URLs", () => {
    expect(isNeonUrl("postgres://user:pw@neon.tech/db")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isNeonUrl("postgres://user@SOME.NEON.TECH/db")).toBe(true);
  });

  it("passes platform-db in-cluster URLs", () => {
    expect(
      isNeonUrl(
        "postgresql://beachsafe_app:pw@platform-postgres.platform.svc.cluster.local:5432/platform_db?options=-csearch_path%3Dbeachsafe&sslmode=disable"
      )
    ).toBe(false);
  });

  it("passes localhost URLs", () => {
    expect(isNeonUrl("postgresql://localhost:5432/platform_db")).toBe(false);
  });

  it("passes empty string without throwing", () => {
    expect(isNeonUrl("")).toBe(false);
  });
});
