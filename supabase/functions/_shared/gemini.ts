import { CONFIG } from "./config.ts";
import { validateSchema } from "./schema-validation.ts";

const BASE = "https://generativelanguage.googleapis.com";

function geminiApiKey(): string {
  if (!CONFIG.geminiApiKey) throw new Error("GEMINI_API_KEY is not configured");
  return CONFIG.geminiApiKey;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: {
    retries?: number;
    retryStatuses?: number[];
    timeoutMs?: number;
  } = {},
): Promise<Response> {
  const retries = options.retries ?? 2;
  const retryStatuses = options.retryStatuses ?? [500, 502, 503, 504];
  const timeoutMs = options.timeoutMs ?? 0;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(new DOMException("Request timed out", "AbortError")), timeoutMs)
      : null;

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller?.signal ?? init.signal,
      });
      if (response.ok) return response;

      // 429 is deliberately NOT retried here. The model router owns quota fallback/circuit behavior.
      if (!retryStatuses.includes(response.status) || attempt === retries) {
        return response;
      }

      const retryAfter = Number(response.headers.get("retry-after") ?? "0");
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
      await sleep(500 * 2 ** attempt);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("fetchWithRetry failed");
}

export type ThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  totalTokens: number | null;
};

export class GeminiApiError extends Error {
  status: number;
  apiStatus: string | null;
  model: string;
  operation: string;
  quotaMetric: string | null;
  quotaId: string | null;
  retryAfterMs: number | null;
  rawDetail: string;

  constructor(args: {
    message: string;
    status: number;
    apiStatus?: string | null;
    model: string;
    operation: string;
    quotaMetric?: string | null;
    quotaId?: string | null;
    retryAfterMs?: number | null;
    rawDetail: string;
  }) {
    super(args.message);
    this.name = "GeminiApiError";
    this.status = args.status;
    this.apiStatus = args.apiStatus ?? null;
    this.model = args.model;
    this.operation = args.operation;
    this.quotaMetric = args.quotaMetric ?? null;
    this.quotaId = args.quotaId ?? null;
    this.retryAfterMs = args.retryAfterMs ?? null;
    this.rawDetail = args.rawDetail;
  }
}

function usageFrom(json: any): ModelUsage {
  const usage = json?.usageMetadata ?? {};
  return {
    inputTokens: Number.isFinite(Number(usage.promptTokenCount)) ? Number(usage.promptTokenCount) : null,
    outputTokens: Number.isFinite(Number(usage.candidatesTokenCount)) ? Number(usage.candidatesTokenCount) : null,
    thinkingTokens: Number.isFinite(Number(usage.thoughtsTokenCount)) ? Number(usage.thoughtsTokenCount) : null,
    totalTokens: Number.isFinite(Number(usage.totalTokenCount)) ? Number(usage.totalTokenCount) : null,
  };
}

function parseDurationMs(value: unknown): number | null {
  const text = String(value ?? "").trim();
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)s$/i);
  if (!match) return null;
  const ms = Number(match[1]) * 1000;
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null;
}

async function geminiErrorFromResponse(
  response: Response,
  model: string,
  operation: string,
): Promise<GeminiApiError> {
  const rawDetail = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(rawDetail);
  } catch {
    parsed = null;
  }

  const error = parsed?.error ?? {};
  const details = Array.isArray(error?.details) ? error.details : [];
  const quotaFailure = details.find((item: any) => String(item?.["@type"] ?? "").endsWith("QuotaFailure"));
  const retryInfo = details.find((item: any) => String(item?.["@type"] ?? "").endsWith("RetryInfo"));
  const violation = quotaFailure?.violations?.[0] ?? null;
  const retryAfterHeader = Number(response.headers.get("retry-after") ?? "0");
  const retryAfterMs = retryAfterHeader > 0
    ? retryAfterHeader * 1000
    : parseDurationMs(retryInfo?.retryDelay);

  return new GeminiApiError({
    message: `Gemini ${operation} failed ${response.status}: ${error?.message ?? rawDetail.slice(0, 800)}`,
    status: response.status,
    apiStatus: error?.status ?? null,
    model,
    operation,
    quotaMetric: violation?.quotaMetric ?? null,
    quotaId: violation?.quotaId ?? null,
    retryAfterMs,
    rawDetail,
  });
}

export async function generateStructured<T>(args: {
  systemPrompt: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  thinkingLevel: ThinkingLevel;
  model: string;
}): Promise<{ value: T; latencyMs: number; rawChars: number; usage: ModelUsage }> {
  const started = Date.now();

  const response = await fetchWithRetry(
    `${BASE}/v1beta/models/${args.model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey(),
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: args.systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: args.userPrompt }],
          },
        ],
        generationConfig: {
          thinkingConfig: {
            thinkingLevel: args.thinkingLevel,
          },
          responseMimeType: "application/json",
          responseSchema: args.schema,
          maxOutputTokens: 8192,
        },
      }),
    },
    {
      retries: 1,
      retryStatuses: [500, 502, 503, 504],
      timeoutMs: CONFIG.modelTimeoutMs,
    },
  );

  if (!response.ok) {
    throw await geminiErrorFromResponse(response, args.model, "structured call");
  }

  const json = await response.json();
  const text = json?.candidates?.[0]?.content?.parts
    ?.map((part: any) => part?.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error(`Gemini returned no structured text: ${JSON.stringify(json).slice(0, 1200)}`);

  let value: T;
  try {
    value = JSON.parse(text) as T;
  } catch {
    throw new Error(`Gemini returned invalid JSON: ${text.slice(0, 1000)}`);
  }

  const schemaErrors = validateSchema(value, args.schema);
  if (schemaErrors.length) {
    throw new Error(`Gemini returned JSON that violates the response schema: ${schemaErrors.slice(0, 8).join("; ")}`);
  }

  return {
    value,
    latencyMs: Date.now() - started,
    rawChars: text.length,
    usage: usageFrom(json),
  };
}

async function embedPreparedText(prepared: string): Promise<number[]> {
  const response = await fetchWithRetry(
    `${BASE}/v1beta/models/${CONFIG.embeddingModel}:embedContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey(),
      },
      body: JSON.stringify({
        content: { parts: [{ text: prepared }] },
        output_dimensionality: CONFIG.embeddingDimensions,
      }),
    },
    { retries: 1, retryStatuses: [500, 502, 503, 504], timeoutMs: CONFIG.modelTimeoutMs },
  );

  if (!response.ok) {
    throw await geminiErrorFromResponse(response, CONFIG.embeddingModel, "embedding");
  }

  const json = await response.json();
  const values = json?.embedding?.values;
  if (!Array.isArray(values) || values.length !== CONFIG.embeddingDimensions) {
    throw new Error(`Unexpected embedding payload/dimension: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return values;
}

export async function embedQuery(text: string): Promise<number[]> {
  return await embedPreparedText(`task: search result | query: ${text}`);
}

export async function embedDocument(title: string, text: string): Promise<number[]> {
  return await embedPreparedText(`title: ${title || "none"} | text: ${text}`);
}

export async function embedDocuments(
  docs: Array<{ title: string; text: string }>,
): Promise<number[][]> {
  if (!docs.length) return [];

  const batches: Array<Array<{ title: string; text: string }>> = [];
  for (let i = 0; i < docs.length; i += 16) batches.push(docs.slice(i, i + 16));

  const all: number[][] = [];
  for (const batch of batches) {
    const response = await fetchWithRetry(
      `${BASE}/v1beta/models/${CONFIG.embeddingModel}:batchEmbedContents`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiApiKey(),
        },
        body: JSON.stringify({
          requests: batch.map((doc) => ({
            model: `models/${CONFIG.embeddingModel}`,
            content: {
              parts: [{ text: `title: ${doc.title || "none"} | text: ${doc.text}` }],
            },
            output_dimensionality: CONFIG.embeddingDimensions,
          })),
        }),
      },
      { retries: 1, retryStatuses: [500, 502, 503, 504], timeoutMs: CONFIG.modelTimeoutMs },
    );

    if (!response.ok) {
      throw await geminiErrorFromResponse(response, CONFIG.embeddingModel, "batch embedding");
    }

    const json = await response.json();
    const embeddings = json?.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
      throw new Error(`Unexpected batch embedding payload: ${JSON.stringify(json).slice(0, 700)}`);
    }

    for (const embedding of embeddings) {
      const values = embedding?.values;
      if (!Array.isArray(values) || values.length !== CONFIG.embeddingDimensions) {
        throw new Error("Unexpected embedding dimension in batch response");
      }
      all.push(values);
    }
  }

  return all;
}

async function uploadGeminiFile(
  bytes: Uint8Array,
  mimeType: string,
  displayName: string,
): Promise<{ uri: string; name: string }> {
  const start = await fetchWithRetry(`${BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": geminiApiKey(),
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  }, { retries: 1, retryStatuses: [500, 502, 503, 504] });

  if (!start.ok) {
    throw await geminiErrorFromResponse(start, CONFIG.transcriptionModel, "file upload start");
  }

  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini Files API returned no upload URL");

  const finish = await fetchWithRetry(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
      "Content-Type": mimeType,
    },
    body: Uint8Array.from(bytes).buffer,
  }, { retries: 1, retryStatuses: [500, 502, 503, 504] });

  if (!finish.ok) {
    throw await geminiErrorFromResponse(finish, CONFIG.transcriptionModel, "file upload");
  }

  const json = await finish.json();
  const uri = json?.file?.uri;
  const name = json?.file?.name;
  if (!uri || !name) throw new Error(`Gemini Files API returned invalid metadata: ${JSON.stringify(json)}`);
  return { uri, name };
}

async function deleteGeminiFile(name: string) {
  try {
    await fetch(`${BASE}/v1beta/${name}`, {
      method: "DELETE",
      headers: { "x-goog-api-key": geminiApiKey() },
    });
  } catch (error) {
    console.error("Gemini temp file cleanup failed", error);
  }
}

export async function transcribeAudio(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ text: string; latencyMs: number; usage: ModelUsage }> {
  const started = Date.now();
  const uploaded = await uploadGeminiFile(bytes, mimeType, "telegram_voice");

  try {
    const response = await fetchWithRetry(
      `${BASE}/v1beta/models/${CONFIG.transcriptionModel}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiApiKey(),
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  fileData: {
                    fileUri: uploaded.uri,
                    mimeType,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            audioTranscriptionConfig: {
              languageCodes: [],
              mode: "SMART",
              customVocabulary: CONFIG.transcriptionVocabulary,
            },
          },
        }),
      },
      { retries: 1, retryStatuses: [500, 502, 503, 504], timeoutMs: CONFIG.modelTimeoutMs },
    );

    if (!response.ok) {
      throw await geminiErrorFromResponse(response, CONFIG.transcriptionModel, "transcription");
    }

    const json = await response.json();
    const text = json?.candidates?.[0]?.content?.parts
      ?.map((part: any) => part?.audioTranscription?.text ?? part?.text ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();

    if (!text) throw new Error(`Gemini transcription returned no text: ${JSON.stringify(json).slice(0, 800)}`);
    return { text, latencyMs: Date.now() - started, usage: usageFrom(json) };
  } finally {
    await deleteGeminiFile(uploaded.name);
  }
}
