import { generateStructured, GeminiApiError, type ThinkingLevel } from "../gemini.ts";
import { ProviderApiError, type StructuredGenerationArgs, type StructuredProvider } from "./types.ts";

export const googleProvider: StructuredProvider = {
  id: "google",
  normalizeThinkingLevel(model: string, requested: ThinkingLevel): ThinkingLevel {
    // 3.8 and 3.7 support low/medium/high but reject minimal.
    if (/^gemini-3\.(8|7)-flash/i.test(model) && requested === "MINIMAL") return "LOW";
    return requested;
  },
  async generateStructured<T>(args: StructuredGenerationArgs) {
    try {
      return await generateStructured<T>(args);
    } catch (error) {
      if (error instanceof GeminiApiError) {
        throw new ProviderApiError({
          message: error.message,
          provider: "google",
          status: error.status,
          apiStatus: error.apiStatus,
          model: error.model,
          operation: error.operation,
          quotaMetric: error.quotaMetric,
          quotaId: error.quotaId,
          retryAfterMs: error.retryAfterMs,
          rawDetail: error.rawDetail,
        });
      }
      throw error;
    }
  },
};
