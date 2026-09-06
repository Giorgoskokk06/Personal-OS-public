import type { ThinkingLevel } from "../gemini.ts";

export type NvidiaReasoningMode = "nemotron" | "deepseek" | "kimi";

export type NvidiaModelSpec = {
  model: string;
  roles: string[];
  preferredRoles: string[];
  quality: number;
  speed: number;
  maxOutputTokens: number;
  normalOutputTokens: number;
  deepOutputTokens: number;
  reasoningMode: NvidiaReasoningMode;
};

// Current hosted NVIDIA NIM candidates validated against NVIDIA Build catalog
// when Personal OS v1.3.0 was prepared (2026-09-06). Runtime enablement is
// still controlled by NVIDIA_NIM_ENABLED_MODELS after live contract preflight.
export const NVIDIA_MODEL_SPECS: NvidiaModelSpec[] = [
  {
    model: "nvidia/nemotron-3.5-lightning-30b-a3b",
    roles: ["fast", "capture", "normal", "deep"],
    preferredRoles: ["fast", "capture"],
    quality: 87,
    speed: 97,
    maxOutputTokens: 32768,
    normalOutputTokens: 4096,
    deepOutputTokens: 8192,
    reasoningMode: "nemotron",
  },
  {
    model: "deepseek-ai/deepseek-v4-flash-0731",
    roles: ["fast", "capture", "normal", "deep"],
    preferredRoles: ["normal"],
    quality: 92,
    speed: 84,
    maxOutputTokens: 16384,
    normalOutputTokens: 4096,
    deepOutputTokens: 8192,
    reasoningMode: "deepseek",
  },
  {
    model: "deepseek-ai/deepseek-v4-pro-0813",
    roles: ["normal", "deep"],
    preferredRoles: ["deep"],
    quality: 97,
    speed: 63,
    maxOutputTokens: 16384,
    normalOutputTokens: 4096,
    deepOutputTokens: 8192,
    reasoningMode: "deepseek",
  },
  {
    model: "nvidia/nemotron-3-super-120b-a12b",
    roles: ["normal", "deep"],
    preferredRoles: ["deep"],
    quality: 95,
    speed: 66,
    maxOutputTokens: 32768,
    normalOutputTokens: 4096,
    deepOutputTokens: 8192,
    reasoningMode: "nemotron",
  },
  {
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    roles: ["deep"],
    preferredRoles: ["deep"],
    quality: 99,
    speed: 46,
    maxOutputTokens: 32768,
    normalOutputTokens: 4096,
    deepOutputTokens: 12288,
    reasoningMode: "nemotron",
  },
  {
    model: "moonshotai/kimi-k3",
    roles: ["normal", "deep"],
    preferredRoles: ["deep"],
    quality: 98,
    speed: 52,
    maxOutputTokens: 65536,
    normalOutputTokens: 6144,
    deepOutputTokens: 12288,
    reasoningMode: "kimi",
  },
];

const SPEC_BY_MODEL = new Map(NVIDIA_MODEL_SPECS.map((spec) => [spec.model, spec]));

export function getNvidiaModelSpec(model: string): NvidiaModelSpec | null {
  return SPEC_BY_MODEL.get(model) ?? null;
}

export function nvidiaStructuredRequestProfile(model: string, thinking: ThinkingLevel): {
  maxTokens: number;
  extraBody: Record<string, unknown>;
} {
  const spec = getNvidiaModelSpec(model);
  const maxTokens = Math.min(spec?.maxOutputTokens ?? 8192, spec?.normalOutputTokens ?? 4096);

  // Every NVIDIA route used by Personal OS is a structured response containing
  // both the user-facing reply and durable-memory operations. The current hosted
  // NIM contract is most reliable when reasoning traces are disabled for JSON
  // mode; deep routing still benefits from deeper retrieval and stronger models.
  if (spec?.reasoningMode === "deepseek") {
    return {
      maxTokens,
      extraBody: {
        temperature: 0,
        chat_template_kwargs: { thinking: false },
      },
    };
  }

  if (spec?.reasoningMode === "nemotron") {
    return {
      maxTokens,
      extraBody: {
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      },
    };
  }

  // Kimi's hosted controls can evolve. Keep the request OpenAI-compatible and
  // let live calibration decide whether this model is eligible.
  return {
    maxTokens,
    extraBody: { temperature: 0 },
  };
}
