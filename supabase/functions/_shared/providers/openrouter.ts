import { CONFIG } from "../config.ts";
import type { StructuredGenerationArgs, StructuredProvider } from "./types.ts";
import { generateOpenAiCompatible } from "./openai-compatible.ts";

export const openRouterProvider: StructuredProvider = {
  id: "openrouter",
  normalizeThinkingLevel(_model, requested) { return requested === "MINIMAL" ? "LOW" : requested; },
  async generateStructured<T>(args: StructuredGenerationArgs) {
    if (!CONFIG.openRouterApiKey) throw new Error("OPENROUTER_API_KEY is not configured");
    const isDynamicRouter = /^openrouter\/(free|auto)$/i.test(args.model);
    return await generateOpenAiCompatible<T>({
      ...args,
      providerId: "openrouter",
      baseUrl: CONFIG.openRouterBaseUrl,
      apiKey: CONFIG.openRouterApiKey,
      timeoutMs: CONFIG.modelTimeoutMs,
      sendReasoning: !isDynamicRouter,
      providerPreferences: {
        allow_fallbacks: true,
        require_parameters: true,
        ...(CONFIG.openRouterDenyDataCollection ? { data_collection: "deny" } : {}),
        ...(CONFIG.openRouterEnforceZdr ? { zdr: true } : {}),
      },
      extraHeaders: { "X-Title": "Personal OS" },
    });
  },
};
