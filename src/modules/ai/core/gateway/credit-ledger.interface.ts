export interface AiCreditReserveInput {
  orgId: string;
  userId: string | null;
  feature: string;
  credits: number;
  idempotencyKey?: string;
}

export interface AiCreditSettleInput {
  orgId: string;
  actualMilli?: number;
  model?: string;
  metadata?: Record<string, unknown>;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface AiCreditLedger {
  reserve(input: AiCreditReserveInput): Promise<{ reservationId: number }>;

  settle(reservationId: number, input: AiCreditSettleInput): Promise<void>;

  release(reservationId: number, reason: string, orgId: string): Promise<void>;
}

export const AI_CREDIT_LEDGER = "AI_CREDIT_LEDGER";
