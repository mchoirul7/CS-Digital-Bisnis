import { handleChatMessage, type ChatServiceOptions } from "@/lib/chat/service";
import type { ConversationOwnership } from "@/lib/business-tools/types";
import type { ConversationState } from "@/lib/chat/conversation-state";
import type { ChatDebug, ChatServiceInput } from "@/lib/chat/types";

export type ChatTurn = {
  reply: string;
  debug: ChatDebug;
  conversationId: string;
  ownership: ConversationOwnership;
  state: ConversationState;
};

/**
 * Pembungkus untuk test yang memang mengharapkan AI menjawab. Kalau AI sengaja
 * diam (percakapan dipegang admin), ini gagal dengan pesan jelas - test yang
 * menguji kebisuan AI memanggil handleChatMessage langsung.
 */
export async function sendChatTurn(
  input: ChatServiceInput,
  options: ChatServiceOptions,
): Promise<ChatTurn> {
  const result = await handleChatMessage(input, options);

  if (result.reply === null || result.debug === null) {
    throw new Error(
      `AI tidak menjawab karena percakapan berstatus ${result.ownership}; pakai handleChatMessage langsung untuk menguji kondisi ini.`,
    );
  }

  return {
    reply: result.reply,
    debug: result.debug,
    conversationId: result.conversationId,
    ownership: result.ownership,
    state: result.state,
  };
}
