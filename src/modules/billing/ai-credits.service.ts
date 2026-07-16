import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  aiCreditPacks,
  aiCreditTransactions,
  orgAiCredits,
} from "../../db/schema";

const TRIAL_GRANT_AMOUNT = 100;

@Injectable()
export class AiCreditsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getWallet(orgId: string) {
    let [wallet] = await this.db
      .select()
      .from(orgAiCredits)
      .where(eq(orgAiCredits.orgId, orgId));
    if (!wallet) {
      try {
        [wallet] = await this.db.transaction(async (tx) => {
          const [created] = await tx
            .insert(orgAiCredits)
            .values({ orgId, balance: TRIAL_GRANT_AMOUNT, lifetimeGranted: TRIAL_GRANT_AMOUNT })
            .returning();
          await tx.insert(aiCreditTransactions).values({
            orgId,
            userId: null,
            type: "PLAN_GRANT",
            amount: TRIAL_GRANT_AMOUNT,
            balanceAfter: TRIAL_GRANT_AMOUNT,
            feature: "trial-grant",
            referenceId: "trial-grant",
          });
          return [created];
        });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "23505") {
          const [existing] = await this.db
            .select()
            .from(orgAiCredits)
            .where(eq(orgAiCredits.orgId, orgId));
          wallet = existing;
        } else {
          throw err;
        }
      }
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

  async grantPlanCredits(orgId: string, plan: string, userId?: string, referenceId?: string) {
    const grantMap: Record<string, number> = {
      STARTER: 500,
      PROFESSIONAL: 2000,
      ENTERPRISE: 10000,
    };
    const amount = grantMap[plan] ?? 0;
    if (!amount) return;

    try {
      await this.db.transaction(async (tx) => {
        if (referenceId) {
          const [existing] = await tx
            .select({ id: aiCreditTransactions.id })
            .from(aiCreditTransactions)
            .where(
              and(
                eq(aiCreditTransactions.orgId, orgId),
                eq(aiCreditTransactions.type, "PLAN_GRANT"),
                eq(aiCreditTransactions.referenceId, referenceId),
              ),
            )
            .limit(1);
          if (existing) return;
        }

        let [wallet] = await tx
          .select()
          .from(orgAiCredits)
          .where(eq(orgAiCredits.orgId, orgId))
          .for("update");
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
          referenceId: referenceId ?? plan,
        });
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505") {
        return;
      }
      throw err;
    }
  }

  async purchaseCreditsDirectly(orgId: string, userId: string | null, packId: number, automatic = false) {
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
        metadata: automatic ? { automatic: true } : null,
      });

      return updated;
    });

    return { balance: wallet.balance, creditsAdded, pack };
  }

  async listTransactions(orgId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const [items, [countRow]] = await Promise.all([
      this.db
        .select({
          id: aiCreditTransactions.id,
          orgId: aiCreditTransactions.orgId,
          userId: aiCreditTransactions.userId,
          type: aiCreditTransactions.type,
          amount: aiCreditTransactions.amount,
          balanceAfter: aiCreditTransactions.balanceAfter,
          feature: aiCreditTransactions.feature,
          model: aiCreditTransactions.model,
          referenceId: aiCreditTransactions.referenceId,
          createdAt: aiCreditTransactions.createdAt,
        })
        .from(aiCreditTransactions)
        .where(eq(aiCreditTransactions.orgId, orgId))
        .orderBy(desc(aiCreditTransactions.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(aiCreditTransactions)
        .where(eq(aiCreditTransactions.orgId, orgId)),
    ]);
    const total = Number(countRow?.total ?? 0);
    return { items, total, page, totalPages: Math.ceil(total / limit) };
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

  async getWalletsEligibleForAutoTopUp() {
    return this.db
      .select()
      .from(orgAiCredits)
      .where(
        and(
          eq(orgAiCredits.autoTopUpEnabled, true),
          sql`${orgAiCredits.autoTopUpPackId} is not null`,
          sql`${orgAiCredits.balance} < coalesce(${orgAiCredits.autoTopUpThreshold}, 0)`,
        ),
      );
  }

  async hasSameDayPurchaseForPack(orgId: string, packId: number): Promise<boolean> {
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

    const [row] = await this.db
      .select({ id: aiCreditTransactions.id })
      .from(aiCreditTransactions)
      .where(
        and(
          eq(aiCreditTransactions.orgId, orgId),
          eq(aiCreditTransactions.type, "PURCHASE"),
          eq(aiCreditTransactions.referenceId, String(packId)),
          gte(aiCreditTransactions.createdAt, dayStart),
          lt(aiCreditTransactions.createdAt, dayEnd),
        ),
      )
      .limit(1);
    return !!row;
  }

  async hasMonthlyPlanGrant(orgId: string): Promise<boolean> {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const [row] = await this.db
      .select({ id: aiCreditTransactions.id })
      .from(aiCreditTransactions)
      .where(
        and(
          eq(aiCreditTransactions.orgId, orgId),
          eq(aiCreditTransactions.type, "PLAN_GRANT"),
          ne(aiCreditTransactions.feature, "trial-grant"),
          gte(aiCreditTransactions.createdAt, monthStart),
          lt(aiCreditTransactions.createdAt, monthEnd),
        ),
      )
      .limit(1);
    return !!row;
  }

  async getMonthlyGrantedOrgIds(orgIds: string[]): Promise<Set<string>> {
    if (orgIds.length === 0) return new Set();
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const rows = await this.db
      .selectDistinct({ orgId: aiCreditTransactions.orgId })
      .from(aiCreditTransactions)
      .where(
        and(
          eq(aiCreditTransactions.type, "PLAN_GRANT"),
          ne(aiCreditTransactions.feature, "trial-grant"),
          gte(aiCreditTransactions.createdAt, monthStart),
          lt(aiCreditTransactions.createdAt, monthEnd),
          inArray(aiCreditTransactions.orgId, orgIds),
        ),
      );
    return new Set(rows.map((r) => r.orgId));
  }
}
