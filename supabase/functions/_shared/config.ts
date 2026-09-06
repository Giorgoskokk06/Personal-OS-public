import { NVIDIA_MODEL_SPECS } from "./providers/nvidia-models.ts";

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string): string | null {
  const value = Deno.env.get(name)?.trim();
  return value ? value : null;
}

function numberEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = Deno.env.get(name);
  if (raw == null || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function csvEnv(name: string, fallback: string[]): string[] {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  return [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
}

function providerWeightsEnv(name: string, fallback: Record<string, number>): Record<string, number> {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const parsed: Record<string, number> = {};
  for (const part of raw.split(",")) {
    const [provider, weightRaw] = part.split(":", 2).map((item) => item?.trim());
    const weight = Number(weightRaw);
    if (provider && Number.isFinite(weight) && weight > 0) parsed[provider] = weight;
  }
  return Object.keys(parsed).length ? parsed : fallback;
}

export type SensitivityClass = "personal_safe" | "personal_sensitive" | "work_safe" | "work_confidential" | "restricted";

export type ModelPoolEntry = {
  id: string;
  provider: string;
  model: string;
  roles: string[];
  preferredRoles: string[];
  quality: number;
  speed: number;
  costClass: "free" | "paid";
  dailyRequestLimit: number | null;
  resetTimeZone: string;
  inputCostPerMillion: number | null;
  outputCostPerMillion: number | null;
  allowedSensitivities: SensitivityClass[];
  enabled: boolean;
};

const FIRST_PARTY_ALLOWED: SensitivityClass[] = ["personal_safe", "personal_sensitive", "work_safe"];
const SAFE_ONLY: SensitivityClass[] = ["personal_safe", "work_safe"];

function quotaEnv(modelKey: string): number | null {
  const n = numberEnv(`GEMINI_${modelKey}_DAILY_LIMIT`, 0);
  return n > 0 ? n : null;
}

function googleEntry(args: {
  id: string;
  model: string;
  roles: string[];
  preferredRoles: string[];
  quality: number;
  speed: number;
  limitKey: string;
}): ModelPoolEntry {
  return {
    ...args,
    provider: "google",
    costClass: "free",
    dailyRequestLimit: quotaEnv(args.limitKey),
    resetTimeZone: "America/Los_Angeles",
    inputCostPerMillion: null,
    outputCostPerMillion: null,
    allowedSensitivities: FIRST_PARTY_ALLOWED,
    enabled: Boolean(optionalEnv("GEMINI_API_KEY")),
  };
}

function externalSensitivities(envName: string): SensitivityClass[] {
  return boolEnv(envName, false)
    ? ["personal_safe", "personal_sensitive", "work_safe"]
    : SAFE_ONLY;
}

function defaultModelPool(): ModelPoolEntry[] {
  // There is deliberately no hard-coded provider priority here. The router
  // scores every healthy/privacy-eligible candidate using task fit, quota
  // headroom, recent provider share, latency/quality profile and circuits.
  const rows: ModelPoolEntry[] = [
    googleEntry({
      id: "g35-lite",
      model: Deno.env.get("GEMINI_FAST_MODEL") ?? "gemini-3.5-flash-lite",
      roles: ["fast", "capture", "normal"],
      preferredRoles: ["fast", "capture"],
      quality: 72,
      speed: 98,
      limitKey: "35_LITE",
    }),
    googleEntry({
      id: "g36",
      model: Deno.env.get("GEMINI_CHAT_MODEL") ?? "gemini-3.6-flash",
      roles: ["normal", "fast", "capture", "deep"],
      preferredRoles: ["normal", "capture"],
      quality: 86,
      speed: 86,
      limitKey: "36",
    }),
    googleEntry({
      id: "g37",
      model: "gemini-3.7-flash",
      roles: ["normal", "deep", "fast", "capture"],
      preferredRoles: ["deep"],
      quality: 92,
      speed: 80,
      limitKey: "37",
    }),
    googleEntry({
      id: "g38",
      model: Deno.env.get("GEMINI_DEEP_MODEL") ?? "gemini-3.8-flash",
      roles: ["deep", "normal", "capture"],
      preferredRoles: ["deep"],
      quality: 98,
      speed: 75,
      limitKey: "38",
    }),
    googleEntry({
      id: "g35",
      model: "gemini-3.5-flash",
      roles: ["fast", "normal", "capture", "deep"],
      preferredRoles: ["fast"],
      quality: 76,
      speed: 90,
      limitKey: "35",
    }),
    googleEntry({
      id: "g31-lite",
      model: "gemini-3.1-flash-lite",
      roles: ["fast", "normal", "capture"],
      preferredRoles: ["fast", "capture"],
      quality: 65,
      speed: 96,
      limitKey: "31_LITE",
    }),
  ];

  if (optionalEnv("OPENROUTER_API_KEY") && boolEnv("OPENROUTER_ENABLED", true)) {
    const openRouterLimit = Math.max(0, numberEnv("OPENROUTER_DAILY_LIMIT", 50));
    rows.push({
      id: "openrouter-free",
      provider: "openrouter",
      model: Deno.env.get("OPENROUTER_FREE_MODEL") ?? "openrouter/free",
      roles: ["fast", "normal", "capture", "deep"],
      preferredRoles: ["fast", "normal", "capture"],
      quality: 82,
      speed: 76,
      costClass: "free",
      // openrouter/free is intentionally the only OpenRouter logical route.
      // This makes this model-level counter an account-level free-call guard.
      dailyRequestLimit: openRouterLimit > 0 ? openRouterLimit : null,
      resetTimeZone: "UTC",
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      allowedSensitivities: externalSensitivities("OPENROUTER_ALLOW_PERSONAL_SENSITIVE"),
      enabled: true,
    });
  }

  if (optionalEnv("NVIDIA_NIM_API_KEY") && boolEnv("NVIDIA_NIM_ENABLED", true)) {
    const validatedModels = new Set(csvEnv(
      "NVIDIA_NIM_ENABLED_MODELS",
      ["nvidia/nemotron-3.5-lightning-30b-a3b"],
    ));
    const sensitivities = externalSensitivities("NVIDIA_NIM_ALLOW_PERSONAL_SENSITIVE");
    const treatAsPaid = boolEnv("NVIDIA_NIM_TREAT_AS_PAID", false);
    const inputCost = numberEnv("NVIDIA_NIM_INPUT_COST_PER_MILLION", 0) || null;
    const outputCost = numberEnv("NVIDIA_NIM_OUTPUT_COST_PER_MILLION", 0) || null;

    for (const spec of NVIDIA_MODEL_SPECS) {
      if (!validatedModels.has(spec.model)) continue;
      rows.push({
        id: `nvidia-${spec.model.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`,
        provider: "nvidia",
        model: spec.model,
        roles: spec.roles,
        preferredRoles: spec.preferredRoles,
        quality: spec.quality,
        speed: spec.speed,
        costClass: treatAsPaid ? "paid" : "free",
        dailyRequestLimit: null,
        resetTimeZone: "UTC",
        inputCostPerMillion: inputCost,
        outputCostPerMillion: outputCost,
        allowedSensitivities: sensitivities,
        enabled: true,
      });
    }
  }

  return rows;
}

function modelPoolEnv(): ModelPoolEntry[] {
  const raw = Deno.env.get("AI_MODEL_POOL_JSON");
  if (!raw?.trim()) return defaultModelPool();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("AI_MODEL_POOL_JSON must be a JSON array");
    const rows = parsed.map((item: any, index: number): ModelPoolEntry => ({
      id: String(item?.id ?? `${item?.provider ?? "provider"}-${index + 1}`),
      provider: String(item?.provider ?? "google"),
      model: String(item?.model ?? "").trim(),
      roles: Array.isArray(item?.roles) ? item.roles.map(String) : ["normal"],
      preferredRoles: Array.isArray(item?.preferredRoles) ? item.preferredRoles.map(String) : [],
      quality: Math.max(0, Math.min(100, Number(item?.quality ?? 70))),
      speed: Math.max(0, Math.min(100, Number(item?.speed ?? 70))),
      costClass: item?.costClass === "paid" ? "paid" : "free",
      dailyRequestLimit: Number(item?.dailyRequestLimit) > 0 ? Number(item.dailyRequestLimit) : null,
      resetTimeZone: String(item?.resetTimeZone ?? "UTC"),
      inputCostPerMillion: Number(item?.inputCostPerMillion) >= 0 ? Number(item.inputCostPerMillion) : null,
      outputCostPerMillion: Number(item?.outputCostPerMillion) >= 0 ? Number(item.outputCostPerMillion) : null,
      allowedSensitivities: Array.isArray(item?.allowedSensitivities)
        ? item.allowedSensitivities.map(String) as SensitivityClass[]
        : FIRST_PARTY_ALLOWED,
      enabled: item?.enabled !== false,
    })).filter((item: ModelPoolEntry) => item.model);
    if (!rows.length) throw new Error("AI_MODEL_POOL_JSON contains no model definitions");
    return rows;
  } catch (error) {
    throw new Error(`Invalid AI_MODEL_POOL_JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function dedupePool(rows: ModelPoolEntry[]): ModelPoolEntry[] {
  const map = new Map<string, ModelPoolEntry>();
  for (const row of rows) {
    const key = `${row.provider}:${row.model}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, row);
      continue;
    }
    map.set(key, {
      ...existing,
      roles: [...new Set([...existing.roles, ...row.roles])],
      preferredRoles: [...new Set([...existing.preferredRoles, ...row.preferredRoles])],
      quality: Math.max(existing.quality, row.quality),
      speed: Math.max(existing.speed, row.speed),
    });
  }
  return [...map.values()];
}

const pool = dedupePool(modelPoolEnv());

export const CONFIG = {
  version: "1.3.2",
  supabaseUrl: requiredEnv("SUPABASE_URL"),
  serviceRoleKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  telegramBotToken: requiredEnv("TELEGRAM_BOT_TOKEN"),
  telegramWebhookSecret: requiredEnv("TELEGRAM_WEBHOOK_SECRET"),
  telegramAllowedUserId: requiredEnv("TELEGRAM_ALLOWED_USER_ID"),
  geminiApiKey: optionalEnv("GEMINI_API_KEY"),

  modelPool: pool,
  // These values are only placeholders for non-routing error telemetry. Actual
  // generation always goes through generateStructuredRouted().
  defaultProvider: "router",
  defaultModel: "unselected",
  modelTimeoutMs: numberEnv("MODEL_TIMEOUT_MS", 45_000),
  transientCircuitSeconds: numberEnv("MODEL_TRANSIENT_CIRCUIT_SECONDS", 120),
  providerAuthCircuitSeconds: numberEnv("PROVIDER_AUTH_CIRCUIT_SECONDS", 1800),
  modelRouteStateEnabled: boolEnv("MODEL_ROUTE_STATE_ENABLED", true),
  proactiveQuotaRouting: boolEnv("MODEL_PROACTIVE_QUOTA_ROUTING", true),
  quotaReserveRequests: Math.max(0, numberEnv("MODEL_QUOTA_RESERVE_REQUESTS", 1)),
  openRouterQuotaReserveRequests: Math.max(0, numberEnv("OPENROUTER_QUOTA_RESERVE_REQUESTS", 5)),
  maxRouteAttempts: Math.max(1, Math.min(8, numberEnv("MODEL_MAX_ROUTE_ATTEMPTS", 5))),
  providerAttemptCaps: {
    google: Math.max(1, Math.min(4, numberEnv("MODEL_GOOGLE_MAX_ATTEMPTS", 2))),
    nvidia: Math.max(1, Math.min(4, numberEnv("MODEL_NVIDIA_MAX_ATTEMPTS", 2))),
    openrouter: Math.max(1, Math.min(1, numberEnv("MODEL_OPENROUTER_MAX_ATTEMPTS", 1))),
  } as Record<string, number>,
  allowPaidFallback: boolEnv("ALLOW_PAID_FALLBACK", false),
  dailyAiBudgetUsd: Math.max(0, numberEnv("AI_DAILY_BUDGET_USD", 0)),
  monthlyAiBudgetUsd: Math.max(0, numberEnv("AI_MONTHLY_BUDGET_USD", 0)),

  providerBalanceEnabled: boolEnv("MODEL_PROVIDER_BALANCE_ENABLED", true),
  providerBalanceWindow: Math.max(3, Math.min(100, numberEnv("MODEL_PROVIDER_BALANCE_WINDOW", 15))),
  providerBalanceWeight: Math.max(0, Math.min(40, numberEnv("MODEL_PROVIDER_BALANCE_WEIGHT", 16))),
  providerRotationBonus: Math.max(0, Math.min(30, numberEnv("MODEL_PROVIDER_ROTATION_BONUS", 6))),
  providerTargetWeights: providerWeightsEnv("MODEL_PROVIDER_TARGET_WEIGHTS", {
    google: 0.40,
    nvidia: 0.40,
    openrouter: 0.20,
  }),

  openRouterApiKey: optionalEnv("OPENROUTER_API_KEY"),
  openRouterBaseUrl: Deno.env.get("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1",
  openRouterEnforceZdr: boolEnv("OPENROUTER_ENFORCE_ZDR", true),
  openRouterDenyDataCollection: boolEnv("OPENROUTER_DENY_DATA_COLLECTION", true),
  openRouterAllowPersonalSensitive: boolEnv("OPENROUTER_ALLOW_PERSONAL_SENSITIVE", false),

  nvidiaNimApiKey: optionalEnv("NVIDIA_NIM_API_KEY"),
  nvidiaNimBaseUrl: Deno.env.get("NVIDIA_NIM_BASE_URL") ?? "https://integrate.api.nvidia.com/v1",
  nvidiaNimAllowPersonalSensitive: boolEnv("NVIDIA_NIM_ALLOW_PERSONAL_SENSITIVE", false),

  embeddingModel: Deno.env.get("GEMINI_EMBEDDING_MODEL") ?? "gemini-embedding-2",
  transcriptionModel: Deno.env.get("GEMINI_TRANSCRIPTION_MODEL") ?? "gemini-3.5-transcribe",
  transcriptionVocabulary: csvEnv("GEMINI_TRANSCRIPTION_VOCABULARY", [
    "Supabase",
    "Telegram",
    "Gemini",
    "SQL",
    "API",
    "pgvector",
    "Notion",
  ]),
  ownerAliases: csvEnv("PERSONAL_OS_OWNER_ALIASES", ["owner", "user"]),
  careerAliases: csvEnv("PERSONAL_OS_CAREER_ALIASES", []),
  embeddingDimensions: 768,

  recentMessageLimit: Math.max(4, numberEnv("RECENT_MESSAGE_LIMIT", 8)),
  recordRetrievalLimit: Math.max(8, numberEnv("RECORD_RETRIEVAL_LIMIT", 18)),
  deepRecordRetrievalLimit: Math.max(18, numberEnv("DEEP_RECORD_RETRIEVAL_LIMIT", 36)),
  chunkRetrievalLimit: Math.max(2, numberEnv("CHUNK_RETRIEVAL_LIMIT", 7)),
  deepChunkRetrievalLimit: Math.max(8, numberEnv("DEEP_CHUNK_RETRIEVAL_LIMIT", 16)),
  profileRetrievalLimit: Math.max(16, numberEnv("PROFILE_RETRIEVAL_LIMIT", 32)),
  historicalEvidenceEnabled: boolEnv("HISTORICAL_EVIDENCE_RETRIEVAL_ENABLED", true),
  maxVoiceSeconds: numberEnv("MAX_VOICE_SECONDS", 600),
};
