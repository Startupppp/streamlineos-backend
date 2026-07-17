export interface AiTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
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

export interface AiInvokeCharge {
  credits: number;
  idempotencyKey?: string;
}

export interface AiInvokeBaseOpts {
  actor: AiInvokeActor;
  feature: string;
  prompt: AiInvokePrompt;
  tier?: "fast" | "standard";
  maxTokens?: number;
  charge?: AiInvokeCharge;
  redact?: boolean;
  dedupe?: boolean;
}
