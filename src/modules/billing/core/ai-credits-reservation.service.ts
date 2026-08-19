import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  aiCreditReservations,
  aiCreditTransactions,
  orgAiCredits,
} from "../../../db/schema";
import { TRIAL_GRANT_MILLI } from "./ai-credit-units";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { AiCreditReserveInput, AiCreditSettleInput } from "../../ai/core/gateway/credit-ledger.interface";

@Injectable()
export class AiCreditsReservationService {
  private readonly logger = new Logger(AiCreditsReservationService.name);
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async reserve(input: AiCreditReserveInput): Promise<{ reservationId: number }> {
    const { orgId, userId, feature, credits, idempotencyKey } = input;

    if (idempotencyKey) {
      const existingId = await this.findByIdempotencyKey(orgId, idempotencyKey);
      if (existingId !== null) return { reservationId: existingId };
    }

    try {
      return await runInTenantTransaction(this.db, (outer) => outer.transaction(async (tx) => {
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
      }), { orgId });
    } catch (err: unknown) {
      if (isUniqueViolation(err) && idempotencyKey) {
        const existingId = await this.findByIdempotencyKey(orgId, idempotencyKey);
        if (existingId !== null) return { reservationId: existingId };
      }
      throw err;
    }
  }

  private async findByIdempotencyKey(orgId: string, idempotencyKey: string): Promise<number | null> {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const [existing] = await tx
          .select({ id: aiCreditReservations.id })
          .from(aiCreditReservations)
          .where(
            and(
              eq(aiCreditReservations.orgId, orgId),
              eq(aiCreditReservations.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        return existing?.id ?? null;
      },
      { orgId },
    );
  }

  async settle(
    reservationId: number,
    input: AiCreditSettleInput,
  ): Promise<void> {
    const orgId = input.orgId;

    await runInTenantTransaction(this.db, async (tx) => {
      const [reservation] = await tx
        .select()
        .from(aiCreditReservations)
        .where(
          and(eq(aiCreditReservations.id, reservationId), eq(aiCreditReservations.orgId, orgId)),
        )
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
    }, { orgId });
  }

  async release(reservationId: number, reason: string, orgId: string): Promise<void> {
    await runInTenantTransaction(this.db, async (tx) => {
      const [reservation] = await tx
        .select()
        .from(aiCreditReservations)
        .where(
          and(eq(aiCreditReservations.id, reservationId), eq(aiCreditReservations.orgId, orgId)),
        )
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
    }, { orgId });
  }

  async sweepExpiredReservations(): Promise<number> {
    const now = new Date();
    const expired = await this.db
      .select({ id: aiCreditReservations.id, orgId: aiCreditReservations.orgId })
      .from(aiCreditReservations)
      .where(
        and(
          eq(aiCreditReservations.status, "RESERVED"),
          lte(aiCreditReservations.expiresAt, now),
        ),
      )
      .limit(500);

    let swept = 0;
    for (const row of expired) {
      try {
        await this.release(row.id, "expired", row.orgId);
        swept++;
      } catch (err) {
        this.logger.warn(`Failed to sweep expired reservation ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return swept;
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code: unknown = Reflect.get(err, "code");
  return code === "23505";
}
