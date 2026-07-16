import type { AiCreditLedger } from "./credit-ledger.interface";

export class NoopCreditLedger implements AiCreditLedger {
  async reserve(_input: {
    orgId: string;
    userId: string | null;
    feature: string;
    credits: number;
    idempotencyKey?: string;
  }): Promise<{ reservationId: number }> {
    return { reservationId: 0 };
  }

  async settle(
    _reservationId: number,
    _input: { actualCredits?: number; model?: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    return;
  }

  async release(_reservationId: number, _reason: string): Promise<void> {
    return;
  }
}
