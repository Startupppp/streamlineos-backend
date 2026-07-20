import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, inArray, lt, lte, ne, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  aiCreditPacks,
  aiCreditReservations,
  aiCreditTransactions,
  orgAiCredits,
} from "../../db/schema";
import { DEFAULT_AI_CREDIT_PACKS } from "./ai-credit-packs.constants";
import { TRIAL_GRANT_MILLI, planGrantMilli, creditsToMilliUnits, milliUnitsToCredits } from "./ai-credit-units";

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
      amount: milliUnitsToCredits(t.amount),
      balanceAfter: milliUnitsToCredits(t.balanceAfter),
    }));

    return {
      wallet: {
        ...wallet,
        balance: milliUnitsToCredits(wallet!.balance),
        lifetimeGranted: milliUnitsToCredits(wallet!.lifetimeGranted),
        lifetimeConsumed: milliUnitsToCredits(wallet!.lifetimeConsumed),
        autoTopUpThreshold: wallet!.autoTopUpThreshold !== null
          ? milliUnitsToCredits(wallet!.autoTopUpThreshold)
          : null,
      },
      recentTransactions: mappedTransactions,
    };
  }

  async listPacks() {
    let packs = await this.db
      .select()
      .from(aiCreditPacks)
      .where(eq(aiCreditPacks.isActive, true))
      .orderBy(aiCreditPacks.sortOrder);

    if (packs.length === 0) {
      await this.ensureDefaultPacks();
      packs = await this.db
        .select()
        .from(aiCreditPacks)
        .where(eq(aiCreditPacks.isActive, true))
        .orderBy(aiCreditPacks.sortOrder);
    }

    return packs;
  }

  private async ensureDefaultPacks() {
    for (const pack of DEFAULT_AI_CREDIT_PACKS) {
      await this.db
        .insert(aiCreditPacks)
        .values({
          name: pack.name,
          credits: pack.credits,
          bonusCredits: pack.bonusCredits,
          priceInPaise: pack.priceInPaise,
          sortOrder: pack.sortOrder,
          isActive: true,
        })
        .onConflictDoNothing({ target: aiCreditPacks.name });
    }
  }

  async consumeCredits(
    orgId: string,
    userId: string,
    amount: number,
    feature: string,
    model?: string,
    referenceId?: string,
  ) {
    const amountMilli = creditsToMilliUnits(amount);
    return this.db.transaction(async (tx) => {
      const [wallet] = await tx
        .select()
        .from(orgAiCredits)
        .where(eq(orgAiCredits.orgId, orgId))
        .for("update");

      if (!wallet || wallet.balance < amountMilli) {
        throw new BadRequestException("Insufficient AI credits");
      }

      const newBalance = wallet.balance - amountMilli;
      await tx
        .update(orgAiCredits)
        .set({
          balance: newBalance,
          lifetimeConsumed: sql`${orgAiCredits.lifetimeConsumed} + ${amountMilli}`,
          updatedAt: new Date(),
        })
        .where(eq(orgAiCredits.orgId, orgId));

      await tx.insert(aiCreditTransactions).values({
        orgId,
        userId,
        type: "USAGE",
        amount: -amountMilli,
        balanceAfter: newBalance,
        feature,
        model,
        referenceId,
      });

      return { balance: milliUnitsToCredits(newBalance) };
    });
  }

  async refundCredits(
    orgId: string,
    userId: string,
    amount: number,
    feature: string,
    referenceId?: string,
  ) {
    const amountMilli = creditsToMilliUnits(amount);
    return this.db.transaction(async (tx) => {
      const [wallet] = await tx
        .select()
        .from(orgAiCredits)
        .where(eq(orgAiCredits.orgId, orgId))
        .for("update");

      const currentBalance = wallet?.balance ?? 0;
      const newBalance = currentBalance + amountMilli;

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
        amount: amountMilli,
        balanceAfter: newBalance,
        feature,
        referenceId,
      });

      return { balance: milliUnitsToCredits(newBalance) };
    });
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
    const creditsAddedMilli = creditsToMilliUnits(creditsAdded);
    const referenceId = paymentReferenceId ?? String(packId);

    try {
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

      return { balance: milliUnitsToCredits(wallet.balance), creditsAdded, pack };
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505") {
        const [wallet] = await this.db
          .select()
          .from(orgAiCredits)
          .where(eq(orgAiCredits.orgId, orgId));
        return { balance: milliUnitsToCredits(wallet?.balance ?? 0), creditsAdded, pack };
      }
      throw err;
    }
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
          promptTokens: aiCreditTransactions.promptTokens,
          completionTokens: aiCreditTransactions.completionTokens,
          totalTokens: aiCreditTransactions.totalTokens,
          costUsd: aiCreditTransactions.costUsd,
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
    const mappedItems = items.map((t) => ({
      ...t,
      amount: milliUnitsToCredits(t.amount),
      balanceAfter: milliUnitsToCredits(t.balanceAfter),
    }));
    return { items: mappedItems, total, page, totalPages: Math.ceil(total / limit) };
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
      ? creditsToMilliUnits(thresholdCredits)
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
      balance: milliUnitsToCredits(updated.balance),
      lifetimeGranted: milliUnitsToCredits(updated.lifetimeGranted),
      lifetimeConsumed: milliUnitsToCredits(updated.lifetimeConsumed),
      autoTopUpThreshold: updated.autoTopUpThreshold !== null
        ? milliUnitsToCredits(updated.autoTopUpThreshold)
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

  async grantAiPackCreditsFromWebhook(orgId: string, packId: number, paymentId: string): Promise<void> {
    const [pack] = await this.db
      .select()
      .from(aiCreditPacks)
      .where(and(eq(aiCreditPacks.id, packId), eq(aiCreditPacks.isActive, true)));

    if (!pack) return;

    const creditsAdded = pack.credits + pack.bonusCredits;
    const creditsAddedMilli = creditsToMilliUnits(creditsAdded);

    try {
      await this.db.transaction(async (tx) => {
        let [wallet] = await tx
          .select()
          .from(orgAiCredits)
          .where(eq(orgAiCredits.orgId, orgId))
          .for("update");

        let currentBalance = 0;
        if (wallet) {
          currentBalance = wallet.balance;
        } else {
          [wallet] = await tx.insert(orgAiCredits).values({ orgId }).returning();
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

  async reserve(input: {
    orgId: string;
    userId: string | null;
    feature: string;
    credits: number;
    idempotencyKey?: string;
  }): Promise<{ reservationId: number }> {
    const { orgId, userId, feature, credits, idempotencyKey } = input;

    if (idempotencyKey) {
      const [existing] = await this.db
        .select({ id: aiCreditReservations.id })
        .from(aiCreditReservations)
        .where(
          and(
            eq(aiCreditReservations.orgId, orgId),
            eq(aiCreditReservations.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) return { reservationId: existing.id };
    }

    try {
      return await this.db.transaction(async (tx) => {
        let [wallet] = await tx
          .select()
          .from(orgAiCredits)
          .where(eq(orgAiCredits.orgId, orgId))
          .for("update");

        if (!wallet) {
          [wallet] = await tx
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
        }

        if (wallet.balance < credits) {
          throw new BadRequestException("Insufficient AI credits");
        }

        const newBalance = wallet.balance - credits;
        await tx
          .update(orgAiCredits)
          .set({ balance: newBalance, updatedAt: new Date() })
          .where(eq(orgAiCredits.orgId, orgId));

        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        const [reservation] = await tx
          .insert(aiCreditReservations)
          .values({
            orgId,
            userId,
            feature,
            credits,
            status: "RESERVED",
            idempotencyKey: idempotencyKey ?? null,
            expiresAt,
          })
          .returning({ id: aiCreditReservations.id });

        return { reservationId: reservation.id };
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505" && idempotencyKey) {
        const [existing] = await this.db
          .select({ id: aiCreditReservations.id })
          .from(aiCreditReservations)
          .where(
            and(
              eq(aiCreditReservations.orgId, orgId),
              eq(aiCreditReservations.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing) return { reservationId: existing.id };
      }
      throw err;
    }
  }

  async settle(
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
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [reservation] = await tx
        .select()
        .from(aiCreditReservations)
        .where(eq(aiCreditReservations.id, reservationId))
        .for("update");

      if (!reservation) throw new NotFoundException("Reservation not found");
      if (reservation.status === "SETTLED") return;
      if (reservation.status !== "RESERVED") {
        throw new ConflictException(`Cannot settle a reservation in status ${reservation.status}`);
      }

      const actualMilli = Math.max(0, input.actualMilli ?? reservation.credits);
      const reservedMilli = reservation.credits;
      const delta = reservedMilli - actualMilli;

      const [wallet] = await tx
        .select()
        .from(orgAiCredits)
        .where(eq(orgAiCredits.orgId, reservation.orgId))
        .for("update");

      const currentBalance = wallet?.balance ?? 0;
      const newBalance = currentBalance + delta;

      await tx
        .update(orgAiCredits)
        .set({
          balance: newBalance,
          lifetimeConsumed: sql`${orgAiCredits.lifetimeConsumed} + ${actualMilli}`,
          updatedAt: new Date(),
        })
        .where(eq(orgAiCredits.orgId, reservation.orgId));

      if (actualMilli > 0) {
        const costUsdStr = input.costUsd !== undefined
          ? String(input.costUsd.toFixed(6))
          : null;
        await tx.insert(aiCreditTransactions).values({
          orgId: reservation.orgId,
          userId: reservation.userId,
          type: "USAGE",
          amount: -actualMilli,
          balanceAfter: newBalance,
          feature: reservation.feature,
          model: input.model ?? null,
          metadata: input.metadata ?? null,
          promptTokens: input.promptTokens ?? null,
          completionTokens: input.completionTokens ?? null,
          totalTokens: input.totalTokens ?? null,
          costUsd: costUsdStr,
        });
      }

      await tx
        .update(aiCreditReservations)
        .set({
          status: "SETTLED",
          model: input.model ?? null,
          metadata: input.metadata ?? null,
          updatedAt: new Date(),
        })
        .where(eq(aiCreditReservations.id, reservationId));
    });
  }

  async release(reservationId: number, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [reservation] = await tx
        .select()
        .from(aiCreditReservations)
        .where(eq(aiCreditReservations.id, reservationId))
        .for("update");

      if (!reservation) throw new NotFoundException("Reservation not found");
      if (reservation.status === "RELEASED") return;
      if (reservation.status === "SETTLED") {
        throw new ConflictException("Cannot release an already settled reservation");
      }

      const [wallet] = await tx
        .select()
        .from(orgAiCredits)
        .where(eq(orgAiCredits.orgId, reservation.orgId))
        .for("update");

      const currentBalance = wallet?.balance ?? 0;
      const newBalance = currentBalance + reservation.credits;

      await tx
        .update(orgAiCredits)
        .set({ balance: newBalance, updatedAt: new Date() })
        .where(eq(orgAiCredits.orgId, reservation.orgId));

      await tx
        .update(aiCreditReservations)
        .set({
          status: "RELEASED",
          metadata: { reason },
          updatedAt: new Date(),
        })
        .where(eq(aiCreditReservations.id, reservationId));
    });
  }

  async sweepExpiredReservations(): Promise<number> {
    const now = new Date();
    const expired = await this.db
      .select({ id: aiCreditReservations.id })
      .from(aiCreditReservations)
      .where(
        and(
          eq(aiCreditReservations.status, "RESERVED"),
          lte(aiCreditReservations.expiresAt, now),
        ),
      )
      .limit(500);

    let count = 0;
    for (const row of expired) {
      try {
        await this.release(row.id, "expired");
        count++;
      } catch {
        // already released/settled by concurrent path; skip
      }
    }
    return count;
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
