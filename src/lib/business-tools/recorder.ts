import type {
  BusinessRepository,
  BusinessToolExecution,
  BusinessToolName,
  ConversationOwnership,
  Product,
} from "./types";

export type BusinessToolContext = {
  repository: BusinessRepository;
  companyId: string;
  conversationId?: string;
  /** Kepemilikan percakapan saat tool dijalankan; dipakai saat membuat handoff. */
  ownership?: ConversationOwnership;
  /** Katalog yang sudah dibaca sekali per request, supaya tidak dibaca berulang. */
  catalog?: Product[];
  recorder: BusinessToolRecorder;
};

/**
 * Mencatat setiap panggilan business tool beserta hasil mentah database supaya
 * debug audit bisa menampilkan jejak fakta dari mana angka jawaban berasal.
 */
export class BusinessToolRecorder {
  private readonly executions: BusinessToolExecution[] = [];

  async run<T>(
    toolName: BusinessToolName,
    args: Record<string, unknown>,
    execute: () => Promise<T>,
  ): Promise<T> {
    let result: T;
    try {
      result = await execute();
    } catch (error) {
      this.executions.push({ tool_name: toolName, arguments: args, database_result: null,
        timestamp: new Date().toISOString(), success: false,
        error: error instanceof Error ? error.message : "TOOL_FAILED" });
      throw error;
    }

    this.executions.push({
      tool_name: toolName,
      arguments: args,
      database_result: result,
      timestamp: new Date().toISOString(),
    });

    return result;
  }

  list(): BusinessToolExecution[] {
    return [...this.executions];
  }
}
