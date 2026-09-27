import { createHash, timingSafeEqual } from "node:crypto";
import { getAdminApiToken } from "@/lib/config";

export type AdminAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

function tokenFromRequest(request: Request) {
  const explicit = request.headers.get("x-admin-token")?.trim();
  if (explicit) {
    return explicit;
  }

  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = authorization.match(/^bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function safeEqual(left: string, right: string) {
  const leftBuffer = createHash("sha256").update(left).digest();
  const rightBuffer = createHash("sha256").update(right).digest();

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function authorizeAdminRequest(request: Request): AdminAuthResult {
  const configuredToken = getAdminApiToken();

  if (!configuredToken) {
    if (process.env.NODE_ENV === "production") {
      return {
        ok: false,
        status: 503,
        error: "ADMIN_API_TOKEN belum dikonfigurasi.",
      };
    }

    return { ok: true };
  }

  if (!safeEqual(tokenFromRequest(request), configuredToken)) {
    return { ok: false, status: 401, error: "Token admin tidak valid." };
  }

  return { ok: true };
}
