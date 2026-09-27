import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("konfigurasi runtime", () => {
  it("fallback company id sama dengan seed lokal", async () => {
    vi.stubEnv("DEFAULT_COMPANY_ID", "");
    vi.resetModules();

    const { DEFAULT_COMPANY_ID, LOCAL_SEED_COMPANY_ID } = await import("@/lib/company");

    expect(DEFAULT_COMPANY_ID).toBe(LOCAL_SEED_COMPANY_ID);
  });

  it("company id production bisa dioverride lewat env", async () => {
    vi.stubEnv("DEFAULT_COMPANY_ID", "6ec90d80-4658-4df2-ba43-b6475b01c0fd");
    vi.resetModules();

    const { DEFAULT_COMPANY_ID } = await import("@/lib/company");

    expect(DEFAULT_COMPANY_ID).toBe("6ec90d80-4658-4df2-ba43-b6475b01c0fd");
  });
});
