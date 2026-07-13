import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  aiCreditPacks,
  aiCreditTransactions,
  orgAiCredits,
} from "../../db/schema";

@Injectable()
export class AiCreditsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getWallet(orgId: string) {
    let [wallet] = await this.db
      .select()
      .from(orgAiCredits)
      .where(eq(orgAiCredits.orgId, orgId));
    if (!wallet) {
      [wallet] = await this.db
        .insert(orgAiCredits)
        .values({ orgId })
        .returning();
    }
    const recentTransactions = await this.db
      .select()
      .from(aiCreditTransactions)
      .where(eq(aiCreditTransactions.orgId, orgId))
      .orderBy(desc(aiCreditTransactions.createdAt))
      .limit(20);
    return { wallet, recentTransactions };
  }

  async listPacks() {
    return this.db
      .select()
      .from(aiCreditPacks)
      .where(eq(aiCreditPacks.isActive, true))
      .orderBy(aiCreditPacks.sortOrder);
  }

  async consumeCredits(
    orgId: string,
    userId: string,
    amount: number,
    feature: string,
    model?: string,
    referenceId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [wallet] = await tx
        .select()
        .from(orgAiCredits)
        .where(eq(orgAiCredits.orgId, orgId))
        .for("update");

      if (!wallet || wallet.balance < amount) {
        throw new BadRequestException("Insufficient AI credits");
      }

      const newBalance = wallet.balance - amount;
      await tx
        .update(orgAiCredits)
        .set({
          balance: newBalance,
          lifetimeConsumed: sql`${orgAiCredits.lifetimeConsumed} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(orgAiCredits.orgId, orgId));

      await tx.insert(aiCreditTransactions).values({
        orgId,
        userId,
        type: "USAGE",
        amount: -amount,
        balanceAfter: newBalance,
        feature,
        model,
        referenceId,
      });

      return { balance: newBalance };
    });
  }

  async refundCredits(
    orgId: string,
    userId: string,
    amount: number,
    feature: string,
    referenceId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [wallet] = await tx
        .select()
        .from(orgAiCredits)
        .where(eq(orgAiCredits.orgId, orgId))
        .for("update");

      const currentBalance = wallet?.balance ?? 0;
      const newBalance = currentBalance + amount;

      if (wallet) {
        await tx
          .update(orgAiCredits)
          .set({
            balance: newBalance,
            updatedAt: new Date(),
          })
          .where(eq(orgAiCredits.orgId, orgId));
      } else {
        await tx.insert(orgAiCredits).values({ orgId, balance: newBalance });
      }

      await tx.insert(aiCreditTransactions).values({
        orgId,
        userId,
        type: "REFUND",
        amount,
        balanceAfter: newBalance,
        feature,
        referenceId,
      });

      return { balance: newBalance };
    });
  }

  async grantPlanCredits(orgId: string, plan: string, userId?: string) {
    const grantMap: Record<string, number> = {
      STARTER: 500,
      PROFESSIONAL: 2000,
      ENTERPRISE: 10000,
    };
    const amount = grantMap[plan] ?? 0;
    if (!amount) return;

    await this.db.transaction(async (tx) => {
      let [wallet] = await tx
        .select()
        .from(orgAiCredits)
        .where(eq(orgAiCredits.orgId, orgId));
      if (!wallet) {
        [wallet] = await tx
          .insert(orgAiCredits)
          .values({ orgId })
          .returning();
      }

      const newBalance = wallet.balance + amount;
      await tx
        .update(orgAiCredits)
        .set({
          balance: newBalance,
          lifetimeGranted: sql`${orgAiCredits.lifetimeGranted} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(orgAiCredits.orgId, orgId));

      await tx.insert(aiCreditTransactions).values({
        orgId,
        userId: userId ?? null,
        type: "PLAN_GRANT",
        amount,
        balanceAfter: newBalance,
        feature: "plan_activation",
        referenceId: plan,
      });
    });
  }

  async purchaseCreditsDirectly(orgId: string, userId: string, packId: number) {
    const [pack] = await this.db
      .select()
      .from(aiCreditPacks)
      .where(and(eq(aiCreditPacks.id, packId), eq(aiCreditPacks.isActive, true)));

    if (!pack) throw new NotFoundException("AI credit pack not found or inactive");

    const creditsAdded = pack.credits + pack.bonusCredits;

    const wallet = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(orgAiCredits)
        .where(eq(orgAiCredits.orgId, orgId))
        .for("update");

      let currentBalance = 0;
      if (locked) {
        currentBalance = locked.balance;
      } else {
        await tx.insert(orgAiCredits).values({ orgId });
      }

      const newBalance = currentBalance + creditsAdded;
      const [updated] = await tx
        .update(orgAiCredits)
        .set({
          balance: newBalance,
          lifetimeGranted: sql`${orgAiCredits.lifetimeGranted} + ${creditsAdded}`,
          updatedAt: new Date(),
        })
        .where(eq(orgAiCredits.orgId, orgId))
        .returning();

      await tx.insert(aiCreditTransactions).values({
        orgId,
        userId,
        type: "PURCHASE",
        amount: creditsAdded,
        balanceAfter: newBalance,
        feature: "credit_purchase",
        referenceId: String(packId),
      });

      return updated;
    });

    return { balance: wallet.balance, creditsAdded, pack };
  }

  async updateAutoTopUp(
    orgId: string,
    enabled: boolean,
    packId?: number,
    threshold?: number,
  ) {
    let [wallet] = await this.db
      .select()
      .from(orgAiCredits)
      .where(eq(orgAiCredits.orgId, orgId));
    if (!wallet) {
      [wallet] = await this.db
        .insert(orgAiCredits)
        .values({ orgId })
        .returning();
    }
    const [updated] = await this.db
      .update(orgAiCredits)
      .set({
        autoTopUpEnabled: enabled,
        autoTopUpPackId: packId ?? wallet.autoTopUpPackId,
        autoTopUpThreshold: threshold ?? wallet.autoTopUpThreshold,
        updatedAt: new Date(),
      })
      .where(eq(orgAiCredits.orgId, orgId))
      .returning();
    return updated;
  }

}
