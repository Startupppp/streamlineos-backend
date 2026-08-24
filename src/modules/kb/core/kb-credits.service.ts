import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, sql } from "drizzle-orm";
import { tenantAiCredits, tenantAiCreditTransactions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";

export interface CreditLedgerOptions {
  reason: string;
  feature?: string;
  actorId?: string;
}

const DEFAULT_AI_CREDITS = 100_000;

@Injectable()
export class KbCreditsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  getBalance(
    orgId: string,
  ): Promise<typeof tenantAiCredits.$inferSelect | undefined> {
    return this.db.query.tenantAiCredits.findFirst({
      where: eq(tenantAiCredits.orgId, orgId),
    });
  }

  async ensure(
    orgId: string,
  ): Promise<typeof tenantAiCredits.$inferSelect | undefined> {
    const existing = await this.getBalance(orgId);
    if (existing) return existing;
    await this.db
      .insert(tenantAiCredits)
      .values({
        orgId,
        balance: DEFAULT_AI_CREDITS,
        monthlyAllowance: DEFAULT_AI_CREDITS,
      })
      .onConflictDoNothing({ target: tenantAiCredits.orgId });
    return this.getBalance(orgId);
  }

  async hasCredits(orgId: string, cost: number): Promise<boolean> {
    if (cost <= 0) return true;
    const row = (await this.getBalance(orgId)) ?? (await this.ensure(orgId));
    return (row?.balance ?? 0) >= cost;
  }

  async consume(
    orgId: string,
    cost: number,
    options: CreditLedgerOptions,
  ): Promise<number> {
    if (cost <= 0) {
      const row = await this.getBalance(orgId);
      return row?.balance ?? 0;
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(tenantAiCredits)
        .set({ balance: sql`${tenantAiCredits.balance} - ${cost}` })
        .where(
          and(
            eq(tenantAiCredits.orgId, orgId),
            gte(tenantAiCredits.balance, cost),
          ),
        )
        .returning({ balance: tenantAiCredits.balance });
      if (!row) throw new InsufficientAiCreditsException();
      await tx.insert(tenantAiCreditTransactions).values({
        orgId,
        delta: -cost,
        balanceAfter: row.balance,
        reason: options.reason,
        feature: options.feature ?? null,
        actorId: options.actorId ?? null,
      });
      return row.balance;
    });
  }

  async grant(
    orgId: string,
    amount: number,
    options: CreditLedgerOptions,
  ): Promise<number> {
    if (amount <= 0) {
      const row = await this.getBalance(orgId);
      return row?.balance ?? 0;
    }
    await this.ensure(orgId);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(tenantAiCredits)
        .set({ balance: sql`${tenantAiCredits.balance} + ${amount}` })
        .where(eq(tenantAiCredits.orgId, orgId))
        .returning({ balance: tenantAiCredits.balance });
      const balance = row?.balance ?? amount;
      await tx.insert(tenantAiCreditTransactions).values({
        orgId,
        delta: amount,
        balanceAfter: balance,
        reason: options.reason,
        feature: options.feature ?? null,
        actorId: options.actorId ?? null,
      });
      return balance;
    });
  }
}
