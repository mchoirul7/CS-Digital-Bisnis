import { ensureHandoff } from "@/lib/handoff";
import type { BusinessToolContext } from "./recorder";
import type { HandoffReasonCode } from "./types";

/**
 * Informasi pengiriman belum punya sumber data. Tool tetap dipanggil supaya
 * jejaknya tercatat, dan hasilnya selalu "belum tersedia" - bukan janji.
 */
export async function getDeliveryInformation(
  context: BusinessToolContext,
  requestedTime: string | null,
) {
  return context.recorder.run(
    "get_delivery_information",
    { requested_time: requestedTime },
    async () => ({
      ok: true,
      available: false,
      requested_time: requestedTime,
      reason: "DELIVERY_SCHEDULE_NOT_IN_SYSTEM",
    }),
  );
}

export type HandoffToolInput = {
  reasonCode: HandoffReasonCode;
  reason: string;
  summary: string;
  metadata: Record<string, unknown>;
};

/**
 * Membuat handoff yang benar-benar tersimpan. Kalimat "saya teruskan ke admin"
 * hanya boleh dikirim ke customer kalau tool ini berhasil.
 */
export async function requestHumanHandoff(
  context: BusinessToolContext,
  input: HandoffToolInput,
) {
  return context.recorder.run(
    "request_human_handoff",
    { reason_code: input.reasonCode, reason: input.reason },
    async () => {
      if (!context.conversationId) {
        return {
          ok: false,
          handoff_id: null,
          status: null,
          reason_code: input.reasonCode,
          created: false,
          ownership_before: context.ownership ?? "AI_ACTIVE",
          ownership_after: context.ownership ?? "AI_ACTIVE",
        };
      }

      const result = await ensureHandoff({
        repository: context.repository,
        conversationId: context.conversationId,
        ownership: context.ownership ?? "AI_ACTIVE",
        reasonCode: input.reasonCode,
        reason: input.reason,
        summary: input.summary,
        metadata: input.metadata,
      });

      return {
        ok: true,
        handoff_id: result.handoff.id as string | null,
        status: result.handoff.status as string | null,
        reason_code: result.handoff.reason_code,
        created: result.created,
        ownership_before: result.ownershipBefore,
        ownership_after: result.ownershipAfter,
      };
    },
  );
}
