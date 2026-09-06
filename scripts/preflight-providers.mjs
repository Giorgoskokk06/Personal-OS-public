#!/usr/bin/env node
import { loadEnv } from "./lib.mjs";
import { nvidiaModelProfile } from "./provider-catalog.mjs";

loadEnv();
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => argv.find((x) => x.startsWith(`--${name}=`))?.split("=", 2)[1] ?? fallback;
const providerArg = arg("provider", "all");
const modelArg = arg("model", null);
const jsonOutput = argv.includes("--json");
const authOnly = argv.includes("--auth-only");
const timeoutMs = Number(process.env.PROVIDER_PREFLIGHT_TIMEOUT_MS || 45000);

function parseJson(text) {
  const trimmed = String(text || "").trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch {}
  }
  throw new Error(`invalid JSON response: ${trimmed.slice(0, 500)}`);
}

function nvidiaBody(model) {
  const profile = nvidiaModelProfile(model);
  const body = {
    model,
    messages: [
      { role: "system", content: "Return ONLY one valid minified JSON object. No markdown, no prose, no reasoning trace." },
      { role: "user", content: 'Return exactly this data as JSON: ok=true, language="el", value="Αθήνα".' },
    ],
    response_format: { type: "json_object" },
    max_tokens: profile?.preflightTokens || 512,
    temperature: 0,
    stream: false,
  };
  if (profile?.thinking === "nemotron") body.chat_template_kwargs = { enable_thinking: false };
  if (profile?.thinking === "deepseek") body.chat_template_kwargs = { thinking: false };
  return body;
}

function openRouterBody(model) {
  return {
    model,
    messages: [
      { role: "system", content: "Return JSON matching the requested schema." },
      { role: "user", content: 'Απάντησε με ok=true, language="el", value="Αθήνα".' },
    ],
    max_tokens: 256,
    temperature: 0,
    stream: false,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "provider_preflight",
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" }, language: { type: "string" }, value: { type: "string" } },
          required: ["ok", "language", "value"],
          additionalProperties: false,
        },
      },
    },
    provider: {
      allow_fallbacks: true,
      require_parameters: true,
      data_collection: "deny",
      zdr: true,
    },
  };
}

async function openRouterAuth({ baseUrl, apiKey }) {
  if (!apiKey) return { provider: "openrouter", model: "(auth)", ok: false, auth_ok: false, skipped: true, status: null, latency_ms: 0, detail: "API key not configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/key`, {
      method: "GET",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const raw = await response.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : {}; } catch {}
    const ok = response.ok;
    return {
      provider: "openrouter",
      model: "(auth)",
      ok,
      auth_ok: ok,
      transport_ok: ok,
      structured_ok: null,
      status: response.status,
      latency_ms: Date.now() - started,
      detail: ok ? `OpenRouter key valid; free_tier=${Boolean(json?.data?.is_free_tier)}` : String(json?.error?.message || raw.slice(0, 500)),
    };
  } catch (error) {
    return { provider: "openrouter", model: "(auth)", ok: false, auth_ok: false, transport_ok: false, structured_ok: null, status: null, latency_ms: Date.now() - started, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function callChat({ provider, baseUrl, apiKey, model }) {
  if (!apiKey) return { provider, model, ok: false, auth_ok: false, transport_ok: false, structured_ok: false, skipped: true, status: null, latency_ms: 0, detail: "API key not configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const body = provider === "openrouter" ? openRouterBody(model) : nvidiaBody(model);
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(provider === "openrouter" ? { "X-Title": "Personal OS Provider Preflight" } : {}),
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : {}; } catch {}
    if (!response.ok) {
      return {
        provider, model, ok: false, auth_ok: ![401, 403].includes(response.status), transport_ok: false, structured_ok: false,
        status: response.status, latency_ms: Date.now() - started,
        detail: String(json?.error?.message || json?.detail || json?.error || raw.slice(0, 500)),
      };
    }
    const choice = json?.choices?.[0];
    const text = choice?.message?.content;
    try {
      const value = parseJson(text);
      const structuredOk = value?.ok === true && value?.language === "el" && value?.value === "Αθήνα" && choice?.finish_reason === "stop";
      return {
        provider, model, ok: structuredOk, auth_ok: true, transport_ok: true, structured_ok: structuredOk,
        status: response.status, latency_ms: Date.now() - started,
        served_model: json?.model || null,
        finish_reason: choice?.finish_reason || null,
        detail: structuredOk ? "Greek + JSON contract passed" : `structured contract mismatch: ${JSON.stringify(value).slice(0, 300)}; finish_reason=${choice?.finish_reason || ""}`,
      };
    } catch (error) {
      return {
        provider, model, ok: false, auth_ok: true, transport_ok: true, structured_ok: false,
        status: response.status, latency_ms: Date.now() - started,
        served_model: json?.model || null,
        finish_reason: choice?.finish_reason || null,
        detail: `${error instanceof Error ? error.message : String(error)}; finish_reason=${choice?.finish_reason || ""}`,
      };
    }
  } catch (error) {
    return { provider, model, ok: false, auth_ok: null, transport_ok: false, structured_ok: false, status: null, latency_ms: Date.now() - started, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

const checks = [];
if (["all", "openrouter"].includes(providerArg)) {
  const baseUrl = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (authOnly) checks.push(await openRouterAuth({ baseUrl, apiKey }));
  else checks.push(await callChat({ provider: "openrouter", baseUrl, apiKey, model: modelArg || process.env.OPENROUTER_FREE_MODEL || "openrouter/free" }));
}
if (["all", "nvidia"].includes(providerArg)) {
  checks.push(await callChat({
    provider: "nvidia",
    baseUrl: process.env.NVIDIA_NIM_BASE_URL || "https://integrate.api.nvidia.com/v1",
    apiKey: process.env.NVIDIA_NIM_API_KEY || process.env.NVIDIA_API_KEY,
    model: modelArg || "nvidia/nemotron-3.5-lightning-30b-a3b",
  }));
}

if (jsonOutput) console.log(JSON.stringify(checks));
else console.table(checks.map(({ provider, model, ok, auth_ok, transport_ok, structured_ok, status, latency_ms, served_model, finish_reason, detail }) => ({ provider, model, ok, auth_ok, transport_ok, structured_ok, status: status ?? "", latency_ms, served_model: served_model || "", finish_reason: finish_reason || "", detail })));
const attempted = checks.filter((x) => !x.skipped);
if (!attempted.length) process.exitCode = 2;
else if (attempted.some((x) => !x.ok)) process.exitCode = 1;
