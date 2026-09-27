import { buildCatalogVocabulary, extractStructuredRequest } from "@/lib/ai/intent-extractor";
import { generateResponse, renderDeterministicResponse } from "@/lib/ai/response-generator";
import { processBusinessRequest } from "@/lib/business/business-engine";
import type { BusinessResult, StructuredRequest } from "@/lib/business/types";
import { evaluateBusinessGuard } from "@/lib/business-guard";
import { getBusinessRepository } from "@/lib/business-tools/repository";
import { isExplicitOrderConfirmation } from "@/lib/business-tools/order-service";
import type {
  BusinessRepository,
  ConversationOwnership,
  Message,
} from "@/lib/business-tools/types";
import { DEFAULT_COMPANY_ID } from "@/lib/company";
import { getGeminiApiKey } from "@/lib/config";
import { buildHandoffMetadata, buildHandoffSummary, ensureHandoff } from "@/lib/handoff";
import {
  nextConversationState,
  parseConversationState,
  resolveConversationContext,
  type ConversationState,
  type ProductSource,
} from "./conversation-state";
import type {
  ChatAudit,
  ChatHistoryMessage,
  ChatServiceInput,
  ChatServiceOutput,
} from "./types";

export type ChatServiceOptions = {
  repository?: BusinessRepository;
  /** Mematikan pemanggilan Gemini; dipakai oleh test dan mode offline. */
  forceDeterministicAi?: boolean;
};

const HISTORY_LIMIT = 20;

/** AI hanya menjawab saat percakapan masih miliknya. */
function aiMayRespond(ownership: ConversationOwnership) {
  return ownership === "AI_ACTIVE" || ownership === "HUMAN_PENDING";
}

function toHistory(messages: Message[]): ChatHistoryMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role === "user" ? ("user" as const) : ("assistant" as const),
      content: message.content,
      sender: message.sender,
    }));
}

function buildAudit(result: BusinessResult, productSource: ProductSource): ChatAudit {
  const resolution = result.product_resolution;

  return {
    intent: result.intent,
    secondary_intents: result.supplementary.map((item) => item.intent),
    requested_product: result.requested.product_query,
    resolved_product: result.product?.name ?? null,
    product_source: productSource,
    product_match_status: resolution?.status ?? null,
    product_match_confidence: resolution?.confidence ?? null,
    product_match_reason: resolution?.reason ?? null,
    requested_quantity: result.requested.quantity,
    requested_unit: result.requested.unit,
    database_unit: result.product?.unit ?? null,
    current_stock: result.availability?.quantity ?? null,
    unit_match: result.unit_match,
    sufficient_stock: result.stock_sufficient,
    order_allowed: result.order_allowed,
    price: result.price,
    total: result.total,
    packaging_per_outer: result.packaging?.quantity_per_outer ?? null,
    listed_product_count: result.listed_products.length,
    status: result.status,
    reason: result.reason,
  };
}

function requestFromPaymentProof(request: StructuredRequest): StructuredRequest {
  const operation = {
    action: "PAYMENT_PROOF_SUBMITTED" as const,
    product_query: null,
    catalog_product_name: null,
    product_id: null,
    quantity: null,
    unit: null,
  };

  return {
    ...request,
    intent: "PAYMENT_PROOF_SUBMITTED",
    operations: [operation],
    product_query: null,
    catalog_product_name: null,
    quantity: null,
    unit: null,
  };
}

/**
 * Pipeline: pemahaman bahasa -> resolusi konteks -> keputusan bisnis
 * deterministik -> penjagaan fakta -> penyusunan bahasa. Model bahasa hanya
 * dipakai di ujung pertama dan ujung terakhir, tidak pernah di tengah.
 *
 * ConversationState disimpan di database dan dibaca ulang setiap request,
 * sehingga konteks bertahan antar HTTP request dan antar instance serverless.
 */
export async function handleChatMessage(
  input: ChatServiceInput,
  options: ChatServiceOptions = {},
): Promise<ChatServiceOutput> {
  const repository = options.repository ?? getBusinessRepository();
  const companyId = DEFAULT_COMPANY_ID;
  const apiKey = options.forceDeterministicAi ? undefined : getGeminiApiKey();

  const company = await repository.getCompany(companyId);
  if (!company) {
    throw new Error("Default company tidak ditemukan. Jalankan seed database terlebih dahulu.");
  }

  const conversation = await repository.upsertConversation(companyId, input.sessionId);
  const ownershipBefore = conversation.ownership;
  const stateVersion = conversation.state_version;

  const storedState = parseConversationState(conversation.state);
  const previousState: ConversationState =
    Object.keys(storedState).length > 0 ? storedState : input.initialState ?? {};

  const priorMessages = await repository.listMessages(conversation.id, HISTORY_LIMIT);
  const history = toHistory(priorMessages);

  await repository.addMessage(conversation.id, "user", input.message, "CUSTOMER");

  // Percakapan sedang dipegang admin: pesan customer tetap tersimpan supaya
  // admin melihatnya, tetapi AI tidak boleh menjawab apa pun.
  if (!aiMayRespond(ownershipBefore)) {
    return {
      reply: null,
      conversationId: conversation.id,
      ownership: ownershipBefore,
      state: previousState,
      debug: null,
    };
  }

  // Katalog dibaca sekali per request dan dipakai ulang oleh extractor dan
  // business engine. Kalau pembacaannya gagal, engine menjawab "belum bisa
  // dicek" alih-alih menebak.
  let catalog: Awaited<ReturnType<BusinessRepository["listProducts"]>> = [];
  let catalogError: string | undefined;

  try {
    catalog = await repository.listProducts(companyId);
  } catch (error) {
    catalogError = error instanceof Error ? error.message : "listProducts gagal";
  }

  const vocabulary = buildCatalogVocabulary(catalog);

  const extraction = await extractStructuredRequest({
    message: input.message,
    history,
    state: previousState,
    vocabulary,
    catalogNames: catalog.map((product) => product.name),
    apiKey,
  });

  const groundedRequest = isExplicitOrderConfirmation(input.message)
    ? { ...extraction.request, intent: "CONFIRMATION" as const, operations: [], product_query: null, quantity: null, unit: null }
    : extraction.request;
  const resolved = resolveConversationContext(groundedRequest, previousState);
  const attachments = input.attachments ?? [];
  const effectiveRequest = attachments.length > 0
    ? requestFromPaymentProof(resolved.request)
    : resolved.request;

  const {
    result: businessResult,
    toolCalls,
    productSource,
    draftItems,
  } = await processBusinessRequest({
    repository,
    companyId,
    conversationId: conversation.id,
    ownership: ownershipBefore,
    request: effectiveRequest,
    state: resolved.state,
    catalog,
    catalogError,
    customerMessage: input.message,
    attachments,
    customerPhone: input.customerPhone,
  });

  let result = businessResult;
  let ownershipAfter: ConversationOwnership =
    result.handoff.required && result.handoff.handoff_id
      ? result.handoff.status === "ACTIVE"
        ? "HUMAN_ACTIVE"
        : "HUMAN_PENDING"
      : ownershipBefore;

  const isFollowUp = productSource === "CONVERSATION_STATE";

  const generated = await generateResponse({
    message: input.message,
    history,
    result,
    isFollowUp,
    apiKey,
  });

  const officialPaymentAccounts = await repository.listPaymentAccounts(companyId);
  const guardResult = evaluateBusinessGuard({
    response: generated.candidate,
    businessResult: result,
    officialPaymentAccounts,
  });

  let finalResponse = guardResult.allowed ? generated.candidate : generated.fallback;

  // Guard memblokir jawaban model: customer tidak pernah menerima kalimat itu,
  // dan percakapannya diserahkan ke admin supaya tidak berhenti di jalan buntu.
  // Kalau yang diblokir justru template deterministik, jawaban amannya sudah
  // terkirim - tidak perlu merepotkan admin.
  if (!guardResult.allowed && generated.source === "gemini") {
    try {
      const escalation = await ensureHandoff({
        repository,
        conversationId: conversation.id,
        ownership: ownershipAfter,
        reasonCode: "UNSAFE_RESPONSE_BLOCKED",
        reason: guardResult.fallbackReason ?? "BUSINESS_GUARD_BLOCKED_RESPONSE",
        summary: buildHandoffSummary({
          reasonCode: "UNSAFE_RESPONSE_BLOCKED",
          customerMessage: input.message,
          result,
        }),
        metadata: buildHandoffMetadata(result),
      });

      ownershipAfter = escalation.ownershipAfter;
      result = {
        ...result,
        handoff: {
          required: true,
          reason_code: result.handoff.reason_code ?? "UNSAFE_RESPONSE_BLOCKED",
          handoff_id: escalation.handoff.id,
          status: escalation.handoff.status,
        },
      };
      finalResponse = renderDeterministicResponse(result, { isFollowUp });
    } catch {
      // Pencatatan handoff gagal: jawaban deterministik tetap aman dikirim.
    }
  }

  let nextState = nextConversationState(previousState, effectiveRequest, result, draftItems);
  if (result.status === "ORDER_PERSISTED") {
    const persisted = await repository.getConversation(companyId, conversation.id);
    nextState = parseConversationState(persisted?.state);
  } else {
    await repository.saveConversationState(conversation.id, nextState, stateVersion);
  }
  try {
    await repository.recordBusinessAudit({ companyId, conversationId: conversation.id, toolCalls,
      guards: [
        ...guardResult.checks.filter((check) => check.status === "blocked").map((check) => ({
          type: check.name, action: "blocked" as const, reason: check.detail,
        })),
        ...extraction.rejected.map((reason) => ({ type: "model_grounding", action: "blocked" as const, reason })),
        ...result.operation_results.filter((operation) => operation.status !== "APPLIED").map((operation) => ({
          type: operation.status, action: "blocked" as const, reason: operation.reason,
        })),
        { type: result.status, action: result.order_allowed || result.status === "ORDER_REVIEWED" ? "allowed" : "blocked", reason: result.reason },
      ],
    });
  } catch (error) {
    console.error("Business audit persistence failed", error);
  }
  await repository.addMessage(conversation.id, "assistant", finalResponse, "AI");

  return {
    reply: finalResponse,
    conversationId: conversation.id,
    ownership: ownershipAfter,
    state: nextState,
    debug: {
      rawMessage: input.message,
      structuredRequest: extraction.request,
      effectiveRequest,
      intentSource: extraction.source,
      groundingRejections: extraction.rejected,
      conversationStateBefore: previousState,
      conversationStateAfter: nextState,
      contextResolution: {
        product_source: productSource,
        active_product_before: previousState.activeProduct ?? null,
        active_product_after: nextState.activeProduct ?? null,
        inherited_intent: resolved.inheritedIntent,
        inherited_quantity: resolved.inheritedQuantity,
        inherited_unit: resolved.inheritedUnit,
        scoped_to_pending_candidates: productSource === "PENDING_CANDIDATE",
        notes: resolved.notes,
      },
      productResolution: result.product_resolution,
      unitResolution: result.unit_resolution,
      toolCalls,
      businessResult: result,
      audit: buildAudit(result, productSource),
      handoff: {
        triggered: result.handoff.required,
        reason_code: result.handoff.reason_code,
        business_reason: result.reason,
        handoff_id: result.handoff.handoff_id,
        status: result.handoff.status,
      },
      ownershipBefore,
      ownershipAfter,
      aiResponseAllowed: true,
      aiCandidateResponse: generated.candidate,
      responseSource: generated.source,
      businessGuard: guardResult,
      finalResponse,
      geminiError: extraction.error ?? generated.error,
    },
  };
}
