import { z } from "zod";

export interface AiTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface AiUsageMeta {
  model: string;
  provider?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  credits: number;
  costUsd: number;
}

export interface AiInvokeSuccess<T> {
  ok: true;
  data: T;
  model: string;
  latencyMs: number;
  correlationId: string;
  usage: AiTokenUsage;
}

export interface AiInvokeFailure {
  ok: false;
  kind:
    | "not_configured"
    | "provider_unavailable"
    | "quota_exceeded"
    | "invalid_output"
    | "context_too_large"
    | "concurrency_exceeded"
    | "cancelled";
  message: string;
  correlationId: string;
}

export type AiInvokeResult<T> = AiInvokeSuccess<T> | AiInvokeFailure;

export interface AiInvokeWithUsageSuccess<T> {
  ok: true;
  data: T;
  aiUsage: AiUsageMeta;
  /**
   * F6. The gateway's own id for this call, and the join back into
   * `ai_usage_logs`.
   *
   * The failure branch has always carried one; the success branch did not, so a
   * caller that used a `*WithUsage` variant — which is what new AI endpoints are
   * required to use — had no way to record *which* call produced an answer. That
   * makes a "this was wrong" report unactionable: there is a complaint, and no
   * way to find the invocation, prompt version, model or cost behind it.
   */
  correlationId: string;
}

export type AiInvokeWithUsageResult<T> = AiInvokeWithUsageSuccess<T> | AiInvokeFailure;

export interface AiInvokeActor {
  orgId: string;
  userId: string | null;
}

export interface AiInvokePrompt {
  system: string;
  user: string;
  promptKey?: string;
  promptVersion?: number;
}

export interface AiInvokeBaseOpts {
  actor: AiInvokeActor;
  feature: string;
  prompt: AiInvokePrompt;
  tier?: "fast" | "standard";
  maxTokens?: number;
  maxContextChars?: number;
  charge?: boolean;
  redact?: boolean;
  dedupe?: boolean;
  signal?: AbortSignal;
}

export interface InvokeStructuredOpts<T> extends AiInvokeBaseOpts {
  schema: z.ZodType<T>;
}

export interface InvokeStructuredWithImageOpts<T>
  extends InvokeStructuredOpts<T> {
  images: string[];
}

export type InvokeTextOpts = AiInvokeBaseOpts;

export interface EmbedQueryOpts {
  text: string;
  orgId: string;
  feature: string;
  charge: boolean;
  signal?: AbortSignal;
}

export interface EmbedQuerySuccess {
  ok: true;
  vector: number[];
  vectorLiteral: string;
}

export type EmbedQueryResult = EmbedQuerySuccess | AiInvokeFailure;

export interface EmbedBatchOpts {
  texts: string[];
  orgId: string;
  feature: string;
  charge: boolean;
  signal?: AbortSignal;
}

export interface EmbedBatchSuccess {
  ok: true;
  vectors: number[][];
}

export type EmbedBatchResult = EmbedBatchSuccess | AiInvokeFailure;
