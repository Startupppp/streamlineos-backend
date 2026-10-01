import { ConflictException, Injectable } from "@nestjs/common";
import { creditsToMilli } from "../../ai/core/billing/ai-model-pricing.constants";
import { AiCreditsService } from "../../billing/core/ai-credits.service";

export interface CreditLedgerOptions {
  reason: string;
  feature?: string;
  userId?: string;
  actorMembershipId?: number;
  idempotencyKey?: string;
}

export interface CanonicalCreditBalance {
  id: number;
  orgId: string;
  balance: number;
  lifetimeGranted: number;
  lifetimeConsumed: number;
}

@Injectable()
export class KbCreditsService {
  constructor(private readonly ledger: AiCreditsService) {}

  async getBalance(orgId: string): Promise<CanonicalCreditBalance> {
    const { wallet } = await this.ledger.getWallet(orgId);
    return {
      id: wallet.id,
      orgId: wallet.orgId,
      balance: wallet.balance,
      lifetimeGranted: wallet.lifetimeGranted,
      lifetimeConsumed: wallet.lifetimeConsumed,
    };
  }

  async ensure(orgId: string): Promise<CanonicalCreditBalance> {
    return this.getBalance(orgId);
  }

  async hasCredits(orgId: string, cost: number): Promise<boolean> {
    if (cost <= 0) return true;
    return (await this.getBalance(orgId)).balance >= cost;
  }

  async consume(orgId: string, cost: number, options: CreditLedgerOptions): Promise<number> {
    if (cost <= 0) return (await this.getBalance(orgId)).balance;
    const idempotencyKey = this.requireIdempotencyKey(options.idempotencyKey);
    const actualMilli = creditsToMilli(cost);
    const { reservationId } = await this.ledger.reserve({
      orgId,
      userId: options.userId ?? null,
      feature: options.feature ?? "kb.legacy-consume",
      credits: actualMilli,
      idempotencyKey,
    });
    await this.ledger.settle(reservationId, {
      orgId,
      actualMilli,
      metadata: { reason: options.reason },
    });
    return (await this.getBalance(orgId)).balance;
  }

  async grant(orgId: string, amount: number, options: CreditLedgerOptions): Promise<number> {
    if (amount <= 0) return (await this.getBalance(orgId)).balance;
    const result = await this.ledger.grantCredits({
      orgId,
      userId: options.userId ?? null,
      credits: amount,
      feature: options.feature ?? "kb.legacy-grant",
      reason: options.reason,
      idempotencyKey: this.requireIdempotencyKey(options.idempotencyKey),
    });
    return result.balance;
  }

  private requireIdempotencyKey(value: string | undefined): string {
    if (!value?.trim()) {
      throw new ConflictException("An idempotency key is required for AI credit mutations");
    }
    return value.trim();
  }
}
