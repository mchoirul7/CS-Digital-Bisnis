import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeAdminRequest } from "@/lib/admin/auth";

function request(headers?: HeadersInit) {
  return new Request("https://example.test/api/admin/conversations", { headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("admin API auth", () => {
  it("mengizinkan mode development tanpa token agar demo lokal tetap ringan", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ADMIN_API_TOKEN", "");

    expect(authorizeAdminRequest(request())).toEqual({ ok: true });
  });

  it("fail closed di production kalau token belum diset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_API_TOKEN", "");

    expect(authorizeAdminRequest(request())).toMatchObject({ ok: false, status: 503 });
  });

  it("menolak token admin yang salah", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_API_TOKEN", "secret-admin-token");

    expect(authorizeAdminRequest(request({ "x-admin-token": "salah" }))).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("menerima bearer token admin yang benar", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_API_TOKEN", "secret-admin-token");

    expect(
      authorizeAdminRequest(request({ authorization: "Bearer secret-admin-token" })),
    ).toEqual({ ok: true });
  });
});
