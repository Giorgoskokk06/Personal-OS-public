import { CONFIG, type ModelPoolEntry, type SensitivityClass } from "./config.ts";
import type { ModelUsage, ThinkingLevel } from "./gemini.ts";
import { getStructuredProvider, hasStructuredProvider } from "./providers/registry.ts";
import { ProviderApiError } from "./providers/types.ts";

export type RouteMode = "normal" | "fast" | "deep" | "capture" | "nostore";

export type ModelRouteAttempt = {
  provider: string;
  model: string;
  servedModel: string | null;
  requestedThinkingLevel: ThinkingLevel;
  effectiveThinkingLevel: ThinkingLevel;
  status: "completed" | "failed";
  latencyMs: number;
  usage: ModelUsage | null;
  rawChars: number | null;
  error: string | null;
  errorCode: string | null;
  errorKind: string | null;
  quotaId: string | null;
  quotaMetric: string | null;
  estimatedCostUsd: number | null;
};

export type RouteCandidateDiagnostic = {
  provider: string;
  model: string;
  score: number;
  baseScore: number;
  balanceAdjustment: number;
  recentProviderCompletions: number;
  lastSuccessfulProvider: string | null;
  usedToday: number | null;
  dailyLimit: number | null;
  remainingToday: number | null;
  blockedUntil: string | null;
  providerBlockedUntil: string | null;
  privacyAllowed: boolean;
  skippedReason: string | null;
};

export type RoutedGeneration<T> = {
  value: T;
  model: string;
  servedModel: string | null;
  provider: string;
  requestedThinkingLevel: ThinkingLevel;
  effectiveThinkingLevel: ThinkingLevel;
  latencyMs: number;
  rawChars: number;
  usage: ModelUsage;
  attempts: ModelRouteAttempt[];
  skippedModels: string[];
  fallbackUsed: boolean;
  routeReason: string;
  candidates: RouteCandidateDiagnostic[];
};

export class RoutedGenerationError extends Error {
  attempts: ModelRouteAttempt[];
  skippedModels: string[];
  errorKind: string;
  candidates: RouteCandidateDiagnostic[];

  constructor(message: string, args: {
    attempts: ModelRouteAttempt[];
    skippedModels: string[];
    errorKind: string;
    candidates: RouteCandidateDiagnostic[];
  }) {
    super(message);
    this.name = "RoutedGenerationError";
    this.attempts = args.attempts;
    this.skippedModels = args.skippedModels;
    this.errorKind = args.errorKind;
    this.candidates = args.candidates;
  }
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string) {
  const p = zonedParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

function zonedWallTimeToUtc(args: {
  year: number; month: number; day: number; hour: number; minute: number; second: number; timeZone: string;
}) {
  const wall = Date.UTC(args.year, args.month - 1, args.day, args.hour, args.minute, args.second);
  let guess = new Date(wall);
  let offset = timeZoneOffsetMs(guess, args.timeZone);
  let out = new Date(wall - offset);
  const corrected = timeZoneOffsetMs(out, args.timeZone);
  if (corrected !== offset) out = new Date(wall - corrected);
  return out;
}

function dayWindow(timeZone: string, now = new Date()) {
  const p = zonedParts(now, timeZone);
  const start = zonedWallTimeToUtc({ ...p, hour: 0, minute: 0, second: 0, timeZone });
  const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const next = zonedWallTimeToUtc({
    year: tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth() + 1,
    day: tomorrow.getUTCDate(),
    hour: 0,
    minute: 5,
    second: 0,
    timeZone,
  });
  return { start, next };
}

function classifyFailure(error: unknown, resetTimeZone: string) {
  const now = Date.now();
  const base = {
    code: null as string | null,
    retryAfterMs: null as number | null,
    quotaId: null as string | null,
    quotaMetric: null as string | null,
    fallbackEligible: true,
    blockUntil: null as string | null,
    providerBlockUntil: null as string | null,
  };

  if (error instanceof ProviderApiError) {
    const common = {
      code: error.apiStatus ?? String(error.status),
      retryAfterMs: error.retryAfterMs,
      quotaId: error.quotaId,
      quotaMetric: error.quotaMetric,
    };
    const daily = error.status === 429 && /perday|requestsperday|requests.*day/i.test(
      `${error.quotaId ?? ""} ${error.quotaMetric ?? ""} ${error.rawDetail ?? ""}`,
    );
    if (daily) {
      return { ...base, ...common, kind: "quota_daily", blockUntil: dayWindow(resetTimeZone).next.toISOString() };
    }
    if (error.status === 429) {
      const retry = Math.max(error.retryAfterMs ?? 0, 60_000);
      return { ...base, ...common, kind: "quota_rate", retryAfterMs: retry, blockUntil: new Date(now + retry).toISOString() };
    }
    if ([401, 403].includes(error.status)) {
      return { ...base, ...common, kind: "provider_auth", providerBlockUntil: new Date(now + CONFIG.providerAuthCircuitSeconds * 1000).toISOString() };
    }
    if (error.status === 402) {
      return { ...base, ...common, kind: "provider_billing", providerBlockUntil: new Date(now + CONFIG.providerAuthCircuitSeconds * 1000).toISOString() };
    }
    if (error.status === 404) {
      const dynamicOpenRouter = error.provider === "openrouter" && /^openrouter\/(free|auto)$/i.test(error.model);
      return {
        ...base,
        ...common,
        kind: dynamicOpenRouter ? "provider_no_eligible_endpoint" : "model_unavailable",
        blockUntil: new Date(now + CONFIG.transientCircuitSeconds * 1000).toISOString(),
      };
    }
    if (error.status === 400 || error.status === 422) {
      const detail = `${error.message ?? ""} ${error.rawDetail ?? ""}`;
      const capabilityMismatch = /(unknown model|model[^\n]{0,80}(not found|not available|unavailable)|not supported|unsupported|does not support|response[_ -]?format|json[_ -]?schema|thinking[^\n]{0,40}level|reasoning[_ -]?effort|chat[_ -]?template)/i.test(detail);
      if (capabilityMismatch) {
        return { ...base, ...common, kind: "model_capability_unavailable", blockUntil: new Date(now + CONFIG.transientCircuitSeconds * 1000).toISOString() };
      }
      return { ...base, ...common, kind: "request_invalid", fallbackEligible: false };
    }
    if (error.status >= 500) {
      // A 5xx is model/endpoint-level for this request. Do not suppress healthy
      // sibling models from the same provider; provider-wide blocks are only
      // used for true auth/billing failures above.
      return { ...base, ...common, kind: "provider_transient", blockUntil: new Date(now + CONFIG.transientCircuitSeconds * 1000).toISOString() };
    }
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return { ...base, kind: "timeout", code: "TIMEOUT", blockUntil: new Date(now + CONFIG.transientCircuitSeconds * 1000).toISOString() };
  }
  return { ...base, kind: "generation_error", blockUntil: new Date(now + CONFIG.transientCircuitSeconds * 1000).toISOString() };
}

async function loadModelBlocks(supabase: any, entries: ModelPoolEntry[]) {
  const blocked = new Map<string, string>();
  if (!CONFIG.modelRouteStateEnabled || !entries.length) return blocked;
  try {
    const providers = [...new Set(entries.map((entry) => entry.provider))];
    const { data, error } = await supabase.from("model_route_state").select("provider,model,blocked_until").in("provider", providers);
    if (error) throw error;
    const valid = new Set(entries.map((entry) => `${entry.provider}:${entry.model}`));
    const now = Date.now();
    for (const row of data ?? []) {
      const key = `${row.provider}:${row.model}`;
      const until = row?.blocked_until ? Date.parse(row.blocked_until) : NaN;
      if (valid.has(key) && Number.isFinite(until) && until > now) blocked.set(key, new Date(until).toISOString());
    }
  } catch (error) {
    console.error("model_route_state read failed", error);
  }
  return blocked;
}

async function loadProviderBlocks(supabase: any, providers: string[]) {
  const blocked = new Map<string, string>();
  if (!CONFIG.modelRouteStateEnabled || !providers.length) return blocked;
  try {
    const { data, error } = await supabase.from("provider_route_state").select("provider,blocked_until").in("provider", providers);
    if (error) throw error;
    const now = Date.now();
    for (const row of data ?? []) {
      const until = row?.blocked_until ? Date.parse(row.blocked_until) : NaN;
      if (Number.isFinite(until) && until > now) blocked.set(row.provider, new Date(until).toISOString());
    }
  } catch (error) {
    console.error("provider_route_state read failed", error);
  }
  return blocked;
}

async function usageToday(supabase: any, entry: ModelPoolEntry): Promise<number | null> {
  if (!CONFIG.proactiveQuotaRouting || !entry.dailyRequestLimit) return null;
  try {
    const { start } = dayWindow(entry.resetTimeZone);
    const { count, error } = await supabase
      .from("model_runs")
      .select("id", { count: "exact", head: true })
      .eq("provider", entry.provider)
      .eq("model", entry.model)
      .eq("task", "coach_structured")
      .gte("created_at", start.toISOString());
    if (error) throw error;
    return Number(count ?? 0);
  } catch (error) {
    console.error("model usage count failed", error);
    return null;
  }
}

async function spentUsd(supabase: any, sinceIso: string) {
  try {
    const { data, error } = await supabase.from("model_runs").select("metadata").gte("created_at", sinceIso);
    if (error) throw error;
    return (data ?? []).reduce((sum: number, row: any) => {
      const cost = Number(row?.metadata?.estimated_cost_usd);
      return sum + (Number.isFinite(cost) ? cost : 0);
    }, 0);
  } catch (error) {
    console.error("budget lookup failed", error);
    return 0;
  }
}

async function budgetAllowsPaid(supabase: any, projected: number) {
  if (!CONFIG.allowPaidFallback || CONFIG.dailyAiBudgetUsd <= 0 || CONFIG.monthlyAiBudgetUsd <= 0) return false;
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [daily, monthly] = await Promise.all([spentUsd(supabase, day), spentUsd(supabase, month)]);
  return daily + projected <= CONFIG.dailyAiBudgetUsd && monthly + projected <= CONFIG.monthlyAiBudgetUsd;
}

function estimateCost(entry: ModelPoolEntry, promptChars: number, outputTokens = 1200) {
  if (entry.costClass === "free") return 0;
  if (entry.inputCostPerMillion == null || entry.outputCostPerMillion == null) return Number.POSITIVE_INFINITY;
  const inputTokens = Math.ceil(promptChars / 4);
  return inputTokens / 1e6 * entry.inputCostPerMillion + outputTokens / 1e6 * entry.outputCostPerMillion;
}

function roleFor(mode: RouteMode, thinking: ThinkingLevel) {
  if (mode === "deep" || thinking === "HIGH") return "deep";
  if (mode === "fast" || thinking === "LOW" || thinking === "MINIMAL") return "fast";
  if (mode === "capture") return "capture";
  return "normal";
}

function routeReason(role: string) {
  const prefix = role === "deep" ? "deep" : role === "fast" ? "fast" : role === "capture" ? "capture" : "normal";
  return `${prefix}_adaptive_privacy_quota_health_provider_balance`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function candidateScore(entry: ModelPoolEntry, role: string, remainingRatio: number | null) {
  const fit = entry.preferredRoles.includes(role) ? 100 : entry.roles.includes(role) ? 68 : entry.roles.includes("normal") ? 45 : 15;
  const headroom = remainingRatio == null ? 70 : clamp(remainingRatio, 0, 1) * 100;
  if (role === "deep") return entry.quality * .55 + headroom * .18 + entry.speed * .09 + fit * .18;
  if (role === "fast") return entry.speed * .42 + headroom * .27 + entry.quality * .13 + fit * .18;
  if (role === "capture") return entry.speed * .29 + headroom * .28 + entry.quality * .20 + fit * .23;
  return entry.quality * .30 + entry.speed * .21 + headroom * .27 + fit * .22;
}

type ProviderBalanceState = { counts: Map<string, number>; total: number; lastProvider: string | null };

async function recentProviderBalance(supabase: any, providers: string[]): Promise<ProviderBalanceState> {
  const empty = { counts: new Map<string, number>(), total: 0, lastProvider: null as string | null };
  if (!CONFIG.providerBalanceEnabled || providers.length < 2) return empty;
  try {
    const { data, error } = await supabase
      .from("model_runs")
      .select("provider,created_at")
      .eq("task", "coach_structured")
      .eq("status", "completed")
      .in("provider", providers)
      .order("created_at", { ascending: false })
      .limit(CONFIG.providerBalanceWindow);
    if (error) throw error;
    const rows = (data ?? []).filter((row: any) => providers.includes(String(row?.provider ?? "")));
    const counts = new Map<string, number>();
    for (const provider of providers) counts.set(provider, 0);
    for (const row of rows) counts.set(String(row.provider), (counts.get(String(row.provider)) ?? 0) + 1);
    return { counts, total: rows.length, lastProvider: rows[0]?.provider ? String(rows[0].provider) : null };
  } catch (error) {
    console.error("provider balance lookup failed", error);
    return empty;
  }
}

function providerBalanceAdjustment(provider: string, state: ProviderBalanceState, providers: string[]) {
  if (!CONFIG.providerBalanceEnabled || providers.length < 2) return 0;
  const count = state.counts.get(provider) ?? 0;
  let adjustment = 0;
  if (state.total > 0) {
    const configured = providers.map((name) => Math.max(0, Number(CONFIG.providerTargetWeights[name] ?? 1)));
    const weightTotal = configured.reduce((sum, value) => sum + value, 0) || providers.length;
    const providerIndex = providers.indexOf(provider);
    const targetShare = (configured[providerIndex] ?? 1) / weightTotal;
    const actualShare = count / state.total;
    const normalizedGap = (targetShare - actualShare) / Math.max(targetShare, 0.10);
    adjustment += clamp(
      normalizedGap * CONFIG.providerBalanceWeight,
      -CONFIG.providerBalanceWeight,
      CONFIG.providerBalanceWeight,
    );
  }
  if (state.lastProvider) {
    adjustment += provider === state.lastProvider ? -CONFIG.providerRotationBonus : CONFIG.providerRotationBonus;
  }
  return adjustment;
}

function interleaveProviderOrder(rows: Array<{ entry: ModelPoolEntry; skippedReason: string | null; score: number }>) {
  const eligible = rows.filter((row) => !row.skippedReason);
  if (new Set(eligible.map((row) => row.entry.provider)).size <= 1) return eligible.map((row) => row.entry);
  const buckets = new Map<string, typeof eligible>();
  for (const row of eligible) {
    const bucket = buckets.get(row.entry.provider) ?? [];
    bucket.push(row);
    buckets.set(row.entry.provider, bucket);
  }
  const providerOrder = [...buckets.entries()]
    .sort((a, b) => (b[1][0]?.score ?? 0) - (a[1][0]?.score ?? 0))
    .map(([provider]) => provider);
  const out: ModelPoolEntry[] = [];
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const provider of providerOrder) {
      const next = buckets.get(provider)?.shift();
      if (next) {
        out.push(next.entry);
        remaining = true;
      }
    }
  }
  return out;
}

function quotaReserve(entry: ModelPoolEntry, role: string) {
  if (role === "deep") return 0;
  if (entry.provider === "openrouter") return CONFIG.openRouterQuotaReserveRequests;
  return CONFIG.quotaReserveRequests;
}

async function rankCandidates(args: {
  supabase: any;
  mode: RouteMode;
  thinkingLevel: ThinkingLevel;
  promptChars: number;
  sensitivity: SensitivityClass;
}) {
  const role = roleFor(args.mode, args.thinkingLevel);
  const configured = CONFIG.modelPool.filter((entry) => entry.enabled && hasStructuredProvider(entry.provider));
  const providers = [...new Set(configured.map((entry) => entry.provider))];
  const [modelBlocks, providerBlocks, balanceState] = await Promise.all([
    loadModelBlocks(args.supabase, configured),
    loadProviderBlocks(args.supabase, providers),
    recentProviderBalance(args.supabase, providers),
  ]);

  const rows = await Promise.all(configured.map(async (entry) => {
    const key = `${entry.provider}:${entry.model}`;
    const blockedUntil = modelBlocks.get(key) ?? null;
    const providerBlockedUntil = providerBlocks.get(entry.provider) ?? null;
    const used = await usageToday(args.supabase, entry);
    const limit = entry.dailyRequestLimit;
    const remaining = limit != null && used != null ? Math.max(0, limit - used) : null;
    const remainingRatio = limit != null && remaining != null ? remaining / Math.max(limit, 1) : null;
    const privacyAllowed = entry.allowedSensitivities.includes(args.sensitivity);
    let skippedReason: string | null = null;

    if (providerBlockedUntil) skippedReason = "provider_circuit_open";
    else if (blockedUntil) skippedReason = "model_circuit_open";
    else if (!privacyAllowed) skippedReason = "privacy_policy";
    else if (!entry.roles.includes(role) && !entry.roles.includes("normal")) skippedReason = "role_not_supported";

    if (!skippedReason && entry.costClass === "paid") {
      const projected = estimateCost(entry, args.promptChars);
      if (!Number.isFinite(projected) || !(await budgetAllowsPaid(args.supabase, projected))) {
        skippedReason = "paid_fallback_disabled_or_budget_blocked";
      }
    }

    if (!skippedReason && CONFIG.proactiveQuotaRouting && limit != null && used != null) {
      const reserve = quotaReserve(entry, role);
      if (used >= Math.max(0, limit - reserve)) skippedReason = "proactive_daily_quota_guard";
    }

    const baseScore = candidateScore(entry, role, remainingRatio);
    const balanceAdjustment = providerBalanceAdjustment(entry.provider, balanceState, providers);
    const score = baseScore + balanceAdjustment;
    return {
      entry,
      score,
      baseScore,
      balanceAdjustment,
      used,
      limit,
      remaining,
      blockedUntil,
      providerBlockedUntil,
      privacyAllowed,
      skippedReason,
      recentProviderCompletions: balanceState.counts.get(entry.provider) ?? 0,
      lastSuccessfulProvider: balanceState.lastProvider,
    };
  }));

  const sorted = rows.sort((a, b) => b.score - a.score);
  const diagnostics: RouteCandidateDiagnostic[] = sorted.map((row) => ({
    provider: row.entry.provider,
    model: row.entry.model,
    score: Number(row.score.toFixed(2)),
    baseScore: Number(row.baseScore.toFixed(2)),
    balanceAdjustment: Number(row.balanceAdjustment.toFixed(2)),
    recentProviderCompletions: row.recentProviderCompletions,
    lastSuccessfulProvider: row.lastSuccessfulProvider,
    usedToday: row.used,
    dailyLimit: row.limit,
    remainingToday: row.remaining,
    blockedUntil: row.blockedUntil,
    providerBlockedUntil: row.providerBlockedUntil,
    privacyAllowed: row.privacyAllowed,
    skippedReason: row.skippedReason,
  }));

  return { entries: interleaveProviderOrder(sorted), diagnostics };
}

async function markModelSuccess(supabase: any, provider: string, model: string) {
  if (!CONFIG.modelRouteStateEnabled) return;
  try {
    await supabase.from("model_route_state").upsert({
      provider,
      model,
      circuit_state: "closed",
      blocked_until: null,
      consecutive_failures: 0,
      last_success_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "provider,model" });
  } catch (error) {
    console.error("model success state failed", error);
  }
}

async function markProviderSuccess(supabase: any, provider: string) {
  if (!CONFIG.modelRouteStateEnabled) return;
  try {
    await supabase.from("provider_route_state").upsert({
      provider,
      circuit_state: "closed",
      blocked_until: null,
      consecutive_failures: 0,
      last_success_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "provider" });
  } catch (error) {
    console.error("provider success state failed", error);
  }
}

async function markModelFailure(supabase: any, entry: ModelPoolEntry, error: unknown, classified: any) {
  if (!CONFIG.modelRouteStateEnabled) return;
  try {
    const { data: existing } = await supabase.from("model_route_state")
      .select("consecutive_failures").eq("provider", entry.provider).eq("model", entry.model).maybeSingle();
    await supabase.from("model_route_state").upsert({
      provider: entry.provider,
      model: entry.model,
      circuit_state: classified.blockUntil ? "open" : "closed",
      blocked_until: classified.blockUntil,
      last_error_code: classified.code,
      last_error_kind: classified.kind,
      last_error_at: new Date().toISOString(),
      consecutive_failures: Number(existing?.consecutive_failures ?? 0) + 1,
      metadata: {
        quota_id: classified.quotaId,
        quota_metric: classified.quotaMetric,
        retry_after_ms: classified.retryAfterMs,
        message: error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800),
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: "provider,model" });
  } catch (stateError) {
    console.error("model failure state failed", stateError);
  }
}

async function markProviderFailure(supabase: any, provider: string, error: unknown, classified: any) {
  if (!CONFIG.modelRouteStateEnabled || !classified.providerBlockUntil) return;
  try {
    const { data: existing } = await supabase.from("provider_route_state").select("consecutive_failures").eq("provider", provider).maybeSingle();
    await supabase.from("provider_route_state").upsert({
      provider,
      circuit_state: "open",
      blocked_until: classified.providerBlockUntil,
      last_error_code: classified.code,
      last_error_kind: classified.kind,
      last_error_at: new Date().toISOString(),
      consecutive_failures: Number(existing?.consecutive_failures ?? 0) + 1,
      metadata: { message: error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800) },
      updated_at: new Date().toISOString(),
    }, { onConflict: "provider" });
  } catch (stateError) {
    console.error("provider failure state failed", stateError);
  }
}

export async function generateStructuredRouted<T>(args: {
  supabase: any;
  systemPrompt: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  thinkingLevel: ThinkingLevel;
  mode: RouteMode;
  sensitivity: SensitivityClass;
}): Promise<RoutedGeneration<T>> {
  const role = roleFor(args.mode, args.thinkingLevel);
  const reason = routeReason(role);
  const { entries, diagnostics } = await rankCandidates({
    supabase: args.supabase,
    mode: args.mode,
    thinkingLevel: args.thinkingLevel,
    promptChars: args.userPrompt.length,
    sensitivity: args.sensitivity,
  });

  const attempts: ModelRouteAttempt[] = [];
  const skippedModels = diagnostics.filter((row) => row.skippedReason).map((row) => `${row.provider}:${row.model}`);
  const localProviderBlocks = new Set<string>();
  const providerAttemptCounts = new Map<string, number>();

  if (!entries.length) {
    throw new RoutedGenerationError("All configured AI routes are unavailable, quota/budget/privacy blocked", {
      attempts,
      skippedModels,
      errorKind: "all_routes_blocked",
      candidates: diagnostics,
    });
  }

  for (const entry of entries) {
    if (attempts.length >= CONFIG.maxRouteAttempts) break;
    if (localProviderBlocks.has(entry.provider)) {
      skippedModels.push(`${entry.provider}:${entry.model}`);
      continue;
    }

    const attemptCap = CONFIG.providerAttemptCaps[entry.provider] ?? 2;
    const usedAttempts = providerAttemptCounts.get(entry.provider) ?? 0;
    if (usedAttempts >= attemptCap) {
      skippedModels.push(`${entry.provider}:${entry.model}:provider_attempt_cap`);
      continue;
    }
    providerAttemptCounts.set(entry.provider, usedAttempts + 1);

    const provider = getStructuredProvider(entry.provider);
    const effective = provider.normalizeThinkingLevel(entry.model, args.thinkingLevel);
    const started = Date.now();

    try {
      const generated = await provider.generateStructured<T>({
        systemPrompt: args.systemPrompt,
        userPrompt: args.userPrompt,
        schema: args.schema,
        thinkingLevel: effective,
        model: entry.model,
      });
      const cost = estimateCost(entry, args.userPrompt.length, generated.usage.outputTokens ?? 1200);
      attempts.push({
        provider: entry.provider,
        model: entry.model,
        servedModel: generated.servedModel ?? null,
        requestedThinkingLevel: args.thinkingLevel,
        effectiveThinkingLevel: effective,
        status: "completed",
        latencyMs: generated.latencyMs,
        usage: generated.usage,
        rawChars: generated.rawChars,
        error: null,
        errorCode: null,
        errorKind: null,
        quotaId: null,
        quotaMetric: null,
        estimatedCostUsd: Number.isFinite(cost) ? cost : null,
      });
      await Promise.all([
        markModelSuccess(args.supabase, entry.provider, entry.model),
        markProviderSuccess(args.supabase, entry.provider),
      ]);
      return {
        ...generated,
        model: entry.model,
        servedModel: generated.servedModel ?? null,
        provider: entry.provider,
        requestedThinkingLevel: args.thinkingLevel,
        effectiveThinkingLevel: effective,
        attempts,
        skippedModels,
        fallbackUsed: attempts.length > 1,
        routeReason: reason,
        candidates: diagnostics,
      };
    } catch (error) {
      const classified = classifyFailure(error, entry.resetTimeZone);
      attempts.push({
        provider: entry.provider,
        model: entry.model,
        servedModel: null,
        requestedThinkingLevel: args.thinkingLevel,
        effectiveThinkingLevel: effective,
        status: "failed",
        latencyMs: Date.now() - started,
        usage: null,
        rawChars: null,
        error: error instanceof Error ? error.message : String(error),
        errorCode: classified.code,
        errorKind: classified.kind,
        quotaId: classified.quotaId,
        quotaMetric: classified.quotaMetric,
        estimatedCostUsd: null,
      });
      await Promise.all([
        markModelFailure(args.supabase, entry, error, classified),
        markProviderFailure(args.supabase, entry.provider, error, classified),
      ]);
      if (classified.providerBlockUntil) localProviderBlocks.add(entry.provider);
      if (!classified.fallbackEligible) break;
    }
  }

  const kinds = attempts.map((attempt) => attempt.errorKind).filter(Boolean).map(String);
  const quotaOnly = kinds.length > 0 && kinds.every((kind) => kind.startsWith("quota_"));
  throw new RoutedGenerationError(
    quotaOnly ? "All attempted AI models are quota-blocked" : "All eligible AI routes failed",
    {
      attempts,
      skippedModels,
      errorKind: quotaOnly ? "all_models_quota_blocked" : "all_routes_failed",
      candidates: diagnostics,
    },
  );
}
