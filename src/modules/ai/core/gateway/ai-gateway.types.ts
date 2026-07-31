export interface AiTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface AiUsageMeta {
  model: string;
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
  kind: "not_configured" | "provider_unavailable" | "quota_exceeded" | "invalid_output";
  message: string;
  correlationId: string;
}

export type AiInvokeResult<T> = AiInvokeSuccess<T> | AiInvokeFailure;

export interface AiInvokeWithUsageSuccess<T> {
  ok: true;
  data: T;
  aiUsage: AiUsageMeta;
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
  charge?: boolean;
  redact?: boolean;
  dedupe?: boolean;
}
