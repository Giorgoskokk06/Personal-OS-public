#!/usr/bin/env node
import { loadEnv, requiredEnv, SupabaseRest } from "./lib.mjs";
import { NVIDIA_MODELS } from "./provider-catalog.mjs";

loadEnv();
const rest = new SupabaseRest(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
const enabled = (name, fallback = true) => !["0", "false", "no", "off"].includes(String(process.env[name] ?? fallback).toLowerCase());
const nvidiaEnabled = new Set(String(process.env.NVIDIA_NIM_ENABLED_MODELS || "nvidia/nemotron-3.5-lightning-30b-a3b").split(",").map((x) => x.trim()).filter(Boolean));
const privacyExternal = (name) => process.env[name] === "true" ? "personal_sensitive" : "safe-only";
const targetWeights = Object.fromEntries(String(process.env.MODEL_PROVIDER_TARGET_WEIGHTS || "google:0.40,nvidia:0.40,openrouter:0.20")
  .split(",").map((part) => part.trim().split(":", 2)).filter(([name, weight]) => name && Number(weight) > 0)
  .map(([name, weight]) => [name, Number(weight)]));

const pool = [
  { provider: "google", model: process.env.GEMINI_FAST_MODEL || "gemini-3.5-flash-lite", roles: "fast,capture,normal", privacy: "personal_sensitive", limit: process.env.GEMINI_35_LITE_DAILY_LIMIT || "reactive-only" },
  { provider: "google", model: process.env.GEMINI_CHAT_MODEL || "gemini-3.6-flash", roles: "normal,fast,capture,deep", privacy: "personal_sensitive", limit: process.env.GEMINI_36_DAILY_LIMIT || "reactive-only" },
  { provider: "google", model: "gemini-3.7-flash", roles: "normal,deep,fast,capture", privacy: "personal_sensitive", limit: process.env.GEMINI_37_DAILY_LIMIT || "reactive-only" },
  { provider: "google", model: process.env.GEMINI_DEEP_MODEL || "gemini-3.8-flash", roles: "deep,normal,capture", privacy: "personal_sensitive", limit: process.env.GEMINI_38_DAILY_LIMIT || "reactive-only" },
  { provider: "google", model: "gemini-3.5-flash", roles: "fast,normal,capture,deep", privacy: "personal_sensitive", limit: process.env.GEMINI_35_DAILY_LIMIT || "reactive-only" },
  { provider: "google", model: "gemini-3.1-flash-lite", roles: "fast,normal,capture", privacy: "personal_sensitive", limit: process.env.GEMINI_31_LITE_DAILY_LIMIT || "reactive-only" },
];
if (process.env.OPENROUTER_API_KEY && enabled("OPENROUTER_ENABLED")) pool.push({
  provider: "openrouter", model: process.env.OPENROUTER_FREE_MODEL || "openrouter/free", roles: "fast,normal,capture,deep",
  privacy: privacyExternal("OPENROUTER_ALLOW_PERSONAL_SENSITIVE"), limit: process.env.OPENROUTER_DAILY_LIMIT || "50",
});
if (process.env.NVIDIA_NIM_API_KEY && enabled("NVIDIA_NIM_ENABLED")) {
  for (const spec of NVIDIA_MODELS.filter((x) => nvidiaEnabled.has(x.model))) pool.push({
    provider: "nvidia", model: spec.model, roles: spec.roles, privacy: privacyExternal("NVIDIA_NIM_ALLOW_PERSONAL_SENSITIVE"), limit: "reactive-only",
  });
}

const [modelStates, providerStates, recentRuns] = await Promise.all([
  rest.select("model_route_state", { select: "provider,model,circuit_state,blocked_until,last_error_kind,last_error_at,last_success_at,consecutive_failures", limit: 500 }).catch(() => []),
  rest.select("provider_route_state", { select: "provider,circuit_state,blocked_until,last_error_kind,last_error_at,last_success_at,consecutive_failures", limit: 100 }).catch(() => []),
  rest.select("model_runs", { task: "eq.coach_structured", select: "provider,model,status,created_at,metadata", order: "created_at.desc", limit: 500 }).catch(() => []),
]);

console.log("Personal OS v1.3 adaptive routing pool (secrets are never printed):");
console.table(pool.map((entry) => {
  const state = modelStates.find((s) => s.provider === entry.provider && s.model === entry.model) || {};
  return { ...entry, circuit: state.circuit_state || "closed/not-recorded", blocked_until: state.blocked_until || "", last_error: state.last_error_kind || "" };
}));

console.log("Provider circuits:");
console.table(providerStates.length ? providerStates : [{ provider: "(none recorded)", circuit_state: "closed" }]);

const stats = new Map();
for (const run of recentRuns) {
  const key = `${run.provider}:${run.model}`;
  const row = stats.get(key) || { provider: run.provider, model: run.model, completed: 0, failed: 0, fallback_successes: 0, served_models: new Set() };
  run.status === "completed" ? row.completed++ : row.failed++;
  if (run.status === "completed" && Number(run.metadata?.attempt_number || 1) > 1) row.fallback_successes++;
  if (run.metadata?.served_model) row.served_models.add(run.metadata.served_model);
  stats.set(key, row);
}
console.log("Recent route telemetry (up to 500 attempts):");
console.table([...stats.values()].map((row) => ({ ...row, served_models: [...row.served_models].slice(0, 6).join(", ") })));

const windowSize = Math.max(3, Number(process.env.MODEL_PROVIDER_BALANCE_WINDOW || 15));
const recentCompleted = recentRuns.filter((run) => run.status === "completed").slice(0, windowSize);
const counts = new Map();
for (const run of recentCompleted) counts.set(run.provider, (counts.get(run.provider) || 0) + 1);
const activeProviders = [...new Set(pool.map((x) => x.provider))];
console.log(`Adaptive provider-share window (last ${windowSize} completed calls):`);
const activeWeightTotal = activeProviders.reduce((sum, provider) => sum + Number(targetWeights[provider] || 1), 0) || activeProviders.length;
console.table(activeProviders.map((provider) => ({
  provider,
  completed: counts.get(provider) || 0,
  share_pct: recentCompleted.length ? Number((((counts.get(provider) || 0) / recentCompleted.length) * 100).toFixed(1)) : 0,
  target_pct: Number((((targetWeights[provider] || 1) / activeWeightTotal) * 100).toFixed(1)),
  attempt_cap_per_request: process.env[`MODEL_${provider === "openrouter" ? "OPENROUTER" : provider.toUpperCase()}_MAX_ATTEMPTS`] || (provider === "openrouter" ? "1" : "2"),
})));

const warnings = [];
if (activeProviders.length !== 3) warnings.push(`Expected 3 active providers; found ${activeProviders.length}: ${activeProviders.join(", ") || "none"}.`);
if (!process.env.GEMINI_API_KEY) warnings.push("Gemini is inactive.");
if (!process.env.OPENROUTER_API_KEY || !enabled("OPENROUTER_ENABLED")) warnings.push("OpenRouter is inactive.");
if (!process.env.NVIDIA_NIM_API_KEY || !enabled("NVIDIA_NIM_ENABLED")) warnings.push("NVIDIA NIM is inactive.");
if (nvidiaEnabled.size === 0) warnings.push("No NVIDIA model passed release calibration.");
if (!enabled("MODEL_PROVIDER_BALANCE_ENABLED")) warnings.push("Provider balancing is disabled.");
if (!enabled("MODEL_ROUTE_STATE_ENABLED")) warnings.push("Persistent circuit breaking is disabled.");
if (process.env.OPENROUTER_ALLOW_PERSONAL_SENSITIVE !== "true") warnings.push("Personal-sensitive context remains blocked from OpenRouter by default.");
if (process.env.NVIDIA_NIM_ALLOW_PERSONAL_SENSITIVE !== "true") warnings.push("Personal-sensitive context remains blocked from NVIDIA NIM by default.");

console.log(`\nProvider diversity: ${activeProviders.length} active provider(s): ${activeProviders.join(", ")}`);
console.log(`Total attempt cap: ${process.env.MODEL_MAX_ROUTE_ATTEMPTS || 5}; Google=${process.env.MODEL_GOOGLE_MAX_ATTEMPTS || 2}, NVIDIA=${process.env.MODEL_NVIDIA_MAX_ATTEMPTS || 2}, OpenRouter=${process.env.MODEL_OPENROUTER_MAX_ATTEMPTS || 1}`);
console.log(`OpenRouter proactive free guard: limit=${process.env.OPENROUTER_DAILY_LIMIT || 50}, reserve=${process.env.OPENROUTER_QUOTA_RESERVE_REQUESTS || 5}`);
console.log(`Provider target weights: ${process.env.MODEL_PROVIDER_TARGET_WEIGHTS || "google:0.40,nvidia:0.40,openrouter:0.20"}`);
console.log(warnings.length ? "\nNotes:\n- " + warnings.join("\n- ") : "\nRouting configuration looks healthy.");
