import { CONFIG } from "../config.ts";
import type { StructuredGenerationArgs, StructuredProvider } from "./types.ts";
import { generateOpenAiCompatible } from "./openai-compatible.ts";
import { nvidiaStructuredRequestProfile } from "./nvidia-models.ts";

export const nvidiaProvider: StructuredProvider = {
  id: "nvidia",
  normalizeThinkingLevel(_model, requested) {
    // The Personal OS uses one structured response for the conversational answer
    // plus memory operations. Hosted NIM JSON mode is materially more reliable
    // with visible thinking disabled, so routing depth is expressed through model
    // choice/retrieval depth rather than a visible reasoning trace.
    return requested === "MINIMAL" ? "LOW" : requested;
  },
  async generateStructured<T>(args: StructuredGenerationArgs) {
    if (!CONFIG.nvidiaNimApiKey) throw new Error("NVIDIA_NIM_API_KEY is not configured");
    const profile = nvidiaStructuredRequestProfile(args.model, args.thinkingLevel);
    return await generateOpenAiCompatible<T>({
      ...args,
      providerId: "nvidia",
      baseUrl: CONFIG.nvidiaNimBaseUrl,
      apiKey: CONFIG.nvidiaNimApiKey,
      timeoutMs: CONFIG.modelTimeoutMs,
      // NVIDIA documents OpenAI-compatible JSON mode for structured output.
      // The exact schema is still enforced locally after parsing.
      responseFormatMode: "json_object",
      maxTokens: profile.maxTokens,
      sendReasoning: false,
      extraBody: profile.extraBody,
    });
  },
};
