export interface AiCreditLedger {
  reserve(input: {
    orgId: string;
    userId: string | null;
    feature: string;
    credits: number;
    idempotencyKey?: string;
  }): Promise<{ reservationId: number }>;

  settle(
    reservationId: number,
    input: {
      actualMilli?: number;
      model?: string;
      metadata?: Record<string, unknown>;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      costUsd?: number;
    },
  ): Promise<void>;

  release(reservationId: number, reason: string): Promise<void>;
}

export const AI_CREDIT_LEDGER = "AI_CREDIT_LEDGER";
