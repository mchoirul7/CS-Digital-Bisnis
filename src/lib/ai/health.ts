import { getGeminiModel } from "@/lib/config";

/**
 * Kesehatan provider bahasa. Pernah terjadi model yang dikonfigurasi tidak
 * tersedia lagi dan SETIAP request diam-diam jatuh ke parser deterministik -
 * dari luar tampak normal. Rekaman ini membuat kegagalan itu terlihat.
 *
 * Ini murni sinyal diagnostik in-memory per instance, bukan sumber kebenaran.
 */
export type AiProviderStatus = "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "NOT_CONFIGURED";

type HealthState = {
  configuredModel: string;
  totalCalls: number;
  totalFailures: number;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
};

const state: HealthState = {
  configuredModel: getGeminiModel(),
  totalCalls: 0,
  totalFailures: 0,
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
};

/** Membuang detail yang tidak perlu dan memastikan tidak ada kunci/kredensial. */
function summarizeFailure(reason: string) {
  const withoutKeys = reason.replace(/AIza[0-9A-Za-z_-]{10,}/g, "[redacted]");
  return withoutKeys.slice(0, 300);
}

export function recordAiSuccess() {
  state.configuredModel = getGeminiModel();
  state.totalCalls += 1;
  state.consecutiveFailures = 0;
  state.lastSuccessAt = new Date().toISOString();
}

export function recordAiFailure(reason: string) {
  state.configuredModel = getGeminiModel();
  state.totalCalls += 1;
  state.totalFailures += 1;
  state.consecutiveFailures += 1;
  state.lastFailureAt = new Date().toISOString();
  state.lastFailureReason = summarizeFailure(reason);
}

export type AiHealthReport = {
  provider: AiProviderStatus;
  gemini: "AVAILABLE" | "UNAVAILABLE" | "NOT_CONFIGURED";
  configured_model: string;
  total_calls: number;
  total_failures: number;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_reason: string | null;
};

/** Tiga kegagalan beruntun berarti provider praktis tidak bisa dipakai. */
const UNAVAILABLE_AFTER_CONSECUTIVE_FAILURES = 3;

export function getAiHealth(hasApiKey: boolean): AiHealthReport {
  const provider: AiProviderStatus = !hasApiKey
    ? "NOT_CONFIGURED"
    : state.consecutiveFailures >= UNAVAILABLE_AFTER_CONSECUTIVE_FAILURES
      ? "UNAVAILABLE"
      : state.consecutiveFailures > 0
        ? "DEGRADED"
        : "HEALTHY";

  return {
    provider,
    gemini: !hasApiKey ? "NOT_CONFIGURED" : provider === "UNAVAILABLE" ? "UNAVAILABLE" : "AVAILABLE",
    configured_model: state.configuredModel,
    total_calls: state.totalCalls,
    total_failures: state.totalFailures,
    consecutive_failures: state.consecutiveFailures,
    last_success_at: state.lastSuccessAt,
    last_failure_at: state.lastFailureAt,
    last_failure_reason: state.lastFailureReason,
  };
}

/** Hanya dipakai test supaya satu kasus tidak mewarisi kondisi kasus lain. */
export function resetAiHealthForTest() {
  state.totalCalls = 0;
  state.totalFailures = 0;
  state.consecutiveFailures = 0;
  state.lastSuccessAt = null;
  state.lastFailureAt = null;
  state.lastFailureReason = null;
}
