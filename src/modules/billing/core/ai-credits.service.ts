import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  aiCreditPacks,
  aiCreditTransactions,
  orgAiCredits,
} from "../../../db/schema";
import { creditsToMilli, milliToCredits } from "../../ai/core/billing/ai-model-pricing.constants";
import { planGrantMilli } from "./ai-credit-units";
import { AiCreditsReservationService } from "./ai-credits-reservation.service";
import { AiCreditsPacksService } from "./ai-credits-packs.service";
import type { AiCreditReserveInput, AiCreditSettleInput } from "../../ai/core/gateway/credit-ledger.interface";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { TenantTx } from "../../../db/drizzle.types";
import { isUniqueViolation, isUniqueViolationOn } from "../../../common/db/postgres-error";

type WalletExecutor = Db | TenantTx;

export interface GrantAiCreditsInput {
  orgId: string;
  userId: string | null;
  credits: number;
  feature: string;
  reason: string;
  idempotencyKey: string;
}

@Injectable()
export class AiCreditsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly reservation: AiCreditsReservationService,
    private readonly packs: AiCreditsPacksService,
  ) {}

  async getWallet(orgId: string) {
    const [existing] = await this.db
      .select()
      .from(orgAiCredits)
      .where(eq(orgAiCredits.orgId, orgId));
    const wallet = existing ?? (await this.reservation.ensureWalletForOrg(orgId));
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

  /**
   * Credits the wallet in one statement, creating it if this is the tenant's
   * first grant.
   *
   * `SELECT … FOR UPDATE` locks nothing when the row does not exist, so on an
   * organisation's very first purchase two payments both saw no wallet, both
   * inserted, and the loser died `23505`. The catch below swallowed it and
   * returned the current balance: the customer paid and got no credits, and no
   * ledger row recorded the purchase. An upsert has no such window, and the
   * balance moves in SQL rather than as a read-modify-write, so a concurrent
   * grant cannot be erased either.
   *
   * The returned balance is the one the database committed — the ledger's
   * `balanceAfter` is taken from it rather than recomputed, so the two cannot
   * disagree.
   */
  private async creditWallet(
    tx: WalletExecutor,
    orgId: string,
    amountMilli: number,
  ): Promise<number> {
    const [wallet] = await tx
      .insert(orgAiCredits)
      .values({ orgId, balance: amountMilli, lifetimeGranted: amountMilli })
      .onConflictDoUpdate({
        target: orgAiCredits.orgId,
        set: {
          balance: sql`${orgAiCredits.balance} + ${amountMilli}`,
          lifetimeGranted: sql`${orgAiCredits.lifetimeGranted} + ${amountMilli}`,
          updatedAt: new Date(),
        },
      })
      .returning({ balance: orgAiCredits.balance });
    if (!wallet) throw new Error("AI credit wallet upsert returned no rows");
    return wallet.balance;
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

        const newBalance = await this.creditWallet(tx, orgId, amountMilli);

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
      /**
       * `uq_ai_credit_txns_plan_grant_ref` — (org_id, reference_id) WHERE
       * type = 'PLAN_GRANT' AND reference_id IS NOT NULL — is what actually
       * makes a plan grant idempotent. The `if (referenceId)` pre-check above
       * only runs when the caller supplied one; the insert writes
       * `referenceId ?? plan` either way, so a caller passing no reference
       * (billing.service does exactly that) reaches the index with the plan
       * name as its key and a repeat grant lands here, not on the pre-check.
       * A grant already recorded is not an error — return, do not re-credit.
       * `isUniqueViolation` reads the SQLSTATE off `.cause`, where Drizzle leaves it.
       */
      if (isUniqueViolation(err)) {
        return;
      }
      throw err;
    }
  }

  async grantCredits(input: GrantAiCreditsInput): Promise<{ balance: number }> {
    const amountMilli = creditsToMilli(input.credits);
    if (amountMilli <= 0) throw new ConflictException("AI credit grant must be positive");
    if (!input.idempotencyKey.trim()) throw new ConflictException("AI credit grant requires an idempotency key");

    try {
      const balanceMilli = await runInTenantTransaction(
        this.db,
        (outer) => outer.transaction(async (tx) => {
          const newBalance = await this.creditWallet(tx, input.orgId, amountMilli);
          await tx.insert(aiCreditTransactions).values({
            orgId: input.orgId,
            userId: input.userId,
            type: "REFUND",
            amount: amountMilli,
            balanceAfter: newBalance,
            feature: input.feature,
            referenceId: input.idempotencyKey.trim(),
            metadata: { reason: input.reason, source: "credit-ledger-adjustment" },
          });
          return newBalance;
        }),
        { orgId: input.orgId },
      );
      return { balance: milliToCredits(balanceMilli) };
    } catch (error: unknown) {
      if (!isUniqueViolationOn(error, "uq_ai_credit_txns_refund_ref")) throw error;
      const result = await runInTenantTransaction(
        this.db,
        async (tx) => {
          const [wallet] = await tx
            .select({ balance: orgAiCredits.balance })
            .from(orgAiCredits)
            .where(eq(orgAiCredits.orgId, input.orgId))
            .limit(1);
          if (!wallet) throw new ConflictException("AI credit wallet is missing after replayed grant");
          return wallet.balance;
        },
        { orgId: input.orgId },
      );
      return { balance: milliToCredits(result) };
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
              .select({ balance: orgAiCredits.balance })
              .from(orgAiCredits)
              .where(eq(orgAiCredits.orgId, orgId));
            return current?.balance ?? 0;
          }
        }

        const newBalance = await this.creditWallet(tx, orgId, creditsAddedMilli);

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

        return newBalance;
      });

      return { balance: milliToCredits(wallet ?? 0), creditsAdded, pack };
    } catch (err: unknown) {
      /**
       * `uq_ai_credit_txns_purchase_ref` — (org_id, reference_id) WHERE
       * type = 'PURCHASE' AND reference_id IS NOT NULL. The pre-check above
       * runs only for `automatic`, so a manual purchase reaches the index and
       * a repeat of the same payment reference is a replay: report the wallet
       * as it stands rather than crediting a second time.
       *
       * NOT FIXED HERE, and worth knowing: when no `paymentReferenceId` is
       * given the reference falls back to `String(packId)`, so a manual repeat
       * purchase of the same pack is treated as a replay of the first rather
       * than a second purchase. That is a product decision in the fallback key,
       * not in this handler — before this change the same call produced a 500.
       */
      if (isUniqueViolation(err)) {
        const [currentWallet] = await this.db
          .select()
          .from(orgAiCredits)
          .where(eq(orgAiCredits.orgId, orgId));
        return { balance: milliToCredits(currentWallet?.balance ?? 0), creditsAdded, pack };
      }
      throw err;
    }
  }

  async purchaseCreditsInTenantTransaction(
    orgId: string,
    userId: string | null,
    packId: number,
    paymentReferenceId?: string,
  ) {
    return runInTenantTransaction(
      this.db,
      () => this.purchaseCreditsDirectly(orgId, userId, packId, false, paymentReferenceId),
      { orgId },
    );
  }

  async listTransactions(orgId: string, query: { cursor?: string; limit: number }) {
    return this.packs.listTransactions(orgId, query);
  }

  async updateAutoTopUp(
    orgId: string,
    enabled: boolean,
    packId?: number,
    thresholdCredits?: number,
  ) {
    const [existing] = await this.db
      .select()
      .from(orgAiCredits)
      .where(eq(orgAiCredits.orgId, orgId));
    const wallet = existing ?? (await this.reservation.ensureWalletForOrg(orgId));
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
      await runInTenantTransaction(
        this.db,
        async (tx) =>
          /**
           * A savepoint, and it is load-bearing rather than tidy.
           *
           * `runInTenantTransaction` reuses an ambient transaction when there
           * is one — a webhook arriving over HTTP always has the request's —
           * so a unique violation raised directly against `tx` aborts THAT
           * transaction. Swallowing it below would then return normally onto a
           * dead handle: every later statement dies 25P02 and the commit rolls
           * back work the caller believes succeeded. Rolling back to a
           * savepoint instead confines the failed insert to itself, which is
           * what makes "already credited, do nothing" actually mean it.
           *
           * Measured: without this, the redelivery case in
           * `test/conflict-translation/billing-conflicts.seeded-e2e-spec.ts`
           * still rejects with the PostgresError even though the handler below
           * swallowed it.
           */
          tx.transaction(async (write) => {
            const newBalance = await this.creditWallet(write, orgId, creditsAddedMilli);

            await write.insert(aiCreditTransactions).values({
              orgId,
              userId: null,
              type: "PURCHASE",
              amount: creditsAddedMilli,
              balanceAfter: newBalance,
              feature: "credit_purchase",
              referenceId: paymentId,
              metadata: { source: "webhook" },
            });
          }),
        { orgId },
      );
    } catch (err: unknown) {
      // Same PURCHASE reference index. A webhook redelivering the same payment
      // id must be a no-op, not a 500 the provider will retry forever.
      if (isUniqueViolation(err)) {
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

  async release(reservationId: number, reason: string, orgId: string): Promise<void> {
    return this.reservation.release(reservationId, reason, orgId);
  }

  async sweepExpiredReservations(): Promise<number> {
    return this.reservation.sweepExpiredReservations();
  }

  async getMonthlyGrantedOrgIds(orgIds: string[]): Promise<Set<string>> {
    return this.packs.getMonthlyGrantedOrgIds(orgIds);
  }
}
