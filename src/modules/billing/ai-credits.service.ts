import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  aiCreditPacks,
  aiCreditTransactions,
  orgAiCredits,
} from "../../db/schema";
import { creditsToMilli, milliToCredits } from "../ai/billing/ai-model-pricing.constants";
import { TRIAL_GRANT_MILLI, planGrantMilli } from "./ai-credit-units";
import { AiCreditsReservationService } from "./ai-credits-reservation.service";
import { AiCreditsPacksService } from "./ai-credits-packs.service";
import type { AiCreditReserveInput, AiCreditSettleInput } from "../ai/gateway/credit-ledger.interface";

@Injectable()
export class AiCreditsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly reservation: AiCreditsReservationService,
    private readonly packs: AiCreditsPacksService,
  ) {}

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
            .values({ orgId, balance: TRIAL_GRANT_MILLI, lifetimeGranted: TRIAL_GRANT_MILLI })
            .returning();
          await tx.insert(aiCreditTransactions).values({
            orgId,
            userId: null,
            type: "PLAN_GRANT",
            amount: TRIAL_GRANT_MILLI,
            balanceAfter: TRIAL_GRANT_MILLI,
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
    if (!wallet) throw new NotFoundException("AI credits wallet unavailable");
    const recentTransactions = await this.db
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
        metadata: aiCreditTransactions.metadata,
        promptTokens: aiCreditTransactions.promptTokens,
        completionTokens: aiCreditTransactions.completionTokens,
        totalTokens: aiCreditTransactions.totalTokens,
        costUsd: aiCreditTransactions.costUsd,
        createdAt: aiCreditTransactions.createdAt,
      })
      .from(aiCreditTransactions)
      .where(eq(aiCreditTransactions.orgId, orgId))
      .orderBy(desc(aiCreditTransactions.createdAt))
      .limit(20);

    const mappedTransactions = recentTransactions.map((t) => ({
      ...t,
      amount: milliToCredits(t.amount),
      balanceAfter: milliToCredits(t.balanceAfter),
    }));

    return {
      wallet: {
        ...wallet,
        balance: milliToCredits(wallet.balance),
        lifetimeGranted: milliToCredits(wallet.lifetimeGranted),
        lifetimeConsumed: milliToCredits(wallet.lifetimeConsumed),
        autoTopUpThreshold: wallet.autoTopUpThreshold !== null
          ? milliToCredits(wallet.autoTopUpThreshold)
          : null,
      },
      recentTransactions: mappedTransactions,
    };
  }

  async listPacks() {
    return this.packs.listPacks();
  }

  async grantPlanCredits(orgId: string, plan: string, userId?: string, referenceId?: string) {
    const amountMilli = planGrantMilli(plan);
    if (!amountMilli) return;

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

        const newBalance = wallet.balance + amountMilli;
        await tx
          .update(orgAiCredits)
          .set({
            balance: newBalance,
            lifetimeGranted: sql`${orgAiCredits.lifetimeGranted} + ${amountMilli}`,
            updatedAt: new Date(),
          })
          .where(eq(orgAiCredits.orgId, orgId));

        await tx.insert(aiCreditTransactions).values({
          orgId,
          userId: userId ?? null,
          type: "PLAN_GRANT",
          amount: amountMilli,
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

  async purchaseCreditsDirectly(
    orgId: string,
    userId: string | null,
    packId: number,
    automatic = false,
    paymentReferenceId?: string,
  ) {
    const [pack] = await this.db
      .select()
      .from(aiCreditPacks)
      .where(and(eq(aiCreditPacks.id, packId), eq(aiCreditPacks.isActive, true)));

    if (!pack) throw new NotFoundException("AI credit pack not found or inactive");

    const creditsAdded = pack.credits + pack.bonusCredits;
    const creditsAddedMilli = creditsToMilli(creditsAdded);
    const now = new Date();
    const dateKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
    const referenceId = paymentReferenceId ?? (automatic ? `auto-${packId}-${dateKey}` : String(packId));

    try {
      const wallet = await this.db.transaction(async (tx) => {
        if (automatic) {
          const [existingPurchase] = await tx
            .select({ id: aiCreditTransactions.id })
            .from(aiCreditTransactions)
            .where(
              and(
                eq(aiCreditTransactions.orgId, orgId),
                eq(aiCreditTransactions.type, "PURCHASE"),
                eq(aiCreditTransactions.referenceId, referenceId),
              ),
            )
            .limit(1);
          if (existingPurchase) {
            const [current] = await tx
              .select()
              .from(orgAiCredits)
              .where(eq(orgAiCredits.orgId, orgId));
            return current;
          }
        }

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

        const newBalance = currentBalance + creditsAddedMilli;
        const [updated] = await tx
          .update(orgAiCredits)
          .set({
            balance: newBalance,
            lifetimeGranted: sql`${orgAiCredits.lifetimeGranted} + ${creditsAddedMilli}`,
            updatedAt: new Date(),
          })
          .where(eq(orgAiCredits.orgId, orgId))
          .returning();

        await tx.insert(aiCreditTransactions).values({
          orgId,
          userId,
          type: "PURCHASE",
          amount: creditsAddedMilli,
          balanceAfter: newBalance,
          feature: "credit_purchase",
          referenceId,
          metadata: automatic ? { automatic: true } : null,
        });

        return updated;
      });

      return { balance: milliToCredits(wallet?.balance ?? 0), creditsAdded, pack };
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505") {
        const [currentWallet] = await this.db
          .select()
          .from(orgAiCredits)
          .where(eq(orgAiCredits.orgId, orgId));
        return { balance: milliToCredits(currentWallet?.balance ?? 0), creditsAdded, pack };
      }
      throw err;
    }
  }

  async listTransactions(orgId: string, page: number, limit: number) {
    return this.packs.listTransactions(orgId, page, limit);
  }

  async updateAutoTopUp(
    orgId: string,
    enabled: boolean,
    packId?: number,
    thresholdCredits?: number,
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
    const thresholdMilli = thresholdCredits !== undefined
      ? creditsToMilli(thresholdCredits)
      : wallet.autoTopUpThreshold ?? undefined;
    const [updated] = await this.db
      .update(orgAiCredits)
      .set({
        autoTopUpEnabled: enabled,
        autoTopUpPackId: packId ?? wallet.autoTopUpPackId,
        autoTopUpThreshold: thresholdMilli,
        updatedAt: new Date(),
      })
      .where(eq(orgAiCredits.orgId, orgId))
      .returning();
    return {
      ...updated,
      balance: milliToCredits(updated.balance),
      lifetimeGranted: milliToCredits(updated.lifetimeGranted),
      lifetimeConsumed: milliToCredits(updated.lifetimeConsumed),
      autoTopUpThreshold: updated.autoTopUpThreshold !== null
        ? milliToCredits(updated.autoTopUpThreshold)
        : null,
    };
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
    return this.packs.hasSameDayPurchaseForPack(orgId, packId);
  }

  async hasMonthlyPlanGrant(orgId: string): Promise<boolean> {
    return this.packs.hasMonthlyPlanGrant(orgId);
  }

  async grantAiPackCreditsFromWebhook(orgId: string, packId: number, paymentId: string): Promise<void> {
    const [pack] = await this.db
      .select()
      .from(aiCreditPacks)
      .where(and(eq(aiCreditPacks.id, packId), eq(aiCreditPacks.isActive, true)));

    if (!pack) return;

    const creditsAdded = pack.credits + pack.bonusCredits;
    const creditsAddedMilli = creditsToMilli(creditsAdded);

    try {
      await this.db.transaction(async (tx) => {
        const [wallet] = await tx
          .select()
          .from(orgAiCredits)
          .where(eq(orgAiCredits.orgId, orgId))
          .for("update");

        let currentBalance = 0;
        if (wallet) {
          currentBalance = wallet.balance;
        } else {
          await tx.insert(orgAiCredits).values({ orgId });
        }

        const newBalance = currentBalance + creditsAddedMilli;
        await tx
          .update(orgAiCredits)
          .set({
            balance: newBalance,
            lifetimeGranted: sql`${orgAiCredits.lifetimeGranted} + ${creditsAddedMilli}`,
            updatedAt: new Date(),
          })
          .where(eq(orgAiCredits.orgId, orgId));

        await tx.insert(aiCreditTransactions).values({
          orgId,
          userId: null,
          type: "PURCHASE",
          amount: creditsAddedMilli,
          balanceAfter: newBalance,
          feature: "credit_purchase",
          referenceId: paymentId,
          metadata: { source: "webhook" },
        });
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505") {
        return;
      }
      throw err;
    }
  }

  async reserve(input: AiCreditReserveInput): Promise<{ reservationId: number }> {
    return this.reservation.reserve(input);
  }

  async settle(
    reservationId: number,
    input: AiCreditSettleInput,
  ): Promise<void> {
    return this.reservation.settle(reservationId, input);
  }

  async release(reservationId: number, reason: string): Promise<void> {
    return this.reservation.release(reservationId, reason);
  }

  async sweepExpiredReservations(): Promise<number> {
    return this.reservation.sweepExpiredReservations();
  }

  async getMonthlyGrantedOrgIds(orgIds: string[]): Promise<Set<string>> {
    return this.packs.getMonthlyGrantedOrgIds(orgIds);
  }
}
