import { CONFIG } from "../config.ts";
import type { StructuredGenerationArgs, StructuredProvider } from "./types.ts";
import { generateOpenAiCompatible } from "./openai-compatible.ts";

export const omniRouteProvider: StructuredProvider = {
  id: "omniroute",
  normalizeThinkingLevel(_model, requested) { return requested; },
  async generateStructured<T>(args: StructuredGenerationArgs) {
    if (!CONFIG.omniRouteBaseUrl || !CONFIG.omniRouteApiKey) throw new Error("OmniRoute endpoint is not configured");
    return await generateOpenAiCompatible<T>({
      ...args,
      providerId: "omniroute",
      baseUrl: CONFIG.omniRouteBaseUrl,
      apiKey: CONFIG.omniRouteApiKey,
      timeoutMs: CONFIG.modelTimeoutMs,
      // OmniRoute is a generic OpenAI-compatible gateway. Do not force optional
      // reasoning parameters because downstream combinations may not support them.
      sendReasoning: false,
    });
  },
};
