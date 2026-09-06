import type { ModelUsage } from "../gemini.ts";
import { lowerSchema, validateSchema } from "../schema-validation.ts";
import { ProviderApiError, type StructuredGenerationArgs, type StructuredGenerationResult } from "./types.ts";

function parseRetryAfterMs(response: Response, json: any): number | null {
  const header = Number(response.headers.get("retry-after") ?? "0");
  if (header > 0) return header * 1000;
  const value = Number(json?.error?.metadata?.retry_after ?? json?.retry_after ?? 0);
  return value > 0 ? value * 1000 : null;
}

function usageFrom(json: any): ModelUsage {
  const u = json?.usage ?? {};
  const input = Number(u.prompt_tokens ?? u.input_tokens);
  const output = Number(u.completion_tokens ?? u.output_tokens);
  const reasoning = Number(u?.completion_tokens_details?.reasoning_tokens ?? u?.output_tokens_details?.reasoning_tokens);
  const total = Number(u.total_tokens);
  return {
    inputTokens: Number.isFinite(input) ? input : null,
    outputTokens: Number.isFinite(output) ? output : null,
    thinkingTokens: Number.isFinite(reasoning) ? reasoning : null,
    totalTokens: Number.isFinite(total) ? total : null,
  };
}

function contentText(content: any): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : (part?.text ?? part?.content ?? "")).join("").trim();
  }
  return String(content ?? "").trim();
}

function errorMessage(error: any, raw: string): string {
  if (typeof error === "string") return error;
  if (error?.message) return String(error.message);
  if (error?.code) return String(error.code);
  return raw.slice(0, 800);
}

function parseJsonCandidate<T>(text: string, context = ""): T {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]?.trim()).filter(Boolean) as string[];
  candidates.push(...fenced);

  const starts: number[] = [];
  for (let i = 0; i < trimmed.length; i++) if (trimmed[i] === "{") starts.push(i);
  for (const start of starts.slice(0, 20)) {
    for (let end = trimmed.lastIndexOf("}"); end > start; end = trimmed.lastIndexOf("}", end - 1)) {
      candidates.push(trimmed.slice(start, end + 1));
      if (candidates.length > 60) break;
    }
    if (candidates.length > 60) break;
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try next candidate.
    }
  }
  throw new Error(`Provider returned invalid JSON${context ? ` (${context})` : ""}: ${trimmed.slice(0, 1200)}`);
}


export async function generateOpenAiCompatible<T>(args: StructuredGenerationArgs & {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  providerPreferences?: Record<string, unknown>;
  sendReasoning?: boolean;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  responseFormatMode?: "json_schema" | "json_object" | "prompt_json";
  maxTokens?: number;
}): Promise<StructuredGenerationResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "AbortError")), args.timeoutMs);
  const started = Date.now();
  try {
    const loweredSchema = lowerSchema(args.schema);
    const responseFormatMode = args.responseFormatMode ?? "json_schema";
    const systemPrompt = responseFormatMode === "prompt_json"
      ? `${args.systemPrompt}\n\nOUTPUT CONTRACT\nReturn ONLY one valid JSON object. Do not use Markdown fences or explanatory text. The JSON MUST satisfy this schema exactly. Every required field must be present; use empty strings/arrays where the schema requires a field but no value is appropriate.\nJSON SCHEMA:\n${JSON.stringify(loweredSchema)}`
      : args.systemPrompt;

    const body: Record<string, unknown> = {
      model: args.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: args.userPrompt },
      ],
      stream: false,
      max_tokens: args.maxTokens ?? 8192,
      ...(args.extraBody ?? {}),
    };

    if (responseFormatMode === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "personal_os_response",
          strict: true,
          schema: loweredSchema,
        },
      };
    } else if (responseFormatMode === "json_object") {
      // Some OpenAI-compatible providers (notably hosted NVIDIA NIMs) expose
      // reliable JSON mode but not uniform JSON-schema enforcement. We still
      // validate the returned object locally against the full Personal OS schema.
      body.response_format = { type: "json_object" };
    }
    if (args.providerPreferences) body.provider = args.providerPreferences;
    if (args.sendReasoning) body.reasoning = { effort: args.thinkingLevel.toLowerCase(), exclude: true };

    const url = `${args.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.apiKey}`,
        ...(args.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let json: any = null;
    try { json = raw ? JSON.parse(raw) : {}; } catch { json = null; }

    if (!response.ok) {
      const error = json?.error ?? {};
      throw new ProviderApiError({
        message: `${args.providerId} structured call failed ${response.status}: ${errorMessage(error, raw)}`,
        provider: args.providerId,
        status: response.status,
        apiStatus: error?.code ? String(error.code) : null,
        model: args.model,
        operation: "structured call",
        quotaMetric: error?.metadata?.quota_metric ?? null,
        quotaId: error?.metadata?.quota_id ?? null,
        retryAfterMs: parseRetryAfterMs(response, json),
        rawDetail: raw,
      });
    }

    if (response.status === 202 && !json?.choices?.[0]?.message?.content) {
      throw new ProviderApiError({
        message: `${args.providerId} returned a pending response without a completion`,
        provider: args.providerId,
        status: 503,
        apiStatus: "PENDING",
        model: args.model,
        operation: "structured call",
        rawDetail: raw,
      });
    }

    const choice = json?.choices?.[0];
    const finishReason = choice?.finish_reason ? String(choice.finish_reason) : null;
    const servedModel = json?.model ? String(json.model) : null;
    const text = contentText(choice?.message?.content);
    if (!text) throw new Error(`${args.providerId} returned no structured text${finishReason ? `; finish_reason=${finishReason}` : ""}`);
    const value = parseJsonCandidate<T>(text, [servedModel ? `served_model=${servedModel}` : "", finishReason ? `finish_reason=${finishReason}` : ""].filter(Boolean).join(", "));
    const schemaErrors = validateSchema(value, loweredSchema);
    if (schemaErrors.length) {
      throw new Error(`${args.providerId} returned JSON that violates the response schema: ${schemaErrors.slice(0, 8).join("; ")}`);
    }

    return { value, latencyMs: Date.now() - started, rawChars: text.length, usage: usageFrom(json), servedModel, finishReason };
  } finally {
    clearTimeout(timer);
  }
}
