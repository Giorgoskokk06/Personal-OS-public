import type { ModelUsage, ThinkingLevel } from "../gemini.ts";

export type StructuredGenerationArgs = {
  systemPrompt: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  thinkingLevel: ThinkingLevel;
  model: string;
};

export type StructuredGenerationResult<T> = {
  value: T;
  latencyMs: number;
  rawChars: number;
  usage: ModelUsage;
  servedModel?: string | null;
  finishReason?: string | null;
};

export class ProviderApiError extends Error {
  provider: string;
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
    provider: string;
    status: number;
    apiStatus?: string | null;
    model: string;
    operation: string;
    quotaMetric?: string | null;
    quotaId?: string | null;
    retryAfterMs?: number | null;
    rawDetail?: string;
  }) {
    super(args.message);
    this.name = "ProviderApiError";
    this.provider = args.provider;
    this.status = args.status;
    this.apiStatus = args.apiStatus ?? null;
    this.model = args.model;
    this.operation = args.operation;
    this.quotaMetric = args.quotaMetric ?? null;
    this.quotaId = args.quotaId ?? null;
    this.retryAfterMs = args.retryAfterMs ?? null;
    this.rawDetail = args.rawDetail ?? "";
  }
}

export interface StructuredProvider {
  id: string;
  normalizeThinkingLevel(model: string, requested: ThinkingLevel): ThinkingLevel;
  generateStructured<T>(args: StructuredGenerationArgs): Promise<StructuredGenerationResult<T>>;
}
